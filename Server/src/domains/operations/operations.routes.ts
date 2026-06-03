import express from "express";
import { authenticate, authorize } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import {
  notificationListSchema,
  notificationIdSchema,
  approveSummarySchema,
  completeTaskSchema,
  scanWhatsappSchema,
  scanWhatsappDaySchema,
} from "./operations.validator.js";
import { operationsController } from "./operations.controller.js";

const router = express.Router();

router.use(authenticate, authorize("owner", "admin"));

router.get(
  "/notifications",
  validate({ query: notificationListSchema }),
  operationsController.listNotifications,
);

router.get(
  "/notifications/unread-count",
  operationsController.getUnreadCount,
);

router.patch(
  "/notifications/:id/read",
  validate({ params: notificationIdSchema }),
  operationsController.markRead,
);

router.patch(
  "/notifications/read-all",
  operationsController.markAllRead,
);

router.post(
  "/approve-summary/:meetingId",
  validate({ params: approveSummarySchema.params, body: approveSummarySchema.body }),
  operationsController.approveSummary,
);

router.post(
  "/complete-task/:taskId",
  validate({ params: completeTaskSchema }),
  operationsController.completeTask,
);

router.post(
  "/trigger-check",
  operationsController.triggerCheck,
);

router.post(
  "/trigger-digest",
  operationsController.triggerDigest,
);

router.get(
  "/dashboard",
  operationsController.getDashboard,
);

router.get(
  "/email-monitoring",
  operationsController.getEmailMonitoring,
);

router.get(
  "/whatsapp-monitoring",
  operationsController.getWhatsappMonitoring,
);

router.get(
  "/service-meetings",
  operationsController.getServiceMeetings,
);

router.post(
  "/scan-whatsapp",
  validate({ body: scanWhatsappSchema }),
  operationsController.scanWhatsapp,
);

router.post(
  "/scan-whatsapp-day",
  validate({ body: scanWhatsappDaySchema }),
  operationsController.scanWhatsappDay,
);

export default router;
