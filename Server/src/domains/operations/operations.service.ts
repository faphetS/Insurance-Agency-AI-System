import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../config/logger.js";
import { NotFoundError } from "../../lib/errors.js";
import {
  PIPELINE_STAGE_MAP,
  TASK_CHAIN_DEFINITION,
  type CreateNotificationData,
  type NotificationFilters,
  type TaskType,
} from "./operations.types.js";

export async function createNotification(data: CreateNotificationData) {
  const { error, data: row } = await supabaseAdmin
    .from("notifications")
    .upsert(
      {
        type: data.type,
        title: data.title,
        message: data.message,
        severity: data.severity ?? "info",
        client_id: data.client_id ?? null,
        meeting_id: data.meeting_id ?? null,
        task_id: data.task_id ?? null,
        reference_key: data.reference_key ?? null,
        is_read: false,
      },
      { onConflict: "reference_key", ignoreDuplicates: true },
    )
    .select()
    .maybeSingle();

  if (error) {
    logger.error({ error, data }, "createNotification: upsert failed");
    return null;
  }

  return row;
}

export async function createTaskChain(meetingId: string) {
  const { data: meeting, error: meetingErr } = await supabaseAdmin
    .from("meetings")
    .select("id, client_id")
    .eq("id", meetingId)
    .single();

  if (meetingErr || !meeting) {
    throw new NotFoundError("Meeting");
  }

  const clientId = meeting.client_id as string | null;
  if (!clientId) {
    throw new NotFoundError("Client linked to meeting");
  }

  const { data: client } = await supabaseAdmin
    .from("clients")
    .select("assigned_to, assigned_handler_id")
    .eq("id", clientId)
    .single();

  const assignedTo =
    (client?.assigned_handler_id as string | null) ?? (client?.assigned_to as string | null);
  if (!assignedTo) {
    throw new NotFoundError("Staff member assigned to client");
  }

  const now = new Date();
  const tasks = TASK_CHAIN_DEFINITION.map((step) => {
    const dueAt = new Date(now.getTime() + step.delayDays * 24 * 60 * 60 * 1000);
    return {
      client_id: clientId,
      meeting_id: meetingId,
      type: step.type,
      description: step.description,
      due_at: dueAt.toISOString(),
      status: "pending",
      reminder_sent: false,
      assigned_to: assignedTo,
    };
  });

  const { error: tasksErr } = await supabaseAdmin.from("tasks").insert(tasks);

  if (tasksErr) {
    logger.error({ tasksErr, meetingId }, "createTaskChain: failed to insert tasks");
    throw new Error("Failed to create task chain");
  }

  await supabaseAdmin
    .from("clients")
    .update({ pipeline_stage: "awaiting_approval" })
    .eq("id", clientId);

  await createNotification({
    type: "summary_ready",
    title: "Meeting summary ready for approval",
    message: `A meeting summary is ready for review and the task chain has been created.`,
    severity: "warning",
    client_id: clientId,
    meeting_id: meetingId,
    reference_key: `summary_ready:${meetingId}`,
  });

  logger.info({ meetingId, clientId, taskCount: tasks.length }, "createTaskChain: created");
}

export async function completeTask(taskId: string) {
  const { data: task, error: fetchErr } = await supabaseAdmin
    .from("tasks")
    .select("id, client_id, type")
    .eq("id", taskId)
    .single();

  if (fetchErr || !task) {
    throw new NotFoundError("Task");
  }

  const { error: updateErr } = await supabaseAdmin
    .from("tasks")
    .update({ status: "done", updated_at: new Date().toISOString() })
    .eq("id", taskId);

  if (updateErr) {
    logger.error({ updateErr, taskId }, "completeTask: failed to update task");
    throw new Error("Failed to complete task");
  }

  await advancePipelineStage(task.client_id as string, task.type as TaskType);

  await createNotification({
    type: task.type as CreateNotificationData["type"],
    title: `Task completed: ${task.type}`,
    message: `Task ${taskId} of type "${task.type}" has been marked as done.`,
    severity: "info",
    client_id: task.client_id as string,
    task_id: taskId,
    reference_key: `task_done:${taskId}`,
  });

  logger.info({ taskId, type: task.type }, "completeTask: done");
}

export async function advancePipelineStage(clientId: string, completedTaskType: TaskType) {
  const newStage = PIPELINE_STAGE_MAP[completedTaskType];

  const { error } = await supabaseAdmin
    .from("clients")
    .update({ pipeline_stage: newStage })
    .eq("id", clientId);

  if (error) {
    logger.error({ error, clientId, completedTaskType }, "advancePipelineStage: update failed");
  } else {
    logger.info({ clientId, completedTaskType, newStage }, "advancePipelineStage: updated");
  }
}

export async function getNotifications(filters: NotificationFilters) {
  const page = filters.page ?? 1;
  const limit = filters.limit ?? 50;
  const offset = (page - 1) * limit;

  let query = supabaseAdmin
    .from("notifications")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (filters.type !== undefined) query = query.eq("type", filters.type);
  if (filters.severity !== undefined) query = query.eq("severity", filters.severity);
  if (filters.is_read !== undefined) query = query.eq("is_read", filters.is_read);
  if (filters.client_id !== undefined) query = query.eq("client_id", filters.client_id);

  const { data, error, count } = await query;

  if (error) {
    logger.error({ error, filters }, "getNotifications: query failed");
    return { data: [], total: 0 };
  }

  return { data: data ?? [], total: count ?? 0 };
}

export async function markAsRead(notificationId: string) {
  const { error } = await supabaseAdmin
    .from("notifications")
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq("id", notificationId);

  if (error) {
    logger.error({ error, notificationId }, "markAsRead: update failed");
    throw new NotFoundError("Notification");
  }
}

export async function markAllAsRead() {
  const { error } = await supabaseAdmin
    .from("notifications")
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq("is_read", false);

  if (error) {
    logger.error({ error }, "markAllAsRead: update failed");
    throw new Error("Failed to mark all notifications as read");
  }
}

export async function getUnreadCount(): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from("notifications")
    .select("*", { count: "exact", head: true })
    .eq("is_read", false);

  if (error) {
    logger.error({ error }, "getUnreadCount: query failed");
    return 0;
  }

  return count ?? 0;
}

export async function getEmailMonitoring() {
  const { emailProvider } = await import("./operations.email.js");
  return emailProvider.scanAll();
}

export async function getWhatsappMonitoring() {
  const { whatsappMonitor } = await import("./operations.whatsapp-monitor.js");
  return whatsappMonitor.getSummary();
}

export async function getServiceMeetings() {
  const { getServiceMeetingsSummary } = await import("./operations.service-meetings.js");
  return getServiceMeetingsSummary();
}

export async function getDashboard() {
  const [overdueTasks, pendingSummaries, pipeline, unreadCount, slaBreaches] = await Promise.all([
    supabaseAdmin
      .from("tasks")
      .select("*", { count: "exact", head: true })
      .eq("status", "overdue"),

    supabaseAdmin
      .from("meetings")
      .select("*", { count: "exact", head: true })
      .eq("summary_status", "draft")
      .not("summary_draft", "is", null),

    supabaseAdmin
      .from("v_client_pipeline")
      .select("derived_stage"),

    getUnreadCount(),

    supabaseAdmin
      .from("v_client_pipeline")
      .select("*", { count: "exact", head: true })
      .eq("sla_breached", true),
  ]);

  const stageDistribution: Record<string, number> = {};
  for (const row of pipeline.data ?? []) {
    const stage = (row.derived_stage as string) ?? "unknown";
    stageDistribution[stage] = (stageDistribution[stage] ?? 0) + 1;
  }

  return {
    overdue_tasks: overdueTasks.count ?? 0,
    pending_summary_approvals: pendingSummaries.count ?? 0,
    pipeline_stage_distribution: stageDistribution,
    unread_notifications: unreadCount,
    sla_breaches: slaBreaches.count ?? 0,
  };
}

