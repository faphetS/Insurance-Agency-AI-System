import { supabaseAdmin } from "../../../config/supabase.js";
import { env } from "../../../config/env.js";
import { logger } from "../../../config/logger.js";
import { INQUIRY_TYPE_HE } from "../../ai/intake.prompts.js";
import { displayName } from "../../whatsapp/whatsapp.util.js";
import { upsertLeadRow } from "./google.sheets.js";

// Human-readable Israel-local timestamp: DD/MM/YYYY HH:mm (Asia/Jerusalem).
function nowIsraelString(): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jerusalem",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
  return parts.replace(",", "");
}

// Sheet column C label from inquiry_type + client_type.
function inquiryColumn(inquiryType: string | null | undefined, clientType: string | null | undefined): string {
  if (inquiryType === "callback") return "בקשת שיחה חוזרת";
  if (inquiryType === "meeting") {
    if (clientType === "old") return "תיאום פגישה — לקוח קיים";
    if (clientType === "new") return "תיאום פגישה — לקוח חדש";
    return "תיאום פגישה";
  }
  return INQUIRY_TYPE_HE[inquiryType ?? ""] ?? "";
}

export async function mirrorLeadToSheet(clientId: string): Promise<void> {
  if (!env.LEADS_MIRROR_ENABLED) return;

  try {
    const { data: client } = await supabaseAdmin
      .from("clients")
      .select("phone, full_name, inquiry_type, client_type, id_photo_url, id_number")
      .eq("id", clientId)
      .maybeSingle();

    if (!client) {
      logger.warn({ clientId }, "leads-mirror: client not found — skipping");
      return;
    }

    const c = client as {
      phone?: string | null;
      full_name?: string | null;
      inquiry_type?: string | null;
      client_type?: string | null;
      id_photo_url?: string | null;
      id_number?: string | null;
    };

    if (!c.phone) {
      logger.debug({ clientId }, "leads-mirror: no phone — skipping");
      return;
    }

    const inquiry = c.inquiry_type;
    if (!inquiry || inquiry === "general") {
      logger.debug({ clientId, inquiry }, "leads-mirror: no menu choice yet — skipping");
      return;
    }
    if (inquiry === "meeting" && c.client_type !== "old" && c.client_type !== "new") {
      logger.debug({ clientId }, "leads-mirror: meeting awaiting existing/new sub-choice — skipping");
      return;
    }

    const tab = inquiry === "meeting" && c.client_type === "old"
      ? env.LEADS_SHEET_TAB_EXISTING
      : env.LEADS_SHEET_TAB_NEW;

    const name = displayName(c.full_name, c.phone) ?? "";
    const inquiryHe = inquiryColumn(c.inquiry_type, c.client_type);

    // A phone · B name · C inquiry · D ID photo link · E ID number · F relevance (manual) · G creation date
    const row = [
      String(c.phone),
      name,
      inquiryHe,
      String(c.id_photo_url ?? ""),
      String(c.id_number ?? ""),
      "",
      nowIsraelString(),
    ];

    await upsertLeadRow(row, tab, { setOnceColumns: [6] });
  } catch (err) {
    logger.error({ err, clientId }, "leads-mirror: unexpected error");
  }
}
