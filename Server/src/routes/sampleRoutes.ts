import express from "express";
import { sample } from "../controllers/sample.controller.js";

const router = express.Router();

router.get("/message", sample);

export default router;