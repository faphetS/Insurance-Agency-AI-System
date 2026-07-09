import type { Request, Response } from "express";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { supabaseAdmin } from "../../config/supabase.js";
import { handleIntake } from "../ai/intake.orchestrator.js";
import { assignStaffToMeeting } from "../meetings/meeting-handoff.service.js";
import { handleOpInstanceEvent } from "../operations/unanswered-wa.service.js";
import * as whatsappService from "./whatsapp.service.js";
import {
  incomingMessageSchema,
  outgoingMessageSchema,
  webhookPayloadSchema,
  extractPayload,
} from "./whatsapp.validator.js";
import { isStaffChat, extractButtonId, toChatId } from "./whatsapp.util.js";

export const whatsappController = {
  /**
   * POST /api/whatsapp/webhook
   * Unauthenticated — token-guarded via Authorization header or ?token= query param.
   * GreenAPI pushes events here; we must always respond 200 quickly.
   */
  async handleWebhook(req: Request, res: Response): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawBody = req.body as Record<string, any>;

    // 1. Verify token FIRST — accept either Authorization: Bearer <token> (GreenAPI style)
    //    or a ?token=<token> query param. Applies to every instance hitting this webhook,
    //    including the operational (GREENAPI_OP_*) line.
    const authHeader = req.headers.authorization;
    const tokenParam = typeof req.query["token"] === "string" ? req.query["token"] : null;
    const headerOk = authHeader === `Bearer ${env.GREENAPI_WEBHOOK_TOKEN}`;
    const queryOk = tokenParam === env.GREENAPI_WEBHOOK_TOKEN;

    if (!headerOk && !queryOk) {
      logger.warn(
        { authHeader, hasQueryToken: tokenParam !== null },
        "Webhook token mismatch — returning 200 to prevent retry storms",
      );
      res.status(200).json({ ok: true });
      return;
    }

    // Operational-instance short-circuit: any TOKEN-VERIFIED webhook from the op line
    // (GREENAPI_OP_*) is acknowledged and handed to the unanswered-WA handler; it never
    // enters the conversational pipeline below. (SIM/cellular missed calls are captured
    // via the separate Zadarma webhook.)
    const opIdInstance = rawBody.instanceData?.idInstance;
    if (opIdInstance !== undefined && env.GREENAPI_OP_ID_INSTANCE && String(opIdInstance) === env.GREENAPI_OP_ID_INSTANCE) {
      res.status(200).json({ ok: true });
      setImmediate(() =>
        handleOpInstanceEvent(rawBody).catch((err: unknown) =>
          logger.error({ err }, "handleOpInstanceEvent failed"),
        ),
      );
      return;
    }

    // Parse the payload — on failure still return 200
    const looseResult = webhookPayloadSchema.safeParse(rawBody);
    if (!looseResult.success) {
      logger.warn(
        { body: rawBody, errors: looseResult.error.errors },
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
      const outboundResult = outgoingMessageSchema.safeParse(rawBody);
      if (!outboundResult.success) {
        res.status(200).json({ ok: true });
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const outChatId = outboundResult.data.senderData?.chatId ?? (rawBody as Record<string, any>)?.senderData?.chatId;
      if (!outChatId) {
        res.status(200).json({ ok: true });
        return;
      }

      // Owner self-chat: when SUMMARY_RECIPIENT_PHONE is the bot's own WhatsApp line,
      // a staff-picker button tapped in "Note-to-Self" arrives as an OUTGOING message
      // (the bot's number sending to itself). Treat it as the owner's assignment action.
      // In production the owner is a separate phone, so its taps arrive as incoming and
      // this branch is simply never taken.
      const ownerChatIdOut = toChatId(env.SUMMARY_RECIPIENT_PHONE ?? null);
      if (ownerChatIdOut && outChatId === ownerChatIdOut) {
        const assignMatch = /^assign_staff:([^:]+):([^:]+)$/.exec(extractButtonId(rawBody));
        if (assignMatch) {
          res.status(200).json({ ok: true });
          setImmediate(() =>
            assignStaffToMeeting(assignMatch[1]!, assignMatch[2]!, outChatId).catch((err: unknown) =>
              logger.error({ err, chatId: outChatId }, "assignStaffToMeeting (self-chat outgoing) failed"),
            ),
          );
          return;
        }
      }

      // Check if this outgoing message was sent by our bot — don't self-pause
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const idMessage = outboundResult.data.idMessage ?? (rawBody as Record<string, any>)?.idMessage;
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

    // Only act on inbound messages
    if (rawPayload.typeWebhook !== "incomingMessageReceived") {
      res.status(200).json({ ok: true });
      return;
    }

    // Narrow to the full inbound schema
    const inboundResult = incomingMessageSchema.safeParse(rawBody);
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
    logger.info({ messageData: rawBody.messageData }, "Incoming messageData (raw)");

    const chatId = inbound.senderData.chatId;

    if (chatId.endsWith("@g.us")) {
      logger.debug({ chatId }, "Group chat message — ignoring");
      res.sendStatus(200);
      return;
    }

    const senderName = inbound.senderData.senderName ?? null;
    const idMessage = inbound.idMessage;

    // Extract normalised payload (text | image | document)
    const payload = extractPayload(inbound, rawBody);

    // Derive the body to store in messages table
    const messageBody =
      payload.kind === "text"
        ? payload.text
        : payload.kind === "image"
          ? payload.caption ?? "[image]"
          : payload.caption ?? "[document]";

    // Derive phone from chatId (format: "1234567890@c.us" or "group@g.us")
    const contactPhone = chatId.split("@")[0] ?? chatId;

    // The owner number is OPERATIONAL-ONLY: it must never enter the lead/intake
    // conversational flow. Handle its operational buttons (staff assignment) and
    // silently ignore anything else.
    const ownerChatId = toChatId(env.SUMMARY_RECIPIENT_PHONE ?? null);
    if (ownerChatId && chatId === ownerChatId) {
      res.status(200).json({ ok: true });
      const assignMatch = /^assign_staff:([^:]+):([^:]+)$/.exec(extractButtonId(rawBody));
      if (assignMatch) {
        setImmediate(() =>
          assignStaffToMeeting(assignMatch[1]!, assignMatch[2]!, chatId).catch((err: unknown) =>
            logger.error({ err, chatId }, "assignStaffToMeeting failed"),
          ),
        );
      } else {
        logger.info({ chatId }, "owner message ignored — operational-only number (no lead/intake)");
      }
      return;
    }

    // Staff intercept — if this chat belongs to a staff member, log and skip.
    const staff = await isStaffChat(chatId);
    if (staff) {
      res.status(200).json({ ok: true });
      return;
    }

    // Upsert conversation by whatsapp_chat_id
    const conversationUpsertData: Record<string, unknown> = {
      whatsapp_chat_id: chatId,
      contact_name: senderName,
      contact_phone: contactPhone,
      last_message_at: new Date().toISOString(),
    };

    const { data: conversation, error: convErr } = await supabaseAdmin
      .from("conversations")
      .upsert(conversationUpsertData, { onConflict: "whatsapp_chat_id", ignoreDuplicates: false })
      .select("id")
      .single();

    if (convErr || !conversation) {
      logger.error({ chatId, convErr }, "Failed to upsert conversation");
      res.status(200).json({ ok: true });
      return;
    }

    const conversationId = conversation.id;

    // Insert inbound message — unique index rejects duplicate whatsapp_message_id
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

    // Reply allowlist gate: when set, non-allowlisted senders are stored but get no reply.
    if (env.REPLY_ALLOWLIST.length > 0) {
      const senderDigits = contactPhone.replace(/\D/g, "");
      const allowed = env.REPLY_ALLOWLIST.some(
        (entry) => entry.replace(/\D/g, "") === senderDigits,
      );
      if (!allowed) {
        logger.info({ conversationId, chatId }, "sender not in reply allowlist — skipping conversational bot");
        res.status(200).json({ ok: true });
        return;
      }
    }

    // Link client if conversation has no client_id yet
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

    // Respond 200 immediately — intake/AI processing runs async to avoid
    // Render's 30s request timeout (LLM classification can take 15s+).
    res.status(200).json({ ok: true });

    setImmediate(async () => {
      try {
        if (linkedClientId) {
          await handleIntake(
            conversationId,
            linkedClientId,
            chatId,
            payload,
          );
        }
      } catch (err) {
        logger.error({ conversationId, err }, "Async message processing error");
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
