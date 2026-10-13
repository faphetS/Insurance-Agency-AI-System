import express from "express";
import { authenticateSettings } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { settingsController } from "./settings.controller.js";
import {
  messageIdParamsSchema,
  saveMessageSchema,
  useMessageSchema,
} from "./settings.validator.js";

const router = express.Router();

// Router-level so every settings route is gated before any validation runs.
router.use(authenticateSettings);

router.get("/auto-reply", settingsController.getAutoReply);

router.post(
  "/auto-reply/messages",
  validate({ body: saveMessageSchema }),
  settingsController.createMessage,
);

router.delete(
  "/auto-reply/messages/:id",
  validate({ params: messageIdParamsSchema }),
  settingsController.removeMessage,
);

router.post(
  "/auto-reply/use",
  validate({ body: useMessageSchema }),
  settingsController.applyMessage,
);

router.delete("/auto-reply/temporary", settingsController.cancelTemporary);

router.post("/auto-reply/original/restore", settingsController.restoreOriginalMessage);

export default router;
