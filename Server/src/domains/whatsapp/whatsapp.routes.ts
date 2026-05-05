import express from "express";
import { authenticate, authorize } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { whatsappController } from "./whatsapp.controller.js";
import { sendMessageSchema } from "./whatsapp.validator.js";

const router = express.Router();

// Unauthenticated — token verified inside the controller
router.post("/webhook", whatsappController.handleWebhook);

// Admin-only routes
router.patch(
  "/conversations/:id/bot-pause",
  authenticate,
  authorize("admin"),
  whatsappController.setBotPause,
);
router.get("/state", authenticate, authorize("admin"), whatsappController.getState);
router.get("/qr", authenticate, authorize("admin"), whatsappController.getQrCode);
router.post(
  "/send",
  authenticate,
  authorize("admin"),
  validate({ body: sendMessageSchema }),
  whatsappController.sendManual,
);

export default router;
