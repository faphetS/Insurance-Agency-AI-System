import { z } from "zod";

export const notificationListSchema = z.object({
  type: z
    .enum([
      "forms_check",
      "receipt_check",
      "policy_check",
      "deposit_check",
      "overdue_task",
      "summary_ready",
      "service_due",
      "sla_breach",
      "digest",
    ])
    .optional(),
  severity: z.enum(["info", "warning", "urgent"]).optional(),
  is_read: z.coerce.boolean().optional(),
  client_id: z.string().uuid().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(50),
});

export const notificationIdSchema = z.object({
  id: z.string().uuid(),
});

export const approveSummarySchema = {
  params: z.object({
    meetingId: z.string().uuid(),
  }),
  body: z.object({
    finalText: z.string().optional(),
  }),
};

export const completeTaskSchema = z.object({
  taskId: z.string().uuid(),
});

export type NotificationListInput = z.infer<typeof notificationListSchema>;
export type NotificationIdInput = z.infer<typeof notificationIdSchema>;
export type CompleteTaskInput = z.infer<typeof completeTaskSchema>;
