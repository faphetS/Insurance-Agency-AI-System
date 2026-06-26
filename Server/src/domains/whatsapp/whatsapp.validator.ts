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
      // GreenAPI delivers a remote download URL; always present on the GreenAPI path.
      // On the Clix path (Milestone 2), fileUrl will be absent and base64 will be set.
      fileUrl: string;
      // Clix delivers media inline as base64. Carried here so Milestone 2 can decode
      // it to a Buffer and upload to Drive. NEVER persisted to the DB.
      base64?: string;
      mimeType?: string;
      fileName?: string;
      caption?: string;
    };

/**
 * Extract a normalised MessagePayload from a validated inbound message.
 * Priority: clixMedia (if provided) > image > document > button response > text.
 * rawBody is the unvalidated webhook body — used to read fields that
 * Zod's strict parsing may have stripped.
 * clixMedia is the Clix-path media attachment from clixToInternal — carries base64 inline
 * and bypasses the GreenAPI fileUrl path entirely.
 */
export function extractPayload(
  inbound: IncomingMessagePayload,
  rawBody?: Record<string, unknown>,
  clixMedia?: ClixMediaAttachment | null,
): MessagePayload {
  // Clix media path: the normalised payload carries only a placeholder text; the real
  // media data (kind + base64) lives on the ClixMediaAttachment passed by the controller.
  if (clixMedia) {
    return {
      kind: clixMedia.kind === "video" ? "image" : clixMedia.kind,
      fileUrl: "",
      base64: clixMedia.base64,
      mimeType: clixMedia.mimetype,
      fileName: clixMedia.fileName,
      caption: clixMedia.caption,
    };
  }
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

const clixMediaObjectSchema = z
  .object({
    base64: z.string().optional(),
    mimetype: z.string().nullish(),
    caption: z.string().nullish(),
    fileName: z.string().nullish(),
  })
  .passthrough();

// Lenient by design: real Clix payloads vary (null fields on media messages,
// string timestamps, extra keys). We hard-require only the routing/identity
// fields; everything else tolerates null/missing so a photo is never dropped
// as "malformed".
export const clixWebhookSchema = z
  .object({
    customerId: z.string(),
    type: z.string(),
    chatType: z.string().default("private"),
    from: z.string(),
    participant: z.string().nullish(),
    pushName: z.string().nullish(),
    message: z.string().nullish(),
    messageType: z.string().default("text"),
    timestamp: z.coerce.number().default(0),
    // Media arrives under either "image" or "media" key (shape varies — stay lenient)
    image: clixMediaObjectSchema.nullish(),
    media: clixMediaObjectSchema.nullish(),
  })
  .passthrough();

export type ClixWebhookPayload = z.infer<typeof clixWebhookSchema>;

// Internal: carries the base64 media alongside the normalised payload so the
// controller can log it without persisting it, and Milestone 2 can route it
// to Drive without re-parsing the raw body.
export type ClixMediaAttachment = {
  kind: "image" | "document" | "video";
  base64: string;
  mimetype?: string;
  fileName?: string;
  caption?: string;
};

export type ClixToInternalResult = {
  payload: Record<string, unknown>;
  customerId: string;
  media: ClixMediaAttachment | null;
};

const MEDIA_TYPES = new Set(["image", "document", "video"]);

/**
 * Normalise a Clix webhook body into the GreenAPI shape the controller already
 * processes, plus the originating customerId for instance resolution and an
 * optional media attachment for Milestone 2 Drive upload.
 *
 * Returns null when:
 *   - the body fails schema validation (malformed)
 *   - type !== "incoming" (outgoing echo — caller returns 200 silently)
 */
export function clixToInternal(body: unknown): ClixToInternalResult | null {
  const parsed = clixWebhookSchema.safeParse(body);
  if (!parsed.success) return null;

  const {
    customerId,
    type,
    chatType,
    from,
    participant,
    pushName,
    message,
    messageType,
    timestamp,
    image,
    media,
  } = parsed.data;

  // Skip outgoing echoes — caller returns 200 silently
  if (type !== "incoming") return null;

  // Synthesise a stable dedupe id: clix:<customerId>:<from>:<timestamp>:<hash>
  const hashInput = messageType === "text" ? (message ?? "") : (image?.fileName ?? media?.fileName ?? messageType);
  const msgHash = createHash("sha1").update(hashInput).digest("hex").slice(0, 12);
  const idMessage = `clix:${customerId}:${from}:${timestamp}:${msgHash}`;

  // Non-private chats (groups) get @g.us suffix so the existing group filter drops them
  const chatIdSuffix = chatType === "private" ? "@c.us" : "@g.us";
  const chatId = `${from}${chatIdSuffix}`;

  // Groups: sender is `participant`, not `from`
  const senderChatId = participant ? `${participant}${chatIdSuffix}` : chatId;

  let messageData: Record<string, unknown>;
  let mediaAttachment: ClixMediaAttachment | null = null;

  if (MEDIA_TYPES.has(messageType)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mediaObj = (image ?? media ?? null) as any;
    const resolvedKind = (messageType === "image" || messageType === "video" || messageType === "document")
      ? messageType
      : "document";
    const fileName: string | undefined = mediaObj?.fileName ?? mediaObj?.filename ?? undefined;
    const placeholder =
      messageType === "image"
        ? `[image: ${fileName ?? "photo"}]`
        : messageType === "video"
          ? "[video]"
          : `[document: ${fileName ?? "file"}]`;

    messageData = {
      typeMessage: "textMessage",
      textMessageData: { textMessage: placeholder },
    };

    // base64 field name varies across gateways — try the common ones.
    const b64: unknown = mediaObj ? (mediaObj.base64 ?? mediaObj.data ?? mediaObj.body) : null;
    if (typeof b64 === "string" && b64.length > 0) {
      mediaAttachment = {
        kind: resolvedKind as ClixMediaAttachment["kind"],
        base64: b64,
        mimetype: (mediaObj.mimetype ?? mediaObj.mimeType ?? undefined) as string | undefined,
        fileName,
        caption: (mediaObj.caption ?? undefined) as string | undefined,
      };
    }
  } else {
    // Button-tap detection: Clix delivers a button response as a text message where
    // the body is a JSON string like {"id":"opt_a"}. Normalise it to the buttonId so
    // downstream sees the same value as a GreenAPI button tap.
    let resolvedText = message ?? "";
    if (messageType === "text" && resolvedText.startsWith("{")) {
      try {
        const parsed = JSON.parse(resolvedText) as unknown;
        if (
          parsed !== null &&
          typeof parsed === "object" &&
          !Array.isArray(parsed) &&
          typeof (parsed as Record<string, unknown>).id === "string"
        ) {
          resolvedText = (parsed as { id: string }).id;
        }
      } catch {
        // Not JSON — treat as plain text
      }
    }
    messageData = {
      typeMessage: "textMessage",
      textMessageData: { textMessage: resolvedText },
    };
  }

  const payload: Record<string, unknown> = {
    typeWebhook: "incomingMessageReceived",
    idMessage,
    senderData: {
      chatId: senderChatId,
      senderName: pushName ?? undefined,
      sender: senderChatId,
    },
    messageData,
  };

  return { payload, customerId, media: mediaAttachment };
}
