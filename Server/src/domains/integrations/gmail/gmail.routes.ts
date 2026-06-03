import express from "express";
import { authenticate } from "../../../middleware/auth.js";
import { validate } from "../../../middleware/validate.js";
import { gmailController } from "./gmail.controller.js";
import { scanGmailSchema } from "./gmail.validator.js";

const router = express.Router();

router.get("/authorize", authenticate, gmailController.authorize);
router.get("/callback", gmailController.callback);
router.get("/status", authenticate, gmailController.status);
router.get(
  "/scan",
  authenticate,
  validate({ query: scanGmailSchema }),
  gmailController.scan,
);

export default router;
