import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../config/logger.js";
import { bafiProvider } from "./operations.bafi.js";
import { createNotification, completeTask } from "./operations.service.js";
import type { TaskType } from "./operations.types.js";

export async function checkDueAndOverdueTasks(): Promise<void> {
  const now = new Date();

  const { data: tasks, error } = await supabaseAdmin
    .from("tasks")
    .select("id, client_id, type, due_at, status")
    .eq("status", "pending")
    .lte("due_at", now.toISOString());

  if (error) {
    logger.error({ error }, "checkDueAndOverdueTasks: query failed");
    return;
  }

  for (const task of tasks ?? []) {
    try {
      const taskType = task.type as TaskType;
      const clientId = task.client_id as string;

      let result;
      switch (taskType) {
        case "forms_check":
          result = await bafiProvider.checkForms(clientId);
          break;
        case "receipt_check":
          result = await bafiProvider.checkReceipt(clientId);
          break;
        case "policy_check":
          result = await bafiProvider.checkPolicy(clientId);
          break;
        case "deposit_check":
          result = await bafiProvider.checkDeposit(clientId);
          break;
        case "cross_check":
          result = await bafiProvider.crossCheck(clientId);
          break;
        default:
          continue;
      }

      if (result.found) {
        await completeTask(task.id as string);
      } else {
        const dueAt = new Date(task.due_at as string);
        const overdueByMs = now.getTime() - dueAt.getTime();
        const overdueByDays = overdueByMs / (1000 * 60 * 60 * 24);

        if (overdueByDays > 3) {
          await supabaseAdmin
            .from("tasks")
            .update({ status: "overdue", updated_at: now.toISOString() })
            .eq("id", task.id);

          await createNotification({
            type: "overdue_task",
            title: `Overdue task: ${taskType}`,
            message: `Task "${taskType}" for client ${clientId} is overdue by ${Math.floor(overdueByDays)} days.`,
            severity: "urgent",
            client_id: clientId,
            task_id: task.id as string,
            reference_key: `overdue:${task.id}`,
          });
        }
      }
    } catch (err) {
      logger.error({ err, taskId: task.id }, "checkDueAndOverdueTasks: error processing task");
    }
  }
}

export async function checkSummaryApprovals(): Promise<void> {
  const { data: meetings, error } = await supabaseAdmin
    .from("meetings")
    .select("id, client_id")
    .eq("summary_status", "draft")
    .not("summary_draft", "is", null);

  if (error) {
    logger.error({ error }, "checkSummaryApprovals: query failed");
    return;
  }

  for (const meeting of meetings ?? []) {
    try {
      await createNotification({
        type: "summary_ready",
        title: "Meeting summary awaiting approval",
        message: `Meeting ${meeting.id} has a draft summary ready for approval.`,
        severity: "warning",
        client_id: meeting.client_id as string | undefined,
        meeting_id: meeting.id as string,
        reference_key: `summary_ready:${meeting.id}`,
      });
    } catch (err) {
      logger.error({ err, meetingId: meeting.id }, "checkSummaryApprovals: error processing meeting");
    }
  }
}

export async function checkServiceMeetingEligibility(): Promise<void> {
  const twoYearsAgo = new Date();
  twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
  const twoYearsAgoStr = twoYearsAgo.toISOString().split("T")[0]!;
  const currentYear = new Date().getFullYear();

  const { data: clients, error } = await supabaseAdmin
    .from("clients")
    .select("id, last_service_date")
    .eq("status", "active")
    .or(`last_service_date.is.null,last_service_date.lte.${twoYearsAgoStr}`);

  if (error) {
    logger.error({ error }, "checkServiceMeetingEligibility: query failed");
    return;
  }

  for (const client of clients ?? []) {
    try {
      await createNotification({
        type: "service_due",
        title: "Annual service meeting due",
        message: `Client ${client.id} is due for a service meeting (last service: ${client.last_service_date ?? "never"}).`,
        severity: "warning",
        client_id: client.id as string,
        reference_key: `service_due:${client.id}:${currentYear}`,
      });
    } catch (err) {
      logger.error({ err, clientId: client.id }, "checkServiceMeetingEligibility: error processing client");
    }
  }
}

export async function checkSlaBreaches(): Promise<void> {
  const today = new Date().toISOString().split("T")[0]!;

  const { data: clients, error } = await supabaseAdmin
    .from("v_client_pipeline")
    .select("id, full_name, derived_stage")
    .eq("sla_breached", true);

  if (error) {
    logger.error({ error }, "checkSlaBreaches: query failed");
    return;
  }

  for (const client of clients ?? []) {
    try {
      await createNotification({
        type: "sla_breach",
        title: "SLA breach detected",
        message: `Client ${client.full_name ?? client.id} has breached SLA in stage "${client.derived_stage}".`,
        severity: "urgent",
        client_id: client.id as string,
        reference_key: `sla_breach:${client.id}:${today}`,
      });
    } catch (err) {
      logger.error({ err, clientId: client.id }, "checkSlaBreaches: error processing client");
    }
  }
}

export async function runAllChecks(): Promise<void> {
  logger.info("runAllChecks: starting");

  try {
    await checkDueAndOverdueTasks();
  } catch (err) {
    logger.error({ err }, "runAllChecks: checkDueAndOverdueTasks failed");
  }

  try {
    await checkSummaryApprovals();
  } catch (err) {
    logger.error({ err }, "runAllChecks: checkSummaryApprovals failed");
  }

  try {
    await checkServiceMeetingEligibility();
  } catch (err) {
    logger.error({ err }, "runAllChecks: checkServiceMeetingEligibility failed");
  }

  try {
    await checkSlaBreaches();
  } catch (err) {
    logger.error({ err }, "runAllChecks: checkSlaBreaches failed");
  }

  logger.info("runAllChecks: complete");
}
