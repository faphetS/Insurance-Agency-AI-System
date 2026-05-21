import express from "express";
import { authenticate, authorize } from "../../../middleware/auth.js";
import { validate } from "../../../middleware/validate.js";
import { z } from "zod";
import { timelessController } from "./timeless.controller.js";

const router = express.Router();

// Raw body required for HMAC signature verification — mounted before the global
// express.json() parser processes this route via per-route middleware override.
router.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  timelessController.webhook,
);

router.get("/status", authenticate, timelessController.status);

router.get("/unmatched", authenticate, authorize("admin"), timelessController.listUnmatched);

router.post(
  "/unmatched/:id/link",
  authenticate,
  authorize("admin"),
  validate({ body: z.object({ meeting_id: z.string().uuid() }) }),
  timelessController.linkUnmatched,
);

export default router;
