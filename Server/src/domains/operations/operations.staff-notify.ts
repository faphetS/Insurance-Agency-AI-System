import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../config/logger.js";
import { sendInteractiveButtonsWithTyping } from "../whatsapp/whatsapp.service.js";
import { toChatId } from "../whatsapp/whatsapp.util.js";

const TZ = "Asia/Jerusalem";

function formatMeetingDate(iso: string): string {
  return new Intl.DateTimeFormat("he-IL", {
    timeZone: TZ,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

export async function notifyStaffSummaryReady(meetingId: string): Promise<void> {
  try {
    // 1. Load meeting
    const { data: meeting } = await supabaseAdmin
      .from("meetings")
      .select("id, client_id, scheduled_at, summary_draft, recording_url, staff_summary_notified_at")
      .eq("id", meetingId)
      .maybeSingle();

    if (!meeting) return;
    if (meeting.staff_summary_notified_at) return;

    // 2. Load client
    const { data: client } = await supabaseAdmin
      .from("clients")
      .select("full_name, assigned_to, assigned_handler_id")
      .eq("id", meeting.client_id as string)
      .maybeSingle();

    if (!client) {
      logger.warn({ meetingId }, "notifyStaffSummaryReady: client not found");
      return;
    }

    const staffId =
      (client.assigned_handler_id as string | null) ??
      (client.assigned_to as string | null);

    if (!staffId) {
      logger.warn({ meetingId }, "notifyStaffSummaryReady: no staff assigned to client");
      return;
    }

    // 3. Load staff
    const { data: staff } = await supabaseAdmin
      .from("staff")
      .select("full_name, phone")
      .eq("id", staffId)
      .maybeSingle();

    const chatId = toChatId((staff?.phone as string | null) ?? null);

    if (!chatId) {
      logger.warn(
        { meetingId, staffId },
        "notifyStaffSummaryReady: staff has no usable phone — in-app notification only",
      );
      return;
    }

    // 4. Atomic idempotency claim
    const { data: claimed } = await supabaseAdmin
      .from("meetings")
      .update({ staff_summary_notified_at: new Date().toISOString() })
      .eq("id", meetingId)
      .is("staff_summary_notified_at", null)
      .select("id")
      .maybeSingle();

    if (!claimed) return;

    // 5. Build message
    const rawDraft = (meeting.summary_draft as string | null | undefined) ?? "";
    const trimmed = rawDraft.trim();
    const preview = trimmed
      ? trimmed.length > 600
        ? trimmed.slice(0, 600).trimEnd() + "…"
        : trimmed
      : "(לא נוצרה טיוטת סיכום)";

    let body = [
      "📝 סיכום פגישה מוכן לאישור",
      "",
      `לקוח: ${client.full_name as string}`,
      `מועד הפגישה: ${formatMeetingDate(meeting.scheduled_at as string)}`,
      "",
      "טיוטת סיכום:",
      preview,
    ].join("\n");

    if (meeting.recording_url) {
      body += `\n\nהקלטה: ${meeting.recording_url as string}`;
    }

    const buttons = [
      { buttonId: `sum_approve:${meetingId}`, buttonText: "✅ אישור" },
      { buttonId: `sum_edit:${meetingId}`, buttonText: "✏️ עריכה" },
    ];

    await sendInteractiveButtonsWithTyping(chatId, body, buttons, "");

    // 6. Log success
    logger.info({ meetingId, staffId }, "notifyStaffSummaryReady: sent");
  } catch (err) {
    logger.error({ err, meetingId }, "notifyStaffSummaryReady: unexpected error");
  }
}
