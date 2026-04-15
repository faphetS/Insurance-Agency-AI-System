import type { Tables } from "@/types/database";

export type PipelineRow = Tables<"v_client_pipeline">;
export type ClientRow = Tables<"clients">;
export type ConversationRow = Tables<"conversations">;
export type MessageRow = Tables<"messages">;
export type BotSettingsRow = Tables<"bot_settings">;
export type TaskRow = Tables<"tasks">;

export type PipelineStage =
  | "new_lead"
  | "docs_pending"
  | "meeting_scheduling"
  | "meeting_scheduled"
  | "awaiting_approval"
  | "forms"
  | "receipt"
  | "policy"
  | "deposit"
  | "completed";

export const PIPELINE_STAGES: PipelineStage[] = [
  "new_lead",
  "docs_pending",
  "meeting_scheduling",
  "meeting_scheduled",
  "awaiting_approval",
  "forms",
  "receipt",
  "policy",
  "deposit",
  "completed",
];

export const STAGE_LABELS: Record<PipelineStage, string> = {
  new_lead: "New Lead",
  docs_pending: "Docs Pending",
  meeting_scheduling: "Scheduling",
  meeting_scheduled: "Meeting Scheduled",
  awaiting_approval: "Awaiting Approval",
  forms: "Forms",
  receipt: "Receipt",
  policy: "Policy",
  deposit: "Deposit",
  completed: "Completed",
};

// Top border color per stage (progress left→right)
export const STAGE_COLORS: Record<PipelineStage, string> = {
  new_lead: "border-t-sky-400",
  docs_pending: "border-t-violet-400",
  meeting_scheduling: "border-t-amber-400",
  meeting_scheduled: "border-t-orange-400",
  awaiting_approval: "border-t-rose-400",
  forms: "border-t-yellow-400",
  receipt: "border-t-lime-400",
  policy: "border-t-teal-400",
  deposit: "border-t-emerald-400",
  completed: "border-t-blue-500",
};

// Left-border stripe on the card
export const STAGE_STRIPE: Record<PipelineStage, string> = {
  new_lead: "border-l-sky-400",
  docs_pending: "border-l-violet-400",
  meeting_scheduling: "border-l-amber-400",
  meeting_scheduled: "border-l-orange-400",
  awaiting_approval: "border-l-rose-400",
  forms: "border-l-yellow-400",
  receipt: "border-l-lime-400",
  policy: "border-l-teal-400",
  deposit: "border-l-emerald-400",
  completed: "border-l-blue-500",
};

export interface WhatsAppState {
  stateInstance: string;
  [key: string]: unknown;
}

export interface QrCodeResponse {
  qrCode: string; // base64 PNG
}

export interface SendMessagePayload {
  chatId: string;
  message: string;
}
