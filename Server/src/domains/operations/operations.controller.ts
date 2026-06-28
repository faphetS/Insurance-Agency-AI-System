import type { Request, Response } from "express";
import { logger } from "../../config/logger.js";
import { sendDailyCallReminder } from "./call-reminder.service.js";

export const operationsController = {
  async runCallReminder(_req: Request, res: Response): Promise<void> {
    logger.info("operations: manual call-reminder trigger");
    await sendDailyCallReminder();
    res.json({ status: "success" });
  },
};
