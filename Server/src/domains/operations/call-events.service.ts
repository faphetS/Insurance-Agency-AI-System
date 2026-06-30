import { pool } from "../../lib/db.js";
import { logger } from "../../config/logger.js";
import type { ZadarmaCallRow } from "../zadarma/zadarma.validator.js";

type CallStatus = "ringing" | "accepted" | "declined" | "missed";
type CallDirection = "incoming" | "outgoing";

function mapStatus(raw: string): CallStatus | null {
  switch (raw) {
    case "offer":
      return "ringing";
    case "pickUp":
      return "accepted";
    case "hangUp":
      return "declined";
    case "declined":
      return "missed";
    default:
      return null;
  }
}

export async function recordCallEvent(rawBody: Record<string, unknown>): Promise<void> {
  try {
    const typeWebhook = rawBody.typeWebhook as string | undefined;
    const idMessage = rawBody.idMessage as string | undefined;
    const instanceData = rawBody.instanceData as Record<string, unknown> | undefined;
    const idInstance = instanceData?.idInstance != null ? String(instanceData.idInstance) : undefined;
    const from = rawBody.from as string | undefined;
    const statusRaw = rawBody.status as string | undefined;
    const isVideo = (rawBody.isVideo as boolean | undefined) ?? false;
    const timestampRaw = rawBody.timestamp;

    if (!idMessage) {
      logger.warn({ typeWebhook }, "recordCallEvent: missing idMessage — skipping");
      return;
    }

    const mappedStatus = statusRaw != null ? mapStatus(statusRaw) : null;
    if (mappedStatus === null) {
      logger.debug({ typeWebhook, statusRaw, idMessage }, "recordCallEvent: unmappable status — skipping");
      return;
    }

    const direction: CallDirection = typeWebhook === "outgoingCall" ? "outgoing" : "incoming";

    let counterpartPhone: string;
    if (direction === "outgoing") {
      const participants = rawBody.participants as Array<{ id?: string }> | undefined;
      counterpartPhone = participants?.[0]?.id ?? from ?? "";
    } else {
      counterpartPhone = from ?? "";
    }

    const calledAt = new Date(Number(timestampRaw) * 1000).toISOString();

    await pool.query(
      `INSERT INTO public.call_events
         (id_message, id_instance, direction, counterpart_phone, status, is_video, called_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id_message) DO UPDATE SET
         status = EXCLUDED.status,
         updated_at = now()`,
      [idMessage, idInstance ?? null, direction, counterpartPhone, mappedStatus, isVideo, calledAt],
    );

    logger.info({ idMessage, direction, status: mappedStatus, counterpartPhone }, "call event recorded");
  } catch (err) {
    logger.error({ err }, "recordCallEvent: unexpected error — swallowed");
  }
}

export async function recordZadarmaCallEvent(row: ZadarmaCallRow): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO public.call_events
         (id_message, id_instance, direction, counterpart_phone, status, is_video, called_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id_message) DO UPDATE SET
         status = EXCLUDED.status,
         updated_at = now()`,
      [
        row.id_message,
        row.id_instance,
        row.direction,
        row.counterpart_phone,
        row.status,
        row.is_video,
        row.called_at.toISOString(),
      ],
    );
    logger.info(
      { idMessage: row.id_message, direction: row.direction, status: row.status, counterpartPhone: row.counterpart_phone },
      "zadarma call event recorded",
    );
  } catch (err) {
    logger.error({ err }, "recordZadarmaCallEvent: unexpected error — swallowed");
  }
}

export interface CallEventRow {
  counterpart_phone: string;
  called_at: string;
}

export async function getUnresolvedMissedSince(iso: string): Promise<CallEventRow[]> {
  try {
    const result = await pool.query<{ counterpart_phone: string; called_at: unknown }>(
      `SELECT m.counterpart_phone, m.last_miss AS called_at
FROM (
  SELECT counterpart_phone, MAX(called_at) AS last_miss
  FROM public.call_events
  WHERE called_at >= $1 AND direction = 'incoming' AND status IN ('missed','declined')
  GROUP BY counterpart_phone
) m
LEFT JOIN (
  SELECT regexp_replace(counterpart_phone,'\\D','','g') AS norm, MAX(called_at) AS last_accept
  FROM public.call_events
  WHERE called_at >= $1 AND status = 'accepted'
  GROUP BY 1
) a ON a.norm = regexp_replace(m.counterpart_phone,'\\D','','g')
WHERE a.last_accept IS NULL OR a.last_accept < m.last_miss
ORDER BY m.last_miss ASC`,
      [iso],
    );
    return result.rows.map((r) => ({
      counterpart_phone: r.counterpart_phone,
      called_at: r.called_at instanceof Date ? r.called_at.toISOString() : String(r.called_at),
    }));
  } catch (err) {
    logger.error({ err }, "getUnresolvedMissedSince: query failed");
    return [];
  }
}

export async function pruneCallsOlderThan(iso: string): Promise<void> {
  try {
    await pool.query(
      `DELETE FROM public.call_events WHERE called_at < $1`,
      [iso],
    );
    logger.info({ before: iso }, "call_events pruned");
  } catch (err) {
    logger.error({ err }, "pruneCallsOlderThan: unexpected error — swallowed");
  }
}
