import type { Request, Response } from "express";
import { authService } from "./auth.service.js";

export const authController = {
  async register(req: Request, res: Response) {
    const result = await authService.register(req.body);
    res.status(201).json({ status: "success", data: result });
  },

  async login(req: Request, res: Response) {
    const result = await authService.login(req.body);
    res.json({ status: "success", data: result });
  },

  async logout(_req: Request, res: Response) {
    // Client-side token discard — server is stateless with JWTs
    res.json({ status: "success", message: "Logged out" });
  },

  async refresh(req: Request, res: Response) {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ status: "error", message: "Not authenticated" });
      return;
    }
    const result = await authService.refresh(userId);
    res.json({ status: "success", data: result });
  },
};
