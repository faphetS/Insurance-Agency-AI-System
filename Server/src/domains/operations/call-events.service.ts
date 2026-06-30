import { pool } from "../../lib/db.js";
import { logger } from "../../config/logger.js";
import type { ZadarmaCallRow } from "../zadarma/zadarma.validator.js";

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
      `SELECT counterpart_phone, MAX(called_at) AS called_at
FROM public.call_events
WHERE called_at >= $1 AND direction = 'incoming' AND status IN ('missed','declined')
GROUP BY counterpart_phone
ORDER BY called_at ASC`,
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
