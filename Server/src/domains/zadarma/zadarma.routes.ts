import express from "express";
import { zadarmaController } from "./zadarma.controller.js";

const router = express.Router();

// Unauthenticated — Zadarma does not send a bearer token
router.get("/call-webhook", zadarmaController.handleVerification);
router.post("/call-webhook", zadarmaController.handleCallWebhook);

export default router;
