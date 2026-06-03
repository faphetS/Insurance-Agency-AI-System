import express from "express";
import whatsappRoutes from "../domains/whatsapp/whatsapp.routes.js";
import calendarRoutes from "../domains/calendar/calendar.routes.js";
import operationsRoutes from "../domains/operations/operations.routes.js";
import gmailRoutes from "../domains/integrations/gmail/gmail.routes.js";
import timelessRoutes from "../domains/integrations/timeless/timeless.routes.js";

const router = express.Router();

router.use("/whatsapp", whatsappRoutes);
router.use("/calendar", calendarRoutes);
router.use("/operations", operationsRoutes);
router.use("/integrations/gmail", gmailRoutes);
router.use("/integrations/timeless", timelessRoutes);

// Future domain routes:
// router.use("/policies", policyRoutes);
// router.use("/claims", claimRoutes);
// router.use("/customers", customerRoutes);
// router.use("/agents", agentRoutes);

export default router;
