import { supabaseAdmin } from "../../../config/supabase.js";
import { env } from "../../../config/env.js";
import { logger } from "../../../config/logger.js";
import { INQUIRY_TYPE_HE } from "../../ai/intake.prompts.js";
import type { InquiryType } from "../../ai/intake.prompts.js";
import { upsertLeadRow } from "./google.sheets.js";

export async function mirrorLeadToSheet(clientId: string): Promise<void> {
  if (!env.LEADS_MIRROR_ENABLED) return;

  try {
    const { data: client } = await supabaseAdmin
      .from("clients")
      .select("full_name, phone, email, inquiry_type, id_number, id_photo_url, poa_doc_url")
      .eq("id", clientId)
      .maybeSingle();

    if (!client) {
      logger.warn({ clientId }, "leads-mirror: client not found — skipping");
      return;
    }

    const c = client as {
      full_name?: string | null;
      phone?: string | null;
      email?: string | null;
      inquiry_type?: string | null;
      id_number?: string | null;
      id_photo_url?: string | null;
      poa_doc_url?: string | null;
    };

    const inquiryHe =
      INQUIRY_TYPE_HE[c.inquiry_type as InquiryType] ?? c.inquiry_type ?? "";

    const row = [
      String(c.phone ?? ""),
      String(c.full_name ?? ""),
      String(c.email ?? ""),
      inquiryHe,
      String(c.id_photo_url ?? ""),
      String(c.poa_doc_url ?? ""),
      String(c.id_number ?? ""),
      "",
    ];

    await upsertLeadRow(row);
  } catch (err) {
    logger.error({ err, clientId }, "leads-mirror: unexpected error");
  }
}
