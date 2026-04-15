import { z } from "zod";

// ---------------------------------------------------------------------------
// Incoming message webhook
// ---------------------------------------------------------------------------

const senderDataSchema = z.object({
  chatId: z.string(),
  senderName: z.string().optional(),
  sender: z.string().optional(),
});

const textMessageDataSchema = z.object({
  textMessageData: z
    .object({
      textMessage: z.string(),
    })
    .optional(),
});

export const incomingMessageSchema = z.object({
  typeWebhook: z.literal("incomingMessageReceived"),
  idMessage: z.string(),
  senderData: senderDataSchema,
  messageData: textMessageDataSchema,
});

export const outgoingMessageSchema = z.object({
  typeWebhook: z.literal("outgoingMessageReceived"),
  idMessage: z.string().optional(),
  senderData: senderDataSchema.optional(),
  messageData: textMessageDataSchema.optional(),
});

export const stateChangedSchema = z.object({
  typeWebhook: z.literal("stateInstanceChanged"),
  stateInstance: z.string().optional(),
});

/**
 * Loose schema that always parses successfully — we only need typeWebhook
 * to decide whether to act. Unknown types are returned as-is.
 */
export const webhookPayloadSchema = z.object({
  typeWebhook: z.string(),
}).passthrough();

export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;
export type IncomingMessagePayload = z.infer<typeof incomingMessageSchema>;

// ---------------------------------------------------------------------------
// Manual send schema (admin endpoint)
// ---------------------------------------------------------------------------

export const sendMessageSchema = z.object({
  chatId: z.string().min(1, "chatId is required"),
  message: z.string().min(1, "message is required"),
});

export type SendMessageInput = z.infer<typeof sendMessageSchema>;
