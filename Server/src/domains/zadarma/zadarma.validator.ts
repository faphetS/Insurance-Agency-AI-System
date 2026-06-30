import { z } from "zod";

export const zadarmaWebhookSchema = z
  .object({
    event: z.string().optional(),
    call_start: z.string().optional(),
    pbx_call_id: z.string().optional(),
    caller_id: z.string().optional(),
    called_did: z.string().optional(),
    destination: z.string().optional(),
    duration: z.string().optional(),
    status_code: z.string().optional(),
    is_recorded: z.string().optional(),
    calltype: z.string().optional(),
    disposition: z.string().optional(),
  })
  .passthrough();

export type ZadarmaWebhookBody = z.infer<typeof zadarmaWebhookSchema>;

export type ZadarmaCallRow = {
  id_message: string;
  id_instance: string;
  direction: "incoming" | "outgoing";
  counterpart_phone: string;
  status: "accepted" | "missed";
  is_video: boolean;
  called_at: Date;
};

/**
 * Normalise a raw phone string to E.164 digits (no + or @c.us).
 * Rules:
 *   1. Strip all non-digits.
 *   2. Leading "00" → strip the "00".
 *   3. Leading single "0" → replace with "972".
 */
export function normalizePhone(raw: string): string {
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("00")) {
    digits = digits.slice(2);
  } else if (digits.startsWith("0")) {
    digits = "972" + digits.slice(1);
  }
  return digits;
}

function mapDisposition(disposition: string | undefined): "accepted" | "missed" {
  return disposition?.trim().toLowerCase() === "answered" ? "accepted" : "missed";
}

/**
 * Maps a parsed Zadarma end-event body to a call_events row.
 * Returns null when the event should be ignored (not an end-event, or missing pbx_call_id).
 *
 * `receivedAt` is the server-side timestamp captured when the HTTP request arrived.
 * We use it instead of `call_start` because NOTIFY_END fires in real time (at call end)
 * and call_start carries no timezone — using receipt time is TZ-proof.
 */
export function mapZadarmaEvent(body: ZadarmaWebhookBody, receivedAt: Date): ZadarmaCallRow | null {
  const { event, pbx_call_id, caller_id, called_did, destination, disposition } = body;

  if (event !== "NOTIFY_END" && event !== "NOTIFY_OUT_END") {
    return null;
  }

  if (!pbx_call_id) {
    return null;
  }

  const direction: "incoming" | "outgoing" = event === "NOTIFY_OUT_END" ? "outgoing" : "incoming";

  const rawPhone =
    direction === "outgoing"
      ? (destination ?? called_did ?? "")
      : (caller_id ?? "");

  const counterpart_phone = normalizePhone(rawPhone);

  if (!counterpart_phone) {
    return null;
  }

  const status = mapDisposition(disposition);

  return {
    id_message: pbx_call_id,
    id_instance: "zadarma",
    direction,
    counterpart_phone,
    status,
    is_video: false,
    called_at: receivedAt,
  };
}
