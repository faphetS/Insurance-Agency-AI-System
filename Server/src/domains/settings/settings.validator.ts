import { z } from "zod";

const messageId = z.union([z.literal("default"), z.string().uuid()]);

export const saveMessageSchema = z.object({
  text: z.string().trim().min(1).max(1000),
});

export const messageIdParamsSchema = z.object({
  id: messageId,
});

// "until" is Israel wall time (YYYY-MM-DDTHH:mm) — only its shape is checked here; the
// calendar and range checks live in parseUntil().
export const useMessageSchema = z.discriminatedUnion("mode", [
  z.object({ messageId, mode: z.literal("permanent") }),
  z.object({
    messageId,
    mode: z.literal("temporary"),
    until: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
  }),
]);

export type SaveMessageBody = z.infer<typeof saveMessageSchema>;
export type MessageIdParams = z.infer<typeof messageIdParamsSchema>;
export type UseMessageBody = z.infer<typeof useMessageSchema>;
