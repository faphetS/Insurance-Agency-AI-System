import { z } from "zod";

export const scanGmailSchema = z.object({
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(25).default(10),
  staffId: z.string().uuid().optional(),
});

export type ScanGmailQuery = z.infer<typeof scanGmailSchema>;

export const milestonesGmailSchema = z.object({
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(30).default(15),
  staffId: z.string().uuid().optional(),
});

export type MilestonesGmailQuery = z.infer<typeof milestonesGmailSchema>;
