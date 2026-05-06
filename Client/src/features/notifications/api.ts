import api from "@/services/api";

export interface Notification {
  id: string;
  type: string;
  title: string;
  message: string;
  severity: "info" | "warning" | "urgent";
  client_id: string | null;
  meeting_id: string | null;
  task_id: string | null;
  reference_key: string | null;
  is_read: boolean;
  read_at: string | null;
  created_at: string;
}

export interface NotificationsFilter {
  type?: string;
  severity?: string;
  is_read?: boolean;
  page?: number;
  limit?: number;
}

export async function fetchNotifications(params?: NotificationsFilter) {
  const { data } = await api.get<{ data: { data: Notification[]; total: number } }>("/operations/notifications", { params });
  return data.data;
}

export async function fetchUnreadCount() {
  const { data } = await api.get<{ data: { count: number } }>("/operations/notifications/unread-count");
  return data.data;
}

export async function markNotificationRead(id: string) {
  await api.patch(`/operations/notifications/${id}/read`);
}

export async function markAllNotificationsRead() {
  await api.patch("/operations/notifications/read-all");
}
