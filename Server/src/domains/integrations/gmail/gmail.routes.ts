import express from "express";
import { authenticate } from "../../../middleware/auth.js";
import { gmailController } from "./gmail.controller.js";

const router = express.Router();

router.get("/authorize", authenticate, gmailController.authorize);
router.get("/callback", gmailController.callback);
router.get("/status", authenticate, gmailController.status);

export default router;
