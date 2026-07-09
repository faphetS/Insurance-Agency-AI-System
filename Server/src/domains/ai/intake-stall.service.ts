import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../config/logger.js";
import { notifyOwner } from "../operations/owner-notify.js";
import { displayName } from "../whatsapp/whatsapp.util.js";
import { buildStallAlert } from "./intake-notify.service.js";

const STALL_MS = 3 * 60 * 60 * 1000;

interface StalledRow {
  id: string;
  phone: string;
  full_name: string | null;
  intake_current_slot: "consent" | "id_photo";
}

export async function checkIntakeStalls(): Promise<void> {
  const cutoff = new Date(Date.now() - STALL_MS).toISOString();

  const { data } = await supabaseAdmin
    .from("clients")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .select("id, phone, full_name, intake_current_slot" as any)
    .eq("intake_state", "collecting")
    .in("intake_current_slot", ["consent", "id_photo"])
    .not("consent_prompted_at", "is", null)
    .lte("consent_prompted_at", cutoff)
    .is("stall_notified_at", null);

  const rows = (data ?? []) as unknown as StalledRow[];

  for (const c of rows) {
    await notifyOwner(buildStallAlert(c.phone, displayName(c.full_name, c.phone), c.intake_current_slot));
    await supabaseAdmin
      .from("clients")
      .update({ stall_notified_at: new Date().toISOString() })
      .eq("id", c.id);
    logger.info({ clientId: c.id, slot: c.intake_current_slot }, "intake-stall: alert sent + flagged");
  }
}
