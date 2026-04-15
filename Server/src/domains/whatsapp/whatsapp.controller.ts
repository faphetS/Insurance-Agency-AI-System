import type { Request, Response } from "express";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { supabaseAdmin } from "../../config/supabase.js";
import { UnauthorizedError } from "../../lib/errors.js";
import { handleIncomingMessage } from "../ai/ai.orchestrator.js";
import * as whatsappService from "./whatsapp.service.js";
import { incomingMessageSchema, webhookPayloadSchema } from "./whatsapp.validator.js";

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
      logger.warn({ body: req.body, errors: looseResult.error.errors }, "Webhook parse failed — ignoring");
      res.status(200).json({ ok: true });
      return;
    }

    const payload = looseResult.data;

    // 3. Only act on inbound messages
    if (payload.typeWebhook !== "incomingMessageReceived") {
      res.status(200).json({ ok: true });
      return;
    }

    // Narrow to the full inbound schema
    const inboundResult = incomingMessageSchema.safeParse(req.body);
    if (!inboundResult.success) {
      logger.warn({ errors: inboundResult.error.errors }, "incomingMessageReceived payload malformed — ignoring");
      res.status(200).json({ ok: true });
      return;
    }

    const inbound = inboundResult.data;
    const chatId = inbound.senderData.chatId;
    const senderName = inbound.senderData.senderName ?? null;
    const textMessage =
      inbound.messageData.textMessageData?.textMessage ??
      inbound.messageData.extendedTextMessageData?.text ??
      "";
    const idMessage = inbound.idMessage;

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
      // Still return 200 to avoid GreenAPI retries
      res.status(200).json({ ok: true });
      return;
    }

    const conversationId = conversation.id;

    // 3b. Insert inbound message
    const { error: msgErr } = await supabaseAdmin.from("messages").insert({
      conversation_id: conversationId,
      direction: "inbound",
      sent_by: "customer",
      body: textMessage,
      whatsapp_message_id: idMessage,
      status: "received",
    });

    if (msgErr) {
      logger.error({ conversationId, msgErr }, "Failed to insert inbound message");
    }

    // 3c. Fire-and-forget AI orchestration
    setImmediate(() => {
      handleIncomingMessage(conversationId, textMessage).catch((err: unknown) => {
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
      logger.error({ chatId, convErr }, "Failed to upsert conversation for manual send");
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

    res.json({ status: "success", data: { idMessage } });
  },
};
