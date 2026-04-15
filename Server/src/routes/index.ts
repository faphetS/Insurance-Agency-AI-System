import express from "express";
import authRoutes from "../domains/auth/auth.routes.js";
import whatsappRoutes from "../domains/whatsapp/whatsapp.routes.js";

const router = express.Router();

router.use("/auth", authRoutes);
router.use("/whatsapp", whatsappRoutes);

// Future domain routes:
// router.use("/policies", policyRoutes);
// router.use("/claims", claimRoutes);
// router.use("/customers", customerRoutes);
// router.use("/agents", agentRoutes);

export default router;
