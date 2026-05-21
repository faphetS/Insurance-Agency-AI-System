import type { Request, Response } from "express";
import { env } from "../../../config/env.js";
import { logger } from "../../../config/logger.js";
import { AppError } from "../../../lib/errors.js";
import { supabaseAdmin } from "../../../config/supabase.js";
import {
  getAuthorizationUrl,
  handleCallback,
  getGmailStatus,
} from "./gmail.service.js";

export const gmailController = {
  async authorize(req: Request, res: Response): Promise<void> {
    const staffId = req.user!.id;
    const url = getAuthorizationUrl(staffId);
    res.redirect(url);
  },

  async callback(req: Request, res: Response): Promise<void> {
    const { code, state, error: oauthError } = req.query as Record<string, string | undefined>;

    if (oauthError) {
      logger.warn({ oauthError }, "gmail.callback: OAuth error from Google");
      res.redirect(`${env.FRONTEND_URL}/dashboard?gmail=error&reason=${encodeURIComponent(oauthError)}`);
      return;
    }

    if (!code || !state) {
      res.status(400).json({ status: "error", message: "Missing code or state parameter" });
      return;
    }

    // Validate state is an active staff_id to prevent CSRF
    const { data: staffRow } = await supabaseAdmin
      .from("staff")
      .select("id")
      .eq("id", state)
      .maybeSingle();

    if (!staffRow) {
      logger.warn({ state }, "gmail.callback: state does not match any staff id");
      throw new AppError(400, "Invalid state parameter", "INVALID_STATE");
    }

    await handleCallback(code, state);
    res.redirect(`${env.FRONTEND_URL}/dashboard?gmail=connected`);
  },

  async status(req: Request, res: Response): Promise<void> {
    const staffId = req.user!.id;
    const data = await getGmailStatus(staffId);
    res.json({ status: "success", data });
  },
};
