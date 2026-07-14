import type { Request, Response } from "express";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { supabaseAdmin } from "../../config/supabase.js";
import { assignStaffToMeeting } from "../meetings/meeting-handoff.service.js";
import { handleOpInstanceEvent } from "../operations/unanswered-wa.service.js";
import * as whatsappService from "./whatsapp.service.js";
import { extractButtonId } from "./whatsapp.util.js";

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

    // NOTIFY-instance short-circuit: the owner's staff-picker buttons ride the
    // NOTIFY line (GREENAPI_NOTIFY_*) — handle ONLY incoming assign_staff taps
    // there; every other event on that instance is acknowledged and ignored.
    if (
      env.GREENAPI_NOTIFY_ID_INSTANCE &&
      opIdInstance !== undefined &&
      String(opIdInstance) === String(env.GREENAPI_NOTIFY_ID_INSTANCE)
    ) {
      res.status(200).json({ ok: true });
      if (rawBody.typeWebhook === "incomingMessageReceived") {
        const assignMatch = /^assign_staff:([^:]+):([^:]+)$/.exec(extractButtonId(rawBody));
        if (assignMatch) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const notifyChatId = ((rawBody as Record<string, any>)?.senderData?.chatId as string | undefined) ?? "";
          setImmediate(() =>
            assignStaffToMeeting(assignMatch[1]!, assignMatch[2]!, notifyChatId).catch((err: unknown) =>
              logger.error({ err, chatId: notifyChatId }, "assignStaffToMeeting (notify line) failed"),
            ),
          );
        }
      }
      return;
    }

    // Every other event on this webhook (945 conversational instance is retired —
    // the sole conversational transport is now Meta, via /meta-webhook) is
    // acknowledged and ignored.
    res.status(200).json({ ok: true });
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
