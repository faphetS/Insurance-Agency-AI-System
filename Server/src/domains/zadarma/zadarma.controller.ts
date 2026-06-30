import type { Request, Response } from "express";
import { logger } from "../../config/logger.js";
import { recordZadarmaCallEvent } from "../operations/call-events.service.js";
import { zadarmaWebhookSchema, mapZadarmaEvent } from "./zadarma.validator.js";

// Zadarma's documented webhook source block: 185.45.152.40/30 (.40–.43).
// All values kept as signed 32-bit integers (JS bitwise ops are always signed 32-bit)
// so the range comparison is consistent.
const ZADARMA_IP_START = (185 << 24) | (45 << 16) | (152 << 8) | 40;
const ZADARMA_IP_END   = (185 << 24) | (45 << 16) | (152 << 8) | 43;

function ipToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    const byte = parseInt(part, 10);
    if (isNaN(byte) || byte < 0 || byte > 255) return null;
    n = (n << 8) | byte;
  }
  // Return raw signed 32-bit result — must match the sign of the constants above.
  return n;
}

function stripV4Mapped(ip: string): string {
  return ip.replace(/^::ffff:/i, "").trim();
}

/**
 * Resolve the real client IP from the request.
 * We are behind nginx which sets x-real-ip to the true peer.
 * Fallback: last entry of x-forwarded-for (avoids the client-spoofable first entry).
 * We do NOT trust req.ip or req.socket.remoteAddress because nginx is the socket peer.
 * IPv4-mapped IPv6 addresses (::ffff:x.x.x.x) are normalised to plain IPv4.
 */
function resolveClientIp(req: Request): string | null {
  const realIp = req.headers["x-real-ip"];
  if (typeof realIp === "string" && realIp.trim()) {
    return stripV4Mapped(realIp.trim());
  }
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    const parts = forwarded.split(",");
    const last = parts[parts.length - 1]?.trim();
    return last ? stripV4Mapped(last) : null;
  }
  return null;
}

function isZadarmaIp(ip: string): boolean {
  const n = ipToInt(ip);
  if (n === null) return false;
  return n >= ZADARMA_IP_START && n <= ZADARMA_IP_END;
}

export const zadarmaController = {
  /**
   * GET /api/zadarma/call-webhook
   * Zadarma URL verification handshake: when the notification URL is saved in the Zadarma
   * panel, Zadarma sends GET ?zd_echo=<token>. The response body must be that exact token as
   * text/plain with no wrapper or extra characters, or Zadarma refuses to save the URL.
   * This path is intentionally open (no IP gate) — it only echoes a token and writes nothing.
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
   * Zadarma pushes call-end events here.
   * IP-locked to 185.45.152.40/30 (Zadarma's documented webhook source block).
   * The GET zd_echo handshake is on the GET route and is open; this POST path
   * only handles call events and must reject non-Zadarma sources.
   *
   * TODO(zadarma): add request-signature verification once Zadarma documents
   * a signing scheme, for defence-in-depth beyond IP filtering.
   */
  async handleCallWebhook(req: Request, res: Response): Promise<void> {
    // Capture receipt time immediately — used as called_at (TZ-proof: NOTIFY_END
    // fires in real time, and call_start carries no timezone info).
    const receivedAt = new Date();

    // Some Zadarma setups re-verify on the POST path — echo before the IP gate
    // so Zadarma's verification request always succeeds regardless of source IP.
    const echo = req.query["zd_echo"];
    if (typeof echo === "string") {
      res.type("text/plain").send(echo);
      return;
    }

    // IP gate — only Zadarma's documented source block may record call events.
    const clientIp = resolveClientIp(req);
    if (!clientIp || !isZadarmaIp(clientIp)) {
      logger.warn({ clientIp }, "zadarma webhook: request not from Zadarma IP block — rejecting");
      res.status(403).json({ ok: false });
      return;
    }

    res.status(200).json({ ok: true });

    try {
      const parsed = zadarmaWebhookSchema.safeParse(req.body);
      if (!parsed.success) {
        logger.warn({ errors: parsed.error.errors }, "zadarma webhook: parse failed — ignoring");
        return;
      }

      const row = mapZadarmaEvent(parsed.data, receivedAt);
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

export { isZadarmaIp, resolveClientIp };
