import { z } from "zod";

// Chatwoot webhook payloads are huge — validate only the fields the takeover
// filter reads. Top-level message_type is a STRING ("incoming"/"outgoing");
// the numeric variant lives only under conversation.messages[] (live-verified
// on v4.15.1). Incoming events' sender is a contact object with NO type key.
export const chatwootCallbackSchema = z
  .object({
    event: z.string().optional(),
    message_type: z.union([z.string(), z.number()]).optional(),
    private: z.boolean().optional(),
    content: z.string().nullable().optional(),
    sender: z
      .object({
        id: z.union([z.string(), z.number()]).optional(),
        type: z.string().optional(),
      })
      .passthrough()
      .optional(),
    conversation: z
      .object({
        meta: z
          .object({
            sender: z
              .object({
                identifier: z.string().nullable().optional(),
                phone_number: z.string().nullable().optional(),
              })
              .passthrough()
              .optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type ChatwootCallback = z.infer<typeof chatwootCallbackSchema>;
