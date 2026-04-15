import { z } from "zod";

// ---------------------------------------------------------------------------
// Incoming message webhook
// ---------------------------------------------------------------------------

const senderDataSchema = z.object({
  chatId: z.string(),
  senderName: z.string().optional(),
  sender: z.string().optional(),
});

const imageMessageDataSchema = z.object({
  downloadUrl: z.string(),
  caption: z.string().optional(),
  fileName: z.string().optional(),
  mimeType: z.string().optional(),
});

const documentMessageDataSchema = z.object({
  downloadUrl: z.string(),
  caption: z.string().optional(),
  fileName: z.string().optional(),
  mimeType: z.string().optional(),
});

const messageDataSchema = z.object({
  typeMessage: z.string().optional(),
  textMessageData: z
    .object({
      textMessage: z.string(),
    })
    .optional(),
  extendedTextMessageData: z
    .object({
      text: z.string(),
    })
    .optional(),
  imageMessageData: imageMessageDataSchema.optional(),
  documentMessageData: documentMessageDataSchema.optional(),
});

export const incomingMessageSchema = z.object({
  typeWebhook: z.literal("incomingMessageReceived"),
  idMessage: z.string(),
  senderData: senderDataSchema,
  messageData: messageDataSchema,
});

export const outgoingMessageSchema = z.object({
  typeWebhook: z.literal("outgoingMessageReceived"),
  idMessage: z.string().optional(),
  senderData: senderDataSchema.optional(),
  messageData: messageDataSchema.optional(),
});

export const stateChangedSchema = z.object({
  typeWebhook: z.literal("stateInstanceChanged"),
  stateInstance: z.string().optional(),
});

/**
 * Loose schema that always parses successfully — we only need typeWebhook
 * to decide whether to act. Unknown types are returned as-is.
 */
export const webhookPayloadSchema = z
  .object({
    typeWebhook: z.string(),
  })
  .passthrough();

export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;
export type IncomingMessagePayload = z.infer<typeof incomingMessageSchema>;

// ---------------------------------------------------------------------------
// MessagePayload — normalised view of an incoming message
// ---------------------------------------------------------------------------

export type MessagePayload =
  | { kind: "text"; text: string }
  | {
      kind: "image" | "document";
      fileUrl: string;
      mimeType?: string;
      fileName?: string;
      caption?: string;
    };

/**
 * Extract a normalised MessagePayload from a validated inbound message.
 * Priority: image > document > text (extended then plain).
 */
export function extractPayload(
  inbound: IncomingMessagePayload,
): MessagePayload {
  const md = inbound.messageData;

  if (md.imageMessageData?.downloadUrl) {
    return {
      kind: "image",
      fileUrl: md.imageMessageData.downloadUrl,
      mimeType: md.imageMessageData.mimeType,
      fileName: md.imageMessageData.fileName,
      caption: md.imageMessageData.caption,
    };
  }

  if (md.documentMessageData?.downloadUrl) {
    return {
      kind: "document",
      fileUrl: md.documentMessageData.downloadUrl,
      mimeType: md.documentMessageData.mimeType,
      fileName: md.documentMessageData.fileName,
      caption: md.documentMessageData.caption,
    };
  }

  const text =
    md.extendedTextMessageData?.text ??
    md.textMessageData?.textMessage ??
    "";

  return { kind: "text", text };
}

// ---------------------------------------------------------------------------
// Manual send schema (admin endpoint)
// ---------------------------------------------------------------------------

export const sendMessageSchema = z.object({
  chatId: z.string().min(1, "chatId is required"),
  message: z.string().min(1, "message is required"),
});

export type SendMessageInput = z.infer<typeof sendMessageSchema>;
