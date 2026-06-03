import type { Request, Response } from "express";
import { env } from "../../../config/env.js";
import { logger } from "../../../config/logger.js";
import { AppError } from "../../../lib/errors.js";
import { supabaseAdmin } from "../../../config/supabase.js";
import {
  getAuthorizationUrl,
  handleCallback,
  getGmailStatus,
  fetchMessages,
} from "./gmail.service.js";
import type { ScanGmailQuery } from "./gmail.validator.js";

const BODY_PREVIEW_LENGTH = 1500;

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

  async scan(req: Request, res: Response): Promise<void> {
    const { q, limit, staffId: queryStaffId } = req.query as unknown as ScanGmailQuery;

    let resolvedStaffId = queryStaffId;

    if (!resolvedStaffId) {
      const { data: firstRow } = await supabaseAdmin
        .from("gmail_integrations")
        .select("staff_id")
        .eq("is_active", true)
        .limit(1)
        .maybeSingle();

      if (!firstRow) {
        throw new AppError(404, "No active Gmail integration found", "GMAIL_NOT_FOUND");
      }
      resolvedStaffId = firstRow.staff_id as string;
    }

    logger.info({ staffId: resolvedStaffId, q, limit }, "gmail.scan: starting");

    const emails = await fetchMessages(resolvedStaffId, {
      q: q ?? "newer_than:30d",
      maxResults: limit,
    });

    const truncated = emails.map((email) => ({
      ...email,
      bodyText:
        email.bodyText.length > BODY_PREVIEW_LENGTH
          ? email.bodyText.slice(0, BODY_PREVIEW_LENGTH) + "…"
          : email.bodyText,
    }));

    res.json({
      status: "success",
      data: {
        count: truncated.length,
        emails: truncated,
      },
    });
  },
};
