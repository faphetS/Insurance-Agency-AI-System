import express from "express";
import whatsappRoutes from "../domains/whatsapp/whatsapp.routes.js";
import chatwootRoutes from "../domains/chatwoot/chatwoot.routes.js";
import calendarRoutes from "../domains/calendar/calendar.routes.js";
import timelessRoutes from "../domains/integrations/timeless/timeless.routes.js";
import googleRoutes from "../domains/integrations/google/google.routes.js";
import operationsRoutes from "../domains/operations/operations.routes.js";
import zadarmaRoutes from "../domains/zadarma/zadarma.routes.js";

const router = express.Router();

router.use("/whatsapp", whatsappRoutes);
router.use("/chatwoot", chatwootRoutes);
router.use("/calendar", calendarRoutes);
router.use("/integrations/timeless", timelessRoutes);
router.use("/integrations/google", googleRoutes);
router.use("/operations", operationsRoutes);
router.use("/zadarma", zadarmaRoutes);

// Future domain routes:
// router.use("/policies", policyRoutes);
// router.use("/claims", claimRoutes);
// router.use("/customers", customerRoutes);
// router.use("/agents", agentRoutes);

export default router;
