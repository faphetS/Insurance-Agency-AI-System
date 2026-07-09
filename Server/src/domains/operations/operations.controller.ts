import type { Request, Response } from "express";
import { logger } from "../../config/logger.js";
import { sendDailyCallReminder } from "./call-reminder.service.js";
import { runMorningCommitments } from "../commitments/commitments.service.js";
import { sendMorningDigest } from "./morning-digest.service.js";
import { runStaffEmailNotify } from "./email-mentions.service.js";
import { sweepUnanswered, sendUnansweredFollowups } from "./unanswered-wa.service.js";

export const operationsController = {
  async runCallReminder(_req: Request, res: Response): Promise<void> {
    logger.info("operations: manual call-reminder trigger");
    await sendDailyCallReminder();
    res.json({ status: "success" });
  },

  async runCommitments(_req: Request, res: Response): Promise<void> {
    logger.info("operations: manual commitments trigger");
    await runMorningCommitments();
    res.json({ status: "success" });
  },

  async runMorningDigest(_req: Request, res: Response): Promise<void> {
    logger.info("operations: manual morning-digest trigger");
    await sendMorningDigest();
    res.json({ status: "success" });
  },

  async runEmailMentions(_req: Request, res: Response): Promise<void> {
    logger.info("operations: manual email-mentions trigger");
    const counts = await runStaffEmailNotify();
    res.json({ status: "success", ...counts });
  },

  async runUnanswered(_req: Request, res: Response): Promise<void> {
    logger.info("operations: manual unanswered-wa trigger");
    const sweep = await sweepUnanswered();
    const followups = await sendUnansweredFollowups();
    res.json({ status: "success", sweep, followups });
  },
};
