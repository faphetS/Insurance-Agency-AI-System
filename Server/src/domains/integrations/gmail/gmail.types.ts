export interface GmailIntegration {
  id: string;
  staff_id: string;
  email: string;
  refresh_token: string;
  access_token: string | null;
  access_token_expires_at: string | null;
  scope: string | null;
  connected_at: string;
  last_synced_at: string | null;
  last_unread_count: number | null;
  last_error: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface EmailInboxStatus {
  staffId: string;
  email: string;
  connected: boolean;
  unreadCount: number;
  lastSyncedAt: string | null;
  error: string | null;
}

export interface ParsedEmail {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  bodyText: string;
  internalDate: number;
  labelIds: string[];
  direction: "sent" | "received" | "other";
}
