import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../config/logger.js";
import { milestoneProvider } from "./operations.email-milestones.js";
import { createNotification, completeTask } from "./operations.service.js";
import { notifyStaffSummaryReady } from "./operations.staff-notify.js";
import { notifyStaffTaskOverdue } from "./operations.staff-reminder.js";
import { sendOverdueAlert, sendSlaAlert, sendServiceDueInvite } from "./operations.alert-sender.js";
import { buildCrossCheckAssessment } from "./operations.cross-check.js";
import type { TaskType } from "./operations.types.js";

export async function checkDueAndOverdueTasks(): Promise<void> {
  const now = new Date();

  const { data: tasks, error } = await supabaseAdmin
    .from("tasks")
    .select("id, client_id, type, due_at, status, assigned_to, reminder_sent")
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
          result = await milestoneProvider.checkForms(clientId);
          break;
        case "receipt_check":
          result = await milestoneProvider.checkReceipt(clientId);
          break;
        case "policy_check":
          result = await milestoneProvider.checkPolicy(clientId);
          break;
        case "deposit_check":
          result = await milestoneProvider.checkDeposit(clientId);
          break;
        case "cross_check": {
          result = await milestoneProvider.crossCheck(clientId);
          // Advisory AI artifact — compare summary text vs milestone execution.
          // Degrades gracefully: no summary or AI failure is a silent no-op.
          const flags = {
            forms: !!(result.details?.["forms"] as boolean | undefined),
            receipt: !!(result.details?.["receipt"] as boolean | undefined),
            policy: !!(result.details?.["policy"] as boolean | undefined),
            deposit: !!(result.details?.["deposit"] as boolean | undefined),
          };
          await buildCrossCheckAssessment(clientId, task.id as string, flags);
          break;
        }
        default:
          continue;
      }

      if (result.found) {
        await completeTask(task.id as string);
      } else if (taskType !== "cross_check") {
        // cross_check is automatic, not a staff to-do — its only output is the
        // advisory assessment sent above; never nag "please action" for it.
        const dueAt = new Date(task.due_at as string);
        const overdueByMs = now.getTime() - dueAt.getTime();
        const overdueByDays = overdueByMs / (1000 * 60 * 60 * 24);

        if (task.reminder_sent === false) {
          await notifyStaffTaskOverdue({
            id: task.id as string,
            client_id: clientId,
            type: taskType,
            due_at: task.due_at as string,
            assigned_to: task.assigned_to as string,
          });
          await supabaseAdmin
            .from("tasks")
            .update({ reminder_sent: true, updated_at: now.toISOString() })
            .eq("id", task.id);
        }

        if (overdueByDays > 3) {
          await supabaseAdmin
            .from("tasks")
            .update({ status: "overdue", updated_at: now.toISOString() })
            .eq("id", task.id);

          const newRow = await createNotification({
            type: "overdue_task",
            title: `Overdue task: ${taskType}`,
            message: `Task "${taskType}" for client ${clientId} is overdue by ${Math.floor(overdueByDays)} days.`,
            severity: "urgent",
            client_id: clientId,
            task_id: task.id as string,
            reference_key: `overdue:${task.id}`,
          });

          if (newRow) {
            await sendOverdueAlert({
              id: task.id as string,
              client_id: clientId,
              type: taskType,
              assigned_to: task.assigned_to as string,
            });
          }
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
      await notifyStaffSummaryReady(meeting.id as string);
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
    .select("id, full_name, last_service_date, assigned_handler_id, assigned_to")
    .eq("status", "active")
    .or(`last_service_date.is.null,last_service_date.lte.${twoYearsAgoStr}`);

  if (error) {
    logger.error({ error }, "checkServiceMeetingEligibility: query failed");
    return;
  }

  for (const client of clients ?? []) {
    try {
      const newRow = await createNotification({
        type: "service_due",
        title: "Annual service meeting due",
        message: `Client ${client.id} is due for a service meeting (last service: ${client.last_service_date ?? "never"}).`,
        severity: "warning",
        client_id: client.id as string,
        reference_key: `service_due:${client.id}:${currentYear}`,
      });

      if (newRow) {
        await sendServiceDueInvite({
          id: client.id as string,
          full_name: client.full_name as string | null,
          assigned_handler_id: client.assigned_handler_id as string | null,
          assigned_to: client.assigned_to as string | null,
        });
      }
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
      const newRow = await createNotification({
        type: "sla_breach",
        title: "SLA breach detected",
        message: `Client ${client.full_name ?? client.id} has breached SLA in stage "${client.derived_stage}".`,
        severity: "urgent",
        client_id: client.id as string,
        reference_key: `sla_breach:${client.id}:${today}`,
      });

      if (newRow) {
        await sendSlaAlert({
          id: client.id as string,
          full_name: client.full_name as string | null,
          derived_stage: client.derived_stage as string | null,
        });
      }
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
