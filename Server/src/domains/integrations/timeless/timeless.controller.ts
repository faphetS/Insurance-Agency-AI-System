import type { Request, Response } from "express";
import { supabaseAdmin } from "../../../config/supabase.js";
import { logger } from "../../../config/logger.js";
import {
  getStatus,
  ingestTimelessMeeting,
  linkUnmatched,
  recordEvent,
  verifySignature,
} from "./timeless.service.js";
import type { TimelessWebhookPayload } from "./timeless.types.js";

export const timelessController = {
  async webhook(req: Request, res: Response): Promise<void> {
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    const signature = req.headers["x-webhook-signature"] as string | undefined;

    await verifySignature(rawBody, signature);

    const payload = req.body as TimelessWebhookPayload;

    logger.info({ meetingId: payload.id, event: payload.event }, "timeless: webhook received");

    res.status(200).json({ status: "ok" });

    await recordEvent();

    // Defensive: the docs put the meeting id at the top-level `id`, but if a delivery ever
    // arrives without it (different envelope), do NOT ingest — getMeeting(undefined) would
    // fall through to "list all → first meeting" and ingest the wrong one. The hourly poll
    // backstops by re-ingesting any completed meeting regardless of webhook shape.
    if (!payload.id) {
      logger.warn(
        { payloadKeys: Object.keys(payload ?? {}), event: payload.event },
        "timeless: webhook missing top-level meeting id — skipping ingest (poll will backstop)",
      );
      return;
    }

    ingestTimelessMeeting(payload.id, payload.event).catch((err: unknown) =>
      logger.error({ err, meetingId: payload.id }, "timeless: ingest failed"),
    );
  },

  async status(_req: Request, res: Response): Promise<void> {
    const data = await getStatus();
    res.json({ status: "success", data });
  },

  async listUnmatched(_req: Request, res: Response): Promise<void> {
    const { data, error } = await supabaseAdmin
      .from("timeless_unmatched_meetings")
      .select("*")
      .is("resolved_at", null)
      .order("created_at", { ascending: false });

    if (error) {
      logger.error({ error }, "timeless.listUnmatched: query failed");
      res.status(500).json({ status: "error", message: "Failed to fetch unmatched meetings" });
      return;
    }

    res.json({ status: "success", data: data ?? [] });
  },

  async linkUnmatched(req: Request, res: Response): Promise<void> {
    const { id } = req.params as { id: string };
    const { meeting_id } = req.body as { meeting_id: string };

    await linkUnmatched(id, meeting_id);
    res.json({ status: "success" });
  },
};
