import express from "express";
import { authenticate, authorize } from "../../middleware/auth.js";
import { operationsController } from "./operations.controller.js";

const router = express.Router();

router.post(
  "/call-reminder/run",
  authenticate,
  authorize("admin"),
  operationsController.runCallReminder,
);

router.post(
  "/commitments/run",
  authenticate,
  authorize("admin"),
  operationsController.runCommitments,
);

export default router;
