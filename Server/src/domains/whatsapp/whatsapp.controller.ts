import type { Request, Response } from "express";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { supabaseAdmin } from "../../config/supabase.js";
import { UnauthorizedError } from "../../lib/errors.js";
import { handleIncomingMessage } from "../ai/ai.orchestrator.js";
import { handleIntake } from "../ai/intake.orchestrator.js";
import * as whatsappService from "./whatsapp.service.js";
import {
  incomingMessageSchema,
  webhookPayloadSchema,
  extractPayload,
} from "./whatsapp.validator.js";

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
      throw new UnauthorizedError("Invalid webhook token");
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

    // Handle manual messages sent from WhatsApp phone — set cooldown
    if (rawPayload.typeWebhook === "outgoingMessageReceived") {
      const outboundResult = incomingMessageSchema.safeParse(req.body);
      if (!outboundResult.success) {
        res.status(200).json({ ok: true });
        return;
      }
      const outChatId = outboundResult.data.senderData.chatId;
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
    const chatId = inbound.senderData.chatId;

    if (chatId.endsWith("@g.us")) {
      logger.debug({ chatId }, "Group chat message — ignoring");
      res.sendStatus(200);
      return;
    }

    const senderName = inbound.senderData.senderName ?? null;
    const idMessage = inbound.idMessage;

    // Extract normalised payload (text | image | document)
    const payload = extractPayload(inbound);

    // Derive the body to store in messages table
    const messageBody =
      payload.kind === "text"
        ? payload.text
        : payload.kind === "image"
          ? payload.caption ?? "[image]"
          : payload.caption ?? "[document]";

    // Derive phone from chatId (format: "1234567890@c.us" or "group@g.us")
    const contactPhone = chatId.split("@")[0] ?? chatId;

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

    // 3d. Atomic dedup — unique index on whatsapp_message_id rejects races
    const { data: inserted, error: msgErr } = await supabaseAdmin
      .from("messages")
      .upsert(
        {
          conversation_id: conversationId,
          direction: "inbound" as const,
          sent_by: "customer",
          body: messageBody,
          whatsapp_message_id: idMessage,
          status: "received",
        },
        { onConflict: "whatsapp_message_id", ignoreDuplicates: true },
      )
      .select("id")
      .maybeSingle();

    if (msgErr) {
      logger.error({ conversationId, msgErr }, "Failed to insert inbound message");
    }

    if (!inserted) {
      logger.debug({ idMessage }, "Duplicate webhook — skipping");
      res.sendStatus(200);
      return;
    }

    // 3e. Run intake orchestrator if client is linked
    if (linkedClientId) {
      try {
        const { consumed } = await handleIntake(
          conversationId,
          linkedClientId,
          chatId,
          payload,
        );

        if (consumed) {
          res.status(200).json({ ok: true });
          return;
        }
      } catch (intakeErr) {
        logger.error(
          { conversationId, intakeErr },
          "Intake orchestrator unhandled error — falling through to AI",
        );
      }
    }

    // 3f. Fire-and-forget AI orchestration (only if intake did not consume)
    const textForAi = payload.kind === "text" ? payload.text : "";
    setImmediate(() => {
      handleIncomingMessage(conversationId, textForAi).catch((err: unknown) => {
        logger.error({ conversationId, err }, "AI orchestrator unhandled error");
      });
    });

    res.status(200).json({ ok: true });
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
