import type { Request, Response } from "express";
import { supabaseAdmin } from "../../config/supabase.js";
import { NotFoundError } from "../../lib/errors.js";
import {
  createTaskChain,
  completeTask,
  getDashboard,
  getNotifications,
  getUnreadCount,
  markAllAsRead,
  markAsRead,
} from "./operations.service.js";
import { runAllChecks } from "./operations.checker.js";
import type { NotificationFilters, NotificationType, NotificationSeverity } from "./operations.types.js";

export const operationsController = {
  async listNotifications(req: Request, res: Response): Promise<void> {
    const query = req.query as Record<string, string | undefined>;
    const filters: NotificationFilters = {
      type: query.type as NotificationType | undefined,
      severity: query.severity as NotificationSeverity | undefined,
      is_read: query.is_read !== undefined ? query.is_read === "true" : undefined,
      client_id: query.client_id,
      page: query.page !== undefined ? Number(query.page) : undefined,
      limit: query.limit !== undefined ? Number(query.limit) : undefined,
    };
    const result = await getNotifications(filters);
    res.json({ status: "success", data: result });
  },

  async getUnreadCount(_req: Request, res: Response): Promise<void> {
    const count = await getUnreadCount();
    res.json({ status: "success", data: { count } });
  },

  async markRead(req: Request, res: Response): Promise<void> {
    const { id } = req.params as { id: string };
    await markAsRead(id);
    res.json({ status: "success" });
  },

  async markAllRead(_req: Request, res: Response): Promise<void> {
    await markAllAsRead();
    res.json({ status: "success" });
  },

  async approveSummary(req: Request, res: Response): Promise<void> {
    const { meetingId } = req.params as { meetingId: string };
    const { finalText } = req.body as { finalText?: string };

    const { data: meeting, error } = await supabaseAdmin
      .from("meetings")
      .update({
        summary_status: "approved",
        ...(finalText !== undefined && { summary_final: finalText }),
      })
      .eq("id", meetingId)
      .select("id")
      .single();

    if (error || !meeting) {
      throw new NotFoundError("Meeting");
    }

    await createTaskChain(meetingId);
    res.json({ status: "success" });
  },

  async completeTask(req: Request, res: Response): Promise<void> {
    const { taskId } = req.params as { taskId: string };
    await completeTask(taskId);
    res.json({ status: "success" });
  },

  async triggerCheck(_req: Request, res: Response): Promise<void> {
    await runAllChecks();
    res.json({ status: "success", message: "All checks completed" });
  },

  async getDashboard(_req: Request, res: Response): Promise<void> {
    const data = await getDashboard();
    res.json({ status: "success", data });
  },
};
