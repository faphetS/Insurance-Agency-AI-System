import express from "express";
import authRoutes from "../domains/auth/auth.routes.js";
import whatsappRoutes from "../domains/whatsapp/whatsapp.routes.js";
import calendarRoutes from "../domains/calendar/calendar.routes.js";
import operationsRoutes from "../domains/operations/operations.routes.js";

const router = express.Router();

router.use("/auth", authRoutes);
router.use("/whatsapp", whatsappRoutes);
router.use("/calendar", calendarRoutes);
router.use("/operations", operationsRoutes);

// Future domain routes:
// router.use("/policies", policyRoutes);
// router.use("/claims", claimRoutes);
// router.use("/customers", customerRoutes);
// router.use("/agents", agentRoutes);

export default router;
