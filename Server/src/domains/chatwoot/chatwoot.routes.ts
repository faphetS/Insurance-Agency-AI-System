import express from "express";
import { chatwootController } from "./chatwoot.controller.js";

const router = express.Router();

// Unauthenticated — Chatwoot webhooks are unsigned; the :secret path segment
// is the credential (verified timing-safe inside the controller).
router.post("/callback/:secret", chatwootController.handleCallback);

export default router;
