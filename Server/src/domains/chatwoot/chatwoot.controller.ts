import crypto from "node:crypto";
import type { Request, Response } from "express";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { supabaseAdmin } from "../../config/supabase.js";
import { sendMessage } from "../whatsapp/whatsapp.service.js";
import { chatwootCallbackSchema, type ChatwootCallback } from "./chatwoot.validator.js";

function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function extractChatId(body: ChatwootCallback): string | null {
  const sender = body.conversation?.meta?.sender;
  const identifier = sender?.identifier;
  if (identifier && /^\d+@c\.us$/.test(identifier)) return identifier;

  const digits = sender?.phone_number?.replace(/\D/g, "") ?? "";
  if (digits) return `${digits}@c.us`;

  logger.warn({ identifier }, "chatwoot callback: cannot derive customer chatId — ignoring");
  return null;
}

async function processCallback(body: ChatwootCallback): Promise<void> {
  // Loop-safe filter (live-verified): the mirror posts as the Bot Mirror user,
  // whose sender.id equals CHATWOOT_BOT_USER_ID — those events die here, so a
  // forwarded agent reply mirrored back never re-triggers the forward.
  const isAgentReply =
    body.event === "message_created" &&
    body.message_type === "outgoing" &&
    body.private !== true &&
    body.sender?.type === "user" &&
    !!env.CHATWOOT_BOT_USER_ID &&
    String(body.sender?.id) !== env.CHATWOOT_BOT_USER_ID;

  if (!isAgentReply) {
    logger.debug(
      { event: body.event, messageType: body.message_type },
      "chatwoot callback ignored",
    );
    return;
  }

  const chatId = extractChatId(body);
  if (!chatId) return;

  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (!content) {
    logger.debug({ chatId }, "chatwoot agent reply has no text content — ignoring");
    return;
  }

  await sendMessage(chatId, content, { skipMirror: true });

  const pausedUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const { error } = await supabaseAdmin
    .from("conversations")
    .update({ bot_paused: true, bot_paused_until: pausedUntil })
    .eq("whatsapp_chat_id", chatId);
  if (error) {
    logger.warn({ chatId, error }, "chatwoot takeover: failed to pause bot");
  }

  logger.info({ chatId, pausedUntil }, "chatwoot agent takeover — reply forwarded, bot paused 1h");
}

export const chatwootController = {
  /**
   * POST /api/chatwoot/callback/:secret
   * Chatwoot webhooks are UNSIGNED — the :secret path segment is the only
   * credential. 200 immediately for valid-secret requests; processing runs
   * in setImmediate.
   */
  handleCallback(req: Request, res: Response): void {
    const { secret } = req.params as { secret: string };
    if (!env.CHATWOOT_CALLBACK_SECRET || !secretMatches(secret, env.CHATWOOT_CALLBACK_SECRET)) {
      logger.warn("chatwoot callback: secret mismatch — rejecting");
      res.sendStatus(401);
      return;
    }

    res.sendStatus(200);

    const parsed = chatwootCallbackSchema.safeParse(req.body);
    if (!parsed.success) {
      logger.debug({ errors: parsed.error.errors }, "chatwoot callback parse failed — ignoring");
      return;
    }

    setImmediate(() => {
      void processCallback(parsed.data).catch((err: unknown) =>
        logger.error({ err }, "chatwoot callback processing failed"),
      );
    });
  },
};
