import express from "express";
import sampleRoutes from "./sampleRoutes.js";

const router = express.Router();

router.use("/sample", sampleRoutes);

export default router;