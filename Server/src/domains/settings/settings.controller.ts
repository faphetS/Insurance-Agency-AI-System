import type { Request, Response } from "express";
import { logger } from "../../config/logger.js";
import {
  clearTemporary,
  deleteMessage,
  getAutoReplyState,
  parseUntil,
  restoreOriginal,
  saveMessage,
  useMessage,
} from "../operations/unanswered-wa.settings.js";
import type { MessageIdParams, SaveMessageBody, UseMessageBody } from "./settings.validator.js";

export const settingsController = {
  async getAutoReply(_req: Request, res: Response): Promise<void> {
    res.json({ status: "success", state: await getAutoReplyState(new Date()) });
  },

  async createMessage(req: Request, res: Response): Promise<void> {
    const { text } = req.body as SaveMessageBody;
    const id = await saveMessage(text);
    logger.info({ id, text }, "settings: auto-reply message saved");
    res.json({ status: "success", id, state: await getAutoReplyState(new Date()) });
  },

  async removeMessage(req: Request, res: Response): Promise<void> {
    const { id } = req.params as MessageIdParams;
    await deleteMessage(id);
    logger.info({ id }, "settings: auto-reply message deleted");
    res.json({ status: "success", state: await getAutoReplyState(new Date()) });
  },

  async applyMessage(req: Request, res: Response): Promise<void> {
    const body = req.body as UseMessageBody;

    if (body.mode === "permanent") {
      await useMessage(body.messageId, "permanent");
      logger.info(
        { messageId: body.messageId, mode: "permanent" },
        "settings: auto-reply message set as permanent",
      );
    } else {
      const until = parseUntil(body.until, new Date());
      await useMessage(body.messageId, "temporary", until);
      logger.info(
        { messageId: body.messageId, mode: "temporary", until: until.toISOString() },
        "settings: auto-reply message set as temporary",
      );
    }

    res.json({ status: "success", state: await getAutoReplyState(new Date()) });
  },

  async cancelTemporary(_req: Request, res: Response): Promise<void> {
    await clearTemporary();
    logger.info("settings: temporary auto-reply cleared");
    res.json({ status: "success", state: await getAutoReplyState(new Date()) });
  },

  async restoreOriginalMessage(_req: Request, res: Response): Promise<void> {
    await restoreOriginal();
    logger.info("settings: original auto-reply message restored");
    res.json({ status: "success", state: await getAutoReplyState(new Date()) });
  },
};
