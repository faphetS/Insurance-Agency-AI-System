import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../config/logger.js";
import { sendMessageWithTyping } from "../whatsapp/whatsapp.service.js";
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
      .select("id, client_id")
      .eq("id", meetingId)
      .maybeSingle();

    if (!meeting) return;

    const { data: client } = await supabaseAdmin
      .from("clients")
      .select(
        "full_name, phone, id_number, date_of_birth, inquiry_type, health_fund, poa_signed, address, workplace, bafi_file_number, id_photo_url, poa_doc_url, assigned_to, assigned_handler_id, complexity",
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
              return `${i + 1}. ${label} — by ${formatDueDate(t.due_at)}`;
            })
            .join("\n")
        : "(no tasks)";

    const complexityLine =
      (client as unknown as { complexity?: string | null }).complexity === "complex"
        ? ["⚠️ Complex case", ""]
        : [];

    const body = [
      "📥 New Client File – Action Required",
      ...complexityLine,
      "",
      "👤 Client Details",
      `Name: ${client.full_name}`,
      `Phone: ${client.phone}`,
      `ID: ${client.id_number ?? "—"}`,
      `Date of birth: ${client.date_of_birth ?? "—"}`,
      `Inquiry type: ${client.inquiry_type}`,
      `Health fund: ${client.health_fund ?? "—"}`,
      `Bafi file number: ${client.bafi_file_number ?? "—"}`,
      `Address: ${client.address ?? "—"}`,
      `Workplace: ${client.workplace ?? "—"}`,
      `POA signed: ${client.poa_signed ? "Yes" : "No"}`,
      "",
      "📎 Documents",
      `ID photo: ${idUrl ?? "not available in system"}`,
      `POA: ${poaUrl ?? "not available in system"}`,
      "",
      "📋 Follow-up Tasks",
      taskLines,
    ].join("\n");

    await sendMessageWithTyping(chatId, body);
    logger.info({ meetingId, staffId }, "notifyStaffHandoff: sent");
  } catch (err) {
    logger.error({ err, meetingId }, "notifyStaffHandoff: unexpected error");
  }
}
