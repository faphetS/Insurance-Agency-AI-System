export type ClientStatus = "new" | "active" | "completed";
export type SourceChannel = "wa_personal" | "wa_office" | "wa_staff" | "email";
export type InquiryType =
  | "life_insurance"
  | "health_insurance"
  | "pension"
  | "property"
  | "vehicle"
  | "other";

export interface Client {
  id: string;
  full_name: string;
  phone: string;
  email?: string;
  id_photo_url: string;
  id_validated: boolean;
  poa_doc_url?: string;
  inquiry_type: InquiryType;
  status: ClientStatus;
  assigned_to: string;
  source_channel: SourceChannel;
  last_service_date?: string;
  created_at: string;
}

export type MeetingType = "zoom" | "phone" | "in_person";
export type SummaryStatus = "draft" | "approved" | "sent";
export type MeetingStatus = "scheduled" | "done" | "cancelled";

export interface Meeting {
  id: string;
  client_id: string;
  type: MeetingType;
  scheduled_at: string;
  calendar_event_id: string;
  recording_url?: string;
  transcript?: string;
  summary_draft?: string;
  summary_final?: string;
  summary_status: SummaryStatus;
  client_confirmed: boolean;
  status: MeetingStatus;
  reminder_24h_sent: boolean;
  reminder_1h_sent: boolean;
}

export type TaskType =
  | "forms_check"
  | "receipt_check"
  | "policy_check"
  | "deposit_check"
  | "cross_check"
  | "service_meeting"
  | "general";
export type TaskStatus = "pending" | "done" | "overdue";

export interface Task {
  id: string;
  client_id: string;
  meeting_id?: string;
  type: TaskType;
  description: string;
  assigned_to: string;
  due_at: string;
  status: TaskStatus;
  reminder_sent: boolean;
  parent_task_id?: string;
  created_at: string;
}

export type AutomationMode = "AUTO" | "HYBRID" | "MANUAL";

export interface AutomationRule {
  id: number;
  trigger: string;
  action: string;
  timing: string;
  mode: AutomationMode;
}

export type ChannelKind = "whatsapp" | "email" | "calendar" | "bafi";

export interface Channel {
  id: string;
  kind: ChannelKind;
  label: string;
  identifier: string;
  unread_count: number;
  last_scanned_at: string;
}

export type NodeId =
  | "wa_personal"
  | "wa_office"
  | "wa_staff"
  | "email"
  | "calendar"
  | "bafi"
  | "ai_core"
  | "agent_client"
  | "agent_ops"
  | "doc_validator"
  | "meeting_ai"
  | "task_engine"
  | "reminder_scheduler"
  | "entity_client"
  | "entity_meeting"
  | "entity_task";

export type EntityName = "Client" | "Meeting" | "Task";
export type SampleKey = "clients" | "meetings" | "tasks";
