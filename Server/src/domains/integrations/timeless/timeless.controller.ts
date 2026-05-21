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
    const rawBody = req.body as Buffer;
    const signature = req.headers["x-webhook-signature"] as string | undefined;

    await verifySignature(rawBody, signature);

    const payload = JSON.parse(rawBody.toString("utf-8")) as TimelessWebhookPayload;

    logger.info({ event: payload.event, meetingId: payload.meeting_id }, "timeless: webhook received");

    res.status(200).json({ status: "ok" });

    if (
      payload.event === "meeting.transcript_ready" ||
      payload.event === "meeting.initial_summary_ready"
    ) {
      await recordEvent();
      ingestTimelessMeeting(payload.meeting_id).catch((err: unknown) =>
        logger.error({ err, meetingId: payload.meeting_id }, "timeless: ingest failed"),
      );
    }
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
