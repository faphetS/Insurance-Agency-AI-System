import type { Request, Response } from "express";
import {
  completeTask,
  finalizeSummary,
  getDashboard,
  getEmailMonitoring,
  getNotifications,
  getServiceMeetings,
  getUnreadCount,
  getWhatsappMonitoring,
  markAllAsRead,
  markAsRead,
} from "./operations.service.js";
import { runAllChecks } from "./operations.checker.js";
import type { NotificationFilters, NotificationType, NotificationSeverity } from "./operations.types.js";
import { scanCreds } from "../whatsapp/whatsapp.service.js";

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

    await finalizeSummary(meetingId, finalText);
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

  async triggerDigest(_req: Request, res: Response): Promise<void> {
    const { runDailyDigest } = await import("./operations.digest.js");
    await runDailyDigest({ force: true });
    res.json({ status: "success", message: "Digest sent" });
  },

  async getDashboard(_req: Request, res: Response): Promise<void> {
    const data = await getDashboard();
    res.json({ status: "success", data });
  },

  async getEmailMonitoring(_req: Request, res: Response): Promise<void> {
    const data = await getEmailMonitoring();
    res.json({ status: "success", data });
  },

  async getWhatsappMonitoring(_req: Request, res: Response): Promise<void> {
    const data = await getWhatsappMonitoring();
    res.json({ status: "success", data });
  },

  async getServiceMeetings(_req: Request, res: Response): Promise<void> {
    const data = await getServiceMeetings();
    res.json({ status: "success", data });
  },

  async scanWhatsapp(req: Request, res: Response): Promise<void> {
    const creds = scanCreds();
    if (!creds) {
      res.status(503).json({ error: "scan instance not configured" });
      return;
    }
    const { chatId, thresholdHours, count } = req.body as {
      chatId: string;
      thresholdHours: number;
      count: number;
    };
    const { scanChatForUnanswered } = await import("./operations.whatsapp-scan.js");
    const result = await scanChatForUnanswered(creds, chatId, { thresholdHours, count });
    res.json({ status: "success", data: result });
  },

  async scanWhatsappDay(req: Request, res: Response): Promise<void> {
    const creds = scanCreds();
    if (!creds) {
      res.status(503).json({ error: "scan instance not configured" });
      return;
    }
    const { fromHour, tz, thresholdHours, windowMinutes } = req.body as {
      fromHour: number;
      tz: string;
      thresholdHours: number;
      windowMinutes?: number;
    };
    const { scanDayUnanswered } = await import("./operations.whatsapp-scan.js");
    const result = await scanDayUnanswered(creds, { fromHour, tz, thresholdHours, windowMinutes });
    res.json({ status: "success", data: result });
  },
};
