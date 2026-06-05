export type NotificationType =
  | "forms_check"
  | "receipt_check"
  | "policy_check"
  | "deposit_check"
  | "cross_check"
  | "overdue_task"
  | "summary_ready"
  | "service_due"
  | "sla_breach"
  | "digest"
  | "email_pending"
  | "whatsapp_unanswered"
  | "complex_case";

export type NotificationSeverity = "info" | "warning" | "urgent";

export type TaskType =
  | "forms_check"
  | "receipt_check"
  | "policy_check"
  | "deposit_check"
  | "cross_check"
  | "service_meeting"
  | "summary_approval"
  | "general";

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

export interface TaskChainStep {
  type: TaskType;
  delayDays: number;
  description: string;
}

export const TASK_CHAIN_DEFINITION: TaskChainStep[] = [
  { type: "forms_check", delayDays: 7, description: "Check if insurance forms were submitted" },
  { type: "receipt_check", delayDays: 14, description: "Check if receipt was issued" },
  { type: "policy_check", delayDays: 30, description: "Check if policy document is ready" },
  { type: "deposit_check", delayDays: 60, description: "Check if deposit was received" },
  { type: "cross_check", delayDays: 90, description: "Cross-verify all documents against email milestone records" },
];

export const PIPELINE_STAGE_MAP: Record<TaskType, PipelineStage> = {
  forms_check: "forms",
  receipt_check: "receipt",
  policy_check: "policy",
  deposit_check: "deposit",
  cross_check: "completed",
  service_meeting: "meeting_scheduling",
  summary_approval: "awaiting_approval",
  general: "docs_pending",
};

export interface MilestoneCheckResult {
  found: boolean;
  details?: Record<string, unknown>;
}

export interface MilestoneProvider {
  checkForms(clientId: string): Promise<MilestoneCheckResult>;
  checkReceipt(clientId: string): Promise<MilestoneCheckResult>;
  checkPolicy(clientId: string): Promise<MilestoneCheckResult>;
  checkDeposit(clientId: string): Promise<MilestoneCheckResult>;
  getStaffList(): Promise<Array<{ id: string; name: string; phone?: string }>>;
}

export interface CreateNotificationData {
  type: NotificationType;
  title: string;
  message: string;
  severity?: NotificationSeverity;
  client_id?: string;
  meeting_id?: string;
  task_id?: string;
  reference_key?: string;
}

export interface NotificationFilters {
  type?: NotificationType;
  severity?: NotificationSeverity;
  is_read?: boolean;
  client_id?: string;
  page?: number;
  limit?: number;
}
