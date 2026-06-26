import { pool } from "../../lib/db.js";
import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../config/logger.js";

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

export interface CallEventRow {
  counterpart_phone: string;
  called_at: string;
}

export async function getMissedDeclinedSince(iso: string): Promise<CallEventRow[]> {
  const { data, error } = await supabaseAdmin
    .from("call_events")
    .select("counterpart_phone, called_at")
    .eq("direction", "incoming")
    .in("status", ["missed", "declined"])
    .gte("called_at", iso)
    .order("called_at", { ascending: true });

  if (error) {
    logger.error({ error }, "getMissedDeclinedSince: query failed");
    return [];
  }

  return (data ?? []) as CallEventRow[];
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
