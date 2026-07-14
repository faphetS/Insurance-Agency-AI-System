import { z } from "zod";
import type { MessagePayload } from "../whatsapp.validator.js";

// ---------------------------------------------------------------------------
// Meta Cloud API webhook envelope — loose schemas mirroring whatsapp.validator's
// parse-loose-then-narrow style. Unknown fields pass through.
// ---------------------------------------------------------------------------

const metaMessageSchema = z
  .object({
    from: z.string(),
    id: z.string(),
    timestamp: z.string().optional(),
    type: z.string(),
    text: z.object({ body: z.string() }).optional(),
    interactive: z
      .object({
        type: z.string().optional(),
        button_reply: z.object({ id: z.string(), title: z.string().optional() }).optional(),
        list_reply: z.object({ id: z.string(), title: z.string().optional() }).optional(),
      })
      .passthrough()
      .optional(),
    image: z
      .object({
        id: z.string(),
        mime_type: z.string().optional(),
        caption: z.string().optional(),
      })
      .passthrough()
      .optional(),
    document: z
      .object({
        id: z.string(),
        mime_type: z.string().optional(),
        caption: z.string().optional(),
        filename: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const metaStatusSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    recipient_id: z.string().optional(),
    errors: z
      .array(
        z
          .object({
            code: z.number().optional(),
            title: z.string().optional(),
            message: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const metaValueSchema = z
  .object({
    messaging_product: z.string().optional(),
    contacts: z
      .array(
        z
          .object({
            wa_id: z.string().optional(),
            profile: z.object({ name: z.string().optional() }).passthrough().optional(),
          })
          .passthrough(),
      )
      .optional(),
    messages: z.array(metaMessageSchema).optional(),
    statuses: z.array(metaStatusSchema).optional(),
  })
  .passthrough();

export const metaWebhookSchema = z
  .object({
    object: z.string().optional(),
    entry: z
      .array(
        z
          .object({
            id: z.string().optional(),
            changes: z
              .array(
                z
                  .object({
                    field: z.string().optional(),
                    value: metaValueSchema,
                  })
                  .passthrough(),
              )
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export type MetaWebhookPayload = z.infer<typeof metaWebhookSchema>;
export type MetaValue = z.infer<typeof metaValueSchema>;
export type MetaMessage = z.infer<typeof metaMessageSchema>;
export type MetaStatus = z.infer<typeof metaStatusSchema>;

// ---------------------------------------------------------------------------
// Identity mapping — Meta wa_id is bare digits; all existing DB rows key off
// the GreenAPI-style "<digits>@c.us" chat id, so the mapping is a suffix.
// ---------------------------------------------------------------------------

export function waIdToChatId(waId: string): string {
  return `${waId}@c.us`;
}

export function chatIdToWaId(chatId: string): string {
  return chatId.split("@")[0] ?? chatId;
}

/**
 * Normalise a Meta inbound message into the shared MessagePayload union.
 * Returns null for types we explicitly ignore (reaction/sticker/unsupported/unknown).
 */
export function extractMetaPayload(msg: MetaMessage): MessagePayload | null {
  if (msg.type === "text" && msg.text) {
    return { kind: "text", text: msg.text.body };
  }

  if (msg.type === "interactive") {
    const reply = msg.interactive?.list_reply ?? msg.interactive?.button_reply;
    if (reply) {
      return { kind: "text", text: reply.id, isButtonReply: true };
    }
    return null;
  }

  if (msg.type === "image" && msg.image) {
    return {
      kind: "image",
      mediaId: msg.image.id,
      mimeType: msg.image.mime_type,
      caption: msg.image.caption,
    };
  }

  if (msg.type === "document" && msg.document) {
    return {
      kind: "document",
      mediaId: msg.document.id,
      mimeType: msg.document.mime_type,
      fileName: msg.document.filename,
      caption: msg.document.caption,
    };
  }

  return null;
}
