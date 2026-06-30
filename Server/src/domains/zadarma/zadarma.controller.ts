import type { Request, Response } from "express";
import { logger } from "../../config/logger.js";
import { recordZadarmaCallEvent } from "../operations/call-events.service.js";
import { zadarmaWebhookSchema, mapZadarmaEvent } from "./zadarma.validator.js";

// TODO(zadarma): signature/source-IP verification to reject forged webhook POSTs is a
// separate next step — implement before going live in production.

export const zadarmaController = {
  /**
   * GET /api/zadarma/call-webhook
   * Zadarma URL verification handshake: when the notification URL is saved in the Zadarma
   * panel, Zadarma sends GET ?zd_echo=<token>. The response body must be that exact token as
   * text/plain with no wrapper or extra characters, or Zadarma refuses to save the URL.
   * A bare GET without the param (e.g. health-check) returns 200 JSON.
   */
  handleVerification(req: Request, res: Response): void {
    // req.query is getter-only in Express 5 — read only, never reassign
    const echo = req.query["zd_echo"];
    if (typeof echo === "string") {
      res.type("text/plain").send(echo);
      return;
    }
    res.status(200).json({ ok: true });
  },

  /**
   * POST /api/zadarma/call-webhook
   * Unauthenticated — Zadarma pushes call-end events here.
   * Always responds 200 quickly to prevent Zadarma retry storms.
   */
  async handleCallWebhook(req: Request, res: Response): Promise<void> {
    // Some Zadarma setups re-verify on the POST path — handle it defensively.
    const echo = req.query["zd_echo"];
    if (typeof echo === "string") {
      res.type("text/plain").send(echo);
      return;
    }

    res.status(200).json({ ok: true });

    try {
      const parsed = zadarmaWebhookSchema.safeParse(req.body);
      if (!parsed.success) {
        logger.warn({ errors: parsed.error.errors }, "zadarma webhook: parse failed — ignoring");
        return;
      }

      const row = mapZadarmaEvent(parsed.data);
      if (!row) {
        logger.debug({ event: parsed.data.event }, "zadarma webhook: ignored event");
        return;
      }

      await recordZadarmaCallEvent(row);
    } catch (err) {
      logger.warn({ err }, "zadarma webhook: unexpected error — swallowed");
    }
  },
};
