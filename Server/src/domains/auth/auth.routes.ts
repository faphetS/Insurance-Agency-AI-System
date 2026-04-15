import express from "express";
import { authController } from "./auth.controller.js";
import { authenticate } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { loginSchema, registerSchema } from "./auth.validator.js";

const router = express.Router();

router.post("/register", validate({ body: registerSchema }), authController.register);
router.post("/login", validate({ body: loginSchema }), authController.login);
router.post("/logout", authController.logout);
router.post("/refresh", authenticate, authController.refresh);

export default router;
