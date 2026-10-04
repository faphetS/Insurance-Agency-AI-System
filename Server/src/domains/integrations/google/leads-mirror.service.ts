import { supabaseAdmin } from "../../../config/supabase.js";
import { env } from "../../../config/env.js";
import { logger } from "../../../config/logger.js";
import { AppError } from "../../../lib/errors.js";
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
    const { data: client, error: clientError } = await supabaseAdmin
      .from("clients")
      .select("phone, full_name, inquiry_type, client_type, id_number, intake_started_at, created_at")
      .eq("id", clientId)
      .maybeSingle();

    if (clientError) {
      logger.error({ clientId, error: clientError }, "leads-mirror: client read failed — skipping");
      return;
    }
    if (!client) {
      logger.warn({ clientId }, "leads-mirror: client not found — skipping");
      return;
    }

    const c = client as {
      phone?: string | null;
      full_name?: string | null;
      inquiry_type?: string | null;
      client_type?: string | null;
      id_number?: string | null;
      intake_started_at?: string | Date | null;
      created_at?: string | Date | null;
    };

    if (!c.phone) {
      logger.debug({ clientId }, "leads-mirror: no phone — skipping");
      return;
    }

    const { data: docs, error: docsError } = await supabaseAdmin
      .from("documents")
      .select("file_url, created_at")
      .eq("client_id", clientId)
      .order("created_at", { ascending: true });
    // D is rebuilt from these rows on every sync and is not set-once: writing after a failed
    // read would blank the links already in the sheet.
    if (docsError) {
      logger.error({ clientId, error: docsError }, "leads-mirror: documents read failed — skipping");
      return;
    }
    const docRows = (docs ?? []) as { file_url?: string | null; created_at?: string | Date | null }[];
    const links = docRows
      .map((d) => d.file_url)
      .filter((u): u is string => typeof u === "string" && u.length > 0);

    // Pre-migration clients have no intake_started_at: their creation stands in for it,
    // so their existing row keeps being updated until they start a new inquiry.
    const startedAt = new Date(c.intake_started_at ?? c.created_at ?? Date.now());

    const inquiry = c.inquiry_type;
    // A lead who sent a file in this inquiry before picking a menu option still needs a row:
    // the sheet is the only place staff can reach the Drive links (Chatwoot shows [תמונה] only).
    // Files from an earlier inquiry are already on that inquiry's row, so they never open a
    // blank one. The minute of slack is upsertLeadRow's, and keeps a file that raced the
    // restart stamp.
    const noMenuChoice = !inquiry || inquiry === "general";
    const hasCurrentFile = docRows.some(
      (d) => d.created_at != null && new Date(d.created_at).getTime() >= startedAt.getTime() - 60_000,
    );
    if (noMenuChoice && !hasCurrentFile) {
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

    // A phone · B name · C inquiry · D every Drive link (one per line) · E ID number ·
    // F relevance (manual) · G creation date
    const row = [
      String(c.phone),
      name,
      inquiryHe,
      links.join("\n"),
      String(c.id_number ?? ""),
      "",
      nowIsraelString(),
    ];

    // F = relevance is human-owned (dropdown) and must survive re-mirrors fired on every
    // intake slot advance; G = creation date. C joins them only while the inquiry is still
    // unknown, so a returning lead (reset to "general") never blanks the label already there.
    await upsertLeadRow(row, tab, { setOnceColumns: noMenuChoice ? [2, 5, 6] : [5, 6], startedAt });
  } catch (err) {
    logger.error({ err, clientId }, "leads-mirror: unexpected error");
  }
}

/** Re-mirror every client that has at least one document (one-off, after the D-column change). */
export async function backfillLeadDocuments(): Promise<{ clients: number }> {
  const { data, error } = await supabaseAdmin.from("documents").select("client_id");
  // The shim resolves a failed read instead of throwing; unchecked, the run would answer
  // "success, 0 clients" and the missing links would look backfilled.
  if (error) {
    logger.error({ error }, "leads-mirror: backfill documents read failed");
    throw new AppError(500, "Failed to list documents for the backfill", "LEADS_BACKFILL_READ_FAILED");
  }
  const ids = [...new Set(((data ?? []) as { client_id: string }[]).map((d) => d.client_id))];
  for (const id of ids) {
    await mirrorLeadToSheet(id);
  }
  logger.info({ clients: ids.length }, "leads-mirror: backfill complete");
  return { clients: ids.length };
}
