import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../config/logger.js";
import { sendStaffMessage } from "../whatsapp/whatsapp.service.js";
import { toChatId } from "../whatsapp/whatsapp.util.js";
import { getSignedDocUrl } from "../../lib/storage.js";
import { TASK_LABELS_HE, formatDueDate } from "./operations.format.js";

const SIGNED_TTL = 604_800; // 7 days in seconds

// Legacy rows store an expired GreenAPI http(s) URL → treat as unavailable.
// New rows store a Storage object path → mint a signed URL.
async function resolveDocLink(stored: string | null | undefined): Promise<string | null> {
  if (!stored) return null;
  if (/^https?:\/\//i.test(stored)) return null;
  return getSignedDocUrl(stored, SIGNED_TTL);
}

export async function notifyStaffHandoff(meetingId: string): Promise<void> {
  try {
    const { data: meeting } = await supabaseAdmin
      .from("meetings")
      .select("id, client_id, summary_final, summary_draft")
      .eq("id", meetingId)
      .maybeSingle();

    if (!meeting) return;

    const { data: client } = await supabaseAdmin
      .from("clients")
      .select(
        "full_name, phone, id_number, inquiry_type, id_photo_url, poa_doc_url, assigned_to, assigned_handler_id, complexity",
      )
      .eq("id", meeting.client_id)
      .maybeSingle();

    if (!client) {
      logger.warn({ meetingId }, "notifyStaffHandoff: client not found");
      return;
    }

    const staffId = client.assigned_handler_id ?? client.assigned_to;
    if (!staffId) {
      logger.warn({ meetingId }, "notifyStaffHandoff: no staff assigned to client");
      return;
    }

    const { data: staff } = await supabaseAdmin
      .from("staff")
      .select("full_name, phone")
      .eq("id", staffId)
      .maybeSingle();

    const chatId = toChatId(staff?.phone ?? null);
    if (!chatId) {
      logger.warn({ meetingId, staffId }, "notifyStaffHandoff: staff has no usable phone");
      return;
    }

    const { data: tasks } = await supabaseAdmin
      .from("tasks")
      .select("type, due_at")
      .eq("meeting_id", meetingId)
      .order("due_at", { ascending: true });

    const idUrl = await resolveDocLink(client.id_photo_url);
    const poaUrl = await resolveDocLink(client.poa_doc_url);

    const taskLines =
      tasks && tasks.length > 0
        ? tasks
            .map((t: any, i: number) => {
              const label = TASK_LABELS_HE[t.type] ?? t.type;
              return `${i + 1}. ${label} — עד ${formatDueDate(t.due_at)}`;
            })
            .join("\n")
        : "(אין משימות)";

    const complexityLine =
      (client as unknown as { complexity?: string | null }).complexity === "complex"
        ? ["⚠️ מקרה מורכב", ""]
        : [];

    const summaryText = (meeting.summary_final ?? meeting.summary_draft ?? "").trim();
    const summarySection = summaryText ? ["📝 סיכום הפגישה", summaryText, ""] : [];

    const body = [
      "📥 תיק לקוח חדש – נדרש טיפול",
      ...complexityLine,
      "",
      "👤 פרטי הלקוח",
      `שם: ${client.full_name}`,
      `טלפון: ${client.phone}`,
      `ת"ז: ${client.id_number ?? "—"}`,
      `סוג הפנייה: ${client.inquiry_type}`,
      "",
      ...summarySection,
      "📎 מסמכים",
      `צילום ת"ז: ${idUrl ?? "לא זמין במערכת"}`,
      `ייפוי כוח: ${poaUrl ?? "לא זמין במערכת"}`,
      "",
      "📋 משימות המשך",
      taskLines,
    ].join("\n");

    await sendStaffMessage(chatId, body);
    logger.info({ meetingId, staffId }, "notifyStaffHandoff: sent");
  } catch (err) {
    logger.error({ err, meetingId }, "notifyStaffHandoff: unexpected error");
  }
}
