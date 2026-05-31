import type { Request, Response } from "express";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { supabaseAdmin } from "../../config/supabase.js";
import { handleIncomingMessage } from "../ai/ai.orchestrator.js";
import { handleIntake } from "../ai/intake.orchestrator.js";
import { finalizeSummary, handleClientConfirm } from "../operations/operations.service.js";
import * as whatsappService from "./whatsapp.service.js";
import {
  incomingMessageSchema,
  outgoingMessageSchema,
  webhookPayloadSchema,
  extractPayload,
} from "./whatsapp.validator.js";
import { isStaffChat, extractButtonId } from "./whatsapp.util.js";
import { wantsHuman, handleHumanEscalation } from "./whatsapp.escalation.js";

export const whatsappController = {
  /**
   * POST /api/whatsapp/webhook
   * Unauthenticated — token-guarded via Authorization header.
   * GreenAPI pushes events here; we must always respond 200 quickly.
   */
  async handleWebhook(req: Request, res: Response): Promise<void> {
    // 1. Verify token
    const authHeader = req.headers.authorization;
    const expectedToken = `Bearer ${env.GREENAPI_WEBHOOK_TOKEN}`;
    if (authHeader !== expectedToken) {
      logger.warn({ authHeader }, "Webhook token mismatch — returning 200 to prevent retry storms");
      res.status(200).json({ ok: true });
      return;
    }

    // 2. Parse payload — on validation failure, still return 200 to stop retries
    const looseResult = webhookPayloadSchema.safeParse(req.body);
    if (!looseResult.success) {
      logger.warn(
        { body: req.body, errors: looseResult.error.errors },
        "Webhook parse failed — ignoring",
      );
      res.status(200).json({ ok: true });
      return;
    }

    const rawPayload = looseResult.data;

    // API-sent messages (bot outbound) — never pause
    if (rawPayload.typeWebhook === "outgoingAPIMessageReceived") {
      res.status(200).json({ ok: true });
      return;
    }

    // Handle manual messages sent from WhatsApp phone — set cooldown
    if (rawPayload.typeWebhook === "outgoingMessageReceived") {
      const outboundResult = outgoingMessageSchema.safeParse(req.body);
      if (!outboundResult.success) {
        res.status(200).json({ ok: true });
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const outChatId = outboundResult.data.senderData?.chatId ?? (req.body as Record<string, any>)?.senderData?.chatId;
      if (!outChatId) {
        res.status(200).json({ ok: true });
        return;
      }

      // Check if this outgoing message was sent by our bot — don't self-pause
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const idMessage = outboundResult.data.idMessage ?? (req.body as Record<string, any>)?.idMessage;
      if (idMessage) {
        const { data: existing } = await supabaseAdmin
          .from("messages")
          .select("id")
          .eq("whatsapp_message_id", idMessage)
          .eq("sent_by", "bot")
          .maybeSingle();
        if (existing) {
          logger.debug({ chatId: outChatId, idMessage }, "Outgoing message is bot-sent — skipping pause");
          res.status(200).json({ ok: true });
          return;
        }
      }

      if (!outChatId.endsWith("@g.us")) {
        const pausedUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        await supabaseAdmin
          .from("conversations")
          .update({ bot_paused: true, bot_paused_until: pausedUntil })
          .eq("whatsapp_chat_id", outChatId);
        logger.info({ chatId: outChatId, pausedUntil }, "Manual WhatsApp send — bot paused for 1 hour");
      }
      res.status(200).json({ ok: true });
      return;
    }

    // 3. Only act on inbound messages
    if (rawPayload.typeWebhook !== "incomingMessageReceived") {
      res.status(200).json({ ok: true });
      return;
    }

    // Narrow to the full inbound schema
    const inboundResult = incomingMessageSchema.safeParse(req.body);
    if (!inboundResult.success) {
      logger.warn(
        { errors: inboundResult.error.errors },
        "incomingMessageReceived payload malformed — ignoring",
      );
      res.status(200).json({ ok: true });
      return;
    }

    const inbound = inboundResult.data;

    // Log raw messageData to diagnose button response structure
    logger.info({ messageData: req.body.messageData }, "Incoming messageData (raw)");

    const chatId = inbound.senderData.chatId;

    if (chatId.endsWith("@g.us")) {
      logger.debug({ chatId }, "Group chat message — ignoring");
      res.sendStatus(200);
      return;
    }

    const senderName = inbound.senderData.senderName ?? null;
    const idMessage = inbound.idMessage;

    // Extract normalised payload (text | image | document)
    const payload = extractPayload(inbound, req.body as Record<string, unknown>);

    // Derive the body to store in messages table
    const messageBody =
      payload.kind === "text"
        ? payload.text
        : payload.kind === "image"
          ? payload.caption ?? "[image]"
          : payload.caption ?? "[document]";

    // Derive phone from chatId (format: "1234567890@c.us" or "group@g.us")
    const contactPhone = chatId.split("@")[0] ?? chatId;

    // Staff intercept — if this chat belongs to a staff member, handle separately
    const staff = await isStaffChat(chatId);
    if (staff) {
      res.status(200).json({ ok: true });

      setImmediate(async () => {
        try {
          const buttonId = extractButtonId(req.body);

          const approveMatch = /^sum_approve:(.+)$/.exec(buttonId);
          const editMatch = /^sum_edit:(.+)$/.exec(buttonId);

          if (approveMatch) {
            const meetingId = approveMatch[1]!;
            await finalizeSummary(meetingId);
            await whatsappService.sendMessageWithTyping(chatId, "✅ הסיכום אושר.");
          } else if (editMatch) {
            const meetingId = editMatch[1]!;
            // Clear any prior edit session for this chat
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (supabaseAdmin as any)
              .from("meetings")
              .update({ summary_edit_chat_id: null })
              .eq("summary_edit_chat_id", chatId);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (supabaseAdmin as any)
              .from("meetings")
              .update({ summary_edit_chat_id: chatId })
              .eq("id", meetingId);
            await whatsappService.sendMessageWithTyping(
              chatId,
              "אוקיי, אנא שלח/י את נוסח הסיכום המעודכן.",
            );
          } else {
            // Plain text — find an open edit session for this chat
            const inboundText =
              payload.kind === "text" ? payload.text : "";
            if (inboundText) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const { data: editMeeting } = await (supabaseAdmin as any)
                .from("meetings")
                .select("id")
                .eq("summary_edit_chat_id", chatId)
                .eq("summary_status", "draft")
                .order("updated_at", { ascending: false })
                .limit(1)
                .maybeSingle();

              if (editMeeting) {
                await finalizeSummary(editMeeting.id as string, inboundText);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                await (supabaseAdmin as any)
                  .from("meetings")
                  .update({ summary_edit_chat_id: null })
                  .eq("id", editMeeting.id);
                await whatsappService.sendMessageWithTyping(chatId, "✅ הסיכום עודכן ואושר.");
              }
            }
          }
        } catch (err) {
          logger.error({ err, chatId }, "Staff WhatsApp handler error");
        }
      });

      return;
    }

    // 3a. Upsert conversation by whatsapp_chat_id
    const { data: conversation, error: convErr } = await supabaseAdmin
      .from("conversations")
      .upsert(
        {
          whatsapp_chat_id: chatId,
          contact_name: senderName,
          contact_phone: contactPhone,
          last_message_at: new Date().toISOString(),
        },
        { onConflict: "whatsapp_chat_id", ignoreDuplicates: false },
      )
      .select("id")
      .single();

    if (convErr || !conversation) {
      logger.error({ chatId, convErr }, "Failed to upsert conversation");
      res.status(200).json({ ok: true });
      return;
    }

    const conversationId = conversation.id;

    // 3b. Link client if conversation has no client_id yet
    let linkedClientId: string | null = null;

    try {
      const { data: convRow } = await supabaseAdmin
        .from("conversations")
        .select("client_id")
        .eq("id", conversationId)
        .single();

      if (convRow && convRow.client_id === null) {
        // Look for an existing client keyed by phone
        const { data: existingClient } = await supabaseAdmin
          .from("clients")
          .select("id")
          .eq("phone", contactPhone)
          .maybeSingle();

        let clientId: string | null = existingClient?.id ?? null;

        if (!clientId) {
          // Need a valid assigned_to staff id — grab any active staff member as fallback
          const { data: staffRow } = await supabaseAdmin
            .from("staff")
            .select("id")
            .eq("is_active", true)
            .limit(1)
            .maybeSingle();

          if (staffRow) {
            const { data: newClient, error: clientErr } = await supabaseAdmin
              .from("clients")
              .insert({
                full_name: senderName ?? contactPhone,
                phone: contactPhone,
                status: "new",
                pipeline_stage: "new_lead",
                source_channel: "wa",
                inquiry_type: "general",
                id_validated: false,
                assigned_to: staffRow.id,
              })
              .select("id")
              .single();

            if (clientErr) {
              logger.warn(
                { contactPhone, clientErr },
                "Failed to insert new client from webhook — skipping link",
              );
            } else {
              clientId = newClient?.id ?? null;
              logger.info(
                { contactPhone, clientId },
                "Created new client from inbound WhatsApp",
              );
            }
          } else {
            logger.warn(
              { contactPhone },
              "No active staff found — cannot assign new client, skipping link",
            );
          }
        }

        if (clientId) {
          const { error: linkErr } = await supabaseAdmin
            .from("conversations")
            .update({ client_id: clientId })
            .eq("id", conversationId);

          if (linkErr) {
            logger.warn(
              { conversationId, clientId, linkErr },
              "Failed to link client_id to conversation",
            );
          } else {
            logger.info(
              { conversationId, clientId },
              "Linked conversation to client",
            );
            linkedClientId = clientId;
          }
        }
      } else if (convRow?.client_id) {
        linkedClientId = convRow.client_id;
      }
    } catch (clientLinkErr) {
      logger.error(
        { conversationId, clientLinkErr },
        "Unexpected error during client link — continuing",
      );
    }

    // 3d. Insert inbound message — unique index rejects duplicate whatsapp_message_id
    const { data: inserted, error: msgErr } = await supabaseAdmin
      .from("messages")
      .insert({
        conversation_id: conversationId,
        direction: "inbound",
        sent_by: "customer",
        body: messageBody,
        whatsapp_message_id: idMessage,
        status: "received",
      })
      .select("id")
      .maybeSingle();

    if (msgErr) {
      if (msgErr.code === "23505") {
        logger.debug({ idMessage }, "Duplicate webhook — skipping");
        res.sendStatus(200);
        return;
      }
      logger.error({ conversationId, msgErr }, "Failed to insert inbound message");
    }

    if (!inserted) {
      res.sendStatus(200);
      return;
    }

    // 3e. Respond 200 immediately — intake/AI processing runs async to avoid
    // Render's 30s request timeout (LLM classification can take 15s+).
    res.status(200).json({ ok: true });

    const textForAi = payload.kind === "text" ? payload.text : "";

    setImmediate(async () => {
      try {
        if (textForAi && wantsHuman(textForAi)) {
          await handleHumanEscalation(conversationId, chatId);
          return;
        }

        const confirmMatch = /^client_confirm:(.+)$/.exec(extractButtonId(req.body));
        if (confirmMatch) {
          await handleClientConfirm(confirmMatch[1]!, chatId, conversationId);
          return;
        }

        if (linkedClientId) {
          const { consumed } = await handleIntake(
            conversationId,
            linkedClientId,
            chatId,
            payload,
          );
          if (consumed) return;
        }
        await handleIncomingMessage(conversationId, textForAi);
      } catch (err) {
        logger.error({ conversationId, err }, "Async message processing error");
        try {
          await whatsappService.sendMessageWithTyping(
            chatId,
            "מצטערים, יש כעת קושי בעיבוד ההודעה. נציג ייצור קשר בהקדם.",
          );
        } catch (sendErr) {
          logger.error({ conversationId, sendErr }, "Failed to send error fallback message");
        }
      }
    });
  },

  /**
   * PATCH /api/whatsapp/conversations/:id/bot-pause — admin only
   */
  async setBotPause(req: Request, res: Response): Promise<void> {
    const { id } = req.params as { id: string };
    const { paused } = req.body as { paused: boolean };

    const update =
      paused
        ? { bot_paused: true }
        : { bot_paused: false, bot_paused_until: null };

    const { error } = await supabaseAdmin
      .from("conversations")
      .update(update)
      .eq("id", id);

    if (error) {
      logger.error({ conversationId: id, error }, "Failed to update bot_paused");
      throw new Error("Failed to update conversation");
    }

    res.json({ ok: true });
  },

  /**
   * GET /api/whatsapp/state — admin only
   */
  async getState(_req: Request, res: Response): Promise<void> {
    const state = await whatsappService.getState();
    res.json({ status: "success", data: state });
  },

  /**
   * GET /api/whatsapp/qr — admin only
   */
  async getQrCode(_req: Request, res: Response): Promise<void> {
    const qr = await whatsappService.getQrCode();
    res.json({ status: "success", data: qr });
  },

  /**
   * POST /api/whatsapp/send — admin only, manual outbound message
   */
  async sendManual(req: Request, res: Response): Promise<void> {
    const { chatId, message } = req.body as { chatId: string; message: string };

    // Upsert conversation so we always have a record
    const { data: conversation, error: convErr } = await supabaseAdmin
      .from("conversations")
      .upsert(
        {
          whatsapp_chat_id: chatId,
          contact_phone: chatId.split("@")[0] ?? chatId,
          last_message_at: new Date().toISOString(),
        },
        { onConflict: "whatsapp_chat_id", ignoreDuplicates: false },
      )
      .select("id")
      .single();

    if (convErr || !conversation) {
      logger.error(
        { chatId, convErr },
        "Failed to upsert conversation for manual send",
      );
      throw new Error("Failed to resolve conversation");
    }

    const { idMessage } = await whatsappService.sendMessage(chatId, message);

    await supabaseAdmin.from("messages").insert({
      conversation_id: conversation.id,
      direction: "outbound",
      sent_by: "human",
      body: message,
      whatsapp_message_id: idMessage,
      status: "sent",
    });

    // Set 1-hour cooldown
    const pausedUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await supabaseAdmin
      .from("conversations")
      .update({ bot_paused: true, bot_paused_until: pausedUntil })
      .eq("id", conversation.id);

    res.json({ status: "success", data: { idMessage } });
  },
};
