import { createHash } from "crypto";
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

const buttonsResponseMessageSchema = z.object({
  selectedButtonId: z.string().optional(),
  selectedButtonText: z.string().optional(),
});

const templateButtonReplyMessageSchema = z.object({
  selectedId: z.string().optional(),
  selectedDisplayText: z.string().optional(),
});

const interactiveButtonsResponseSchema = z.object({
  selectedId: z.string().optional(),
  selectedDisplayText: z.string().optional(),
  selectedButtonId: z.string().optional(),
  selectedButtonText: z.string().optional(),
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
  fileMessageData: z.object({
    downloadUrl: z.string(),
    caption: z.string().optional(),
    fileName: z.string().optional(),
    mimeType: z.string().optional(),
  }).optional(),
  buttonsResponseMessage: buttonsResponseMessageSchema.optional(),
  templateButtonReplyMessage: templateButtonReplyMessageSchema.optional(),
  interactiveButtonsResponse: interactiveButtonsResponseSchema.optional(),
}).passthrough();

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
 * Priority: image > document > button response > text.
 * rawBody is the unvalidated webhook body — used to read fields that
 * Zod's strict parsing may have stripped.
 */
export function extractPayload(
  inbound: IncomingMessagePayload,
  rawBody?: Record<string, unknown>,
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

  // GreenAPI sends images & docs under fileMessageData — use typeMessage to distinguish
  const fmd = md.fileMessageData;
  if (fmd?.downloadUrl) {
    const isDoc = md.typeMessage === "documentMessage";
    return {
      kind: isDoc ? "document" : "image",
      fileUrl: fmd.downloadUrl,
      mimeType: fmd.mimeType,
      fileName: fmd.fileName,
      caption: fmd.caption,
    };
  }

  // Button click responses — check parsed schema + raw body for all button types
  // GreenAPI sends different shapes depending on the button method used:
  //   buttonsResponseMessage  → selectedButtonId / selectedButtonText
  //   templateButtonReplyMessage → selectedId / selectedDisplayText
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawMd = (rawBody?.messageData ?? {}) as any;
  const buttonText =
    md.interactiveButtonsResponse?.selectedButtonId ??
    md.interactiveButtonsResponse?.selectedButtonText ??
    md.interactiveButtonsResponse?.selectedId ??
    md.interactiveButtonsResponse?.selectedDisplayText ??
    md.buttonsResponseMessage?.selectedButtonId ??
    md.buttonsResponseMessage?.selectedButtonText ??
    md.templateButtonReplyMessage?.selectedId ??
    md.templateButtonReplyMessage?.selectedDisplayText ??
    rawMd.interactiveButtonsResponse?.selectedButtonId ??
    rawMd.interactiveButtonsResponse?.selectedButtonText ??
    rawMd.interactiveButtonsResponse?.selectedId ??
    rawMd.interactiveButtonsResponse?.selectedDisplayText ??
    rawMd.buttonsResponseMessage?.selectedButtonId ??
    rawMd.buttonsResponseMessage?.selectedButtonText ??
    rawMd.templateButtonReplyMessage?.selectedId ??
    rawMd.templateButtonReplyMessage?.selectedDisplayText ??
    "";

  if (buttonText) {
    return { kind: "text", text: String(buttonText) };
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

// ---------------------------------------------------------------------------
// CLIX gateway — inbound webhook schema + normalisation adapter
// ---------------------------------------------------------------------------

export const clixWebhookSchema = z.object({
  customerId: z.string(),
  type: z.enum(["incoming", "outgoing"]),
  chatType: z.string(),
  from: z.string(),
  pushName: z.string().optional(),
  message: z.string().optional(),
  messageType: z.string(),
  timestamp: z.number(),
});

export type ClixWebhookPayload = z.infer<typeof clixWebhookSchema>;

/**
 * Normalise a CLIX webhook body into the GreenAPI shape the controller
 * already processes, plus the originating customerId for instance resolution.
 * Returns null if the payload fails validation (caller should return 200 quietly).
 */
export function clixToInternal(
  body: unknown,
): { payload: Record<string, unknown>; customerId: string } | null {
  const parsed = clixWebhookSchema.safeParse(body);
  if (!parsed.success) return null;

  const { customerId, type, chatType, from, pushName, message, messageType, timestamp } =
    parsed.data;

  // Synthesise a stable dedupe id: clix:<customerId>:<from>:<timestamp>:<msgHash>
  const msgHash = createHash("sha1")
    .update(message ?? "")
    .digest("hex")
    .slice(0, 12);
  const idMessage = `clix:${customerId}:${from}:${timestamp}:${msgHash}`;

  // Non-private chats (groups) get @g.us suffix so the existing group filter drops them
  const chatIdSuffix = chatType === "private" ? "@c.us" : "@g.us";
  const chatId = `${from}${chatIdSuffix}`;

  const typeWebhook =
    type === "incoming" ? "incomingMessageReceived" : "outgoingMessageReceived";

  // Build messageData in GreenAPI shape
  const messageData: Record<string, unknown> =
    messageType === "text"
      ? {
          typeMessage: "textMessage",
          textMessageData: { textMessage: message ?? "" },
        }
      : {
          typeMessage: `${messageType}Message`,
          textMessageData: { textMessage: `[${messageType}]` },
        };

  const payload: Record<string, unknown> = {
    typeWebhook,
    idMessage,
    senderData: {
      chatId,
      senderName: pushName ?? undefined,
      sender: chatId,
    },
    messageData,
  };

  return { payload, customerId };
}
