import express from "express";
import { authenticate, authorize } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { whatsappController } from "./whatsapp.controller.js";
import { metaWebhookController } from "./meta/meta.webhook.controller.js";
import { sendMessageSchema } from "./whatsapp.validator.js";

const router = express.Router();

// Unauthenticated — token verified inside the controller
router.post("/webhook", whatsappController.handleWebhook);

// Unauthenticated — Meta Cloud API webhook (GET = hub.challenge handshake,
// POST = X-Hub-Signature-256 verified inside the controller)
router.get("/meta-webhook", metaWebhookController.verifyWebhook);
router.post("/meta-webhook", metaWebhookController.handleWebhook);

// Admin-only routes
router.patch(
  "/conversations/:id/bot-pause",
  authenticate,
  authorize("admin"),
  whatsappController.setBotPause,
);
router.post(
  "/send",
  authenticate,
  authorize("admin"),
  validate({ body: sendMessageSchema }),
  whatsappController.sendManual,
);

export default router;
