import crypto from "node:crypto";
import type { Request, Response } from "express";
import { env } from "../../../config/env.js";
import { logger } from "../../../config/logger.js";
import { supabaseAdmin } from "../../../config/supabase.js";
import { processInboundCustomerMessage } from "../inbound.pipeline.js";
import {
  extractMetaPayload,
  metaWebhookSchema,
  waIdToChatId,
  type MetaValue,
  type MetaWebhookPayload,
} from "./meta.validator.js";

async function processStatuses(value: MetaValue): Promise<void> {
  for (const status of value.statuses ?? []) {
    if (status.status === "failed") {
      for (const e of status.errors ?? []) {
        if (e.code === 131047) {
          logger.warn(
            { wamid: status.id, code: e.code, title: e.title },
            "Meta send failed: outside 24h window — approved template required",
          );
        } else {
          logger.warn(
            { wamid: status.id, code: e.code, title: e.title, message: e.message },
            "Meta send failed",
          );
        }
      }
      await supabaseAdmin
        .from("messages")
        .update({ status: "failed" })
        .eq("whatsapp_message_id", status.id);
    } else if (status.status === "delivered") {
      // Never downgrade: only 'sent' rows move to 'delivered'.
      await supabaseAdmin
        .from("messages")
        .update({ status: "delivered" })
        .eq("whatsapp_message_id", status.id)
        .in("status", ["sent"]);
    } else if (status.status === "read") {
      await supabaseAdmin
        .from("messages")
        .update({ status: "read" })
        .eq("whatsapp_message_id", status.id)
        .in("status", ["sent", "delivered"]);
    }
  }
}

async function processMetaValue(value: MetaValue): Promise<void> {
  await processStatuses(value);

  const senderName = value.contacts?.[0]?.profile?.name ?? null;

  for (const msg of value.messages ?? []) {
    const payload = extractMetaPayload(msg);
    if (!payload) {
      logger.debug({ type: msg.type, wamid: msg.id }, "Meta message type ignored");
      continue;
    }
    await processInboundCustomerMessage({
      chatId: waIdToChatId(msg.from),
      senderName,
      messageId: msg.id,
      payload,
      channel: "meta",
    });
  }
}

async function processMetaEvent(payload: MetaWebhookPayload): Promise<void> {
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      await processMetaValue(change.value);
    }
  }
}

export const metaWebhookController = {
  /**
   * GET /api/whatsapp/meta-webhook
   * Meta dashboard "Verify and save" handshake — echoes hub.challenge when the
   * verify token matches; 403 otherwise (also when META_VERIFY_TOKEN is unset).
   */
  verifyWebhook(req: Request, res: Response): void {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (
      env.META_VERIFY_TOKEN &&
      mode === "subscribe" &&
      token === env.META_VERIFY_TOKEN &&
      typeof challenge === "string"
    ) {
      res.status(200).send(challenge);
      return;
    }

    logger.warn({ mode, hasToken: token !== undefined }, "Meta webhook verification failed");
    res.sendStatus(403);
  },

  /**
   * POST /api/whatsapp/meta-webhook
   * Unauthenticated route — every POST is authenticated by X-Hub-Signature-256
   * (HMAC-SHA256 of the raw body with META_APP_SECRET). 200 immediately after
   * the signature check; processing runs in setImmediate.
   */
  handleWebhook(req: Request, res: Response): void {
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    const signature = req.headers["x-hub-signature-256"];

    if (!env.META_APP_SECRET || !rawBody || typeof signature !== "string") {
      logger.warn(
        { hasSecret: !!env.META_APP_SECRET, hasRawBody: !!rawBody, hasSignature: typeof signature === "string" },
        "Meta webhook signature check impossible — rejecting",
      );
      res.sendStatus(401);
      return;
    }

    const expected =
      "sha256=" + crypto.createHmac("sha256", env.META_APP_SECRET).update(rawBody).digest("hex");
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);

    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      logger.warn("Meta webhook signature mismatch — rejecting");
      res.sendStatus(401);
      return;
    }

    res.sendStatus(200);

    const parsed = metaWebhookSchema.safeParse(req.body);
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.errors }, "Meta webhook parse failed — ignoring");
      return;
    }

    setImmediate(() => {
      void processMetaEvent(parsed.data).catch((err: unknown) =>
        logger.error({ err }, "Meta webhook processing failed"),
      );
    });
  },
};
