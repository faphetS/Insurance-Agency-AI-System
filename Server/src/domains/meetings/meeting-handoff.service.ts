import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../config/logger.js";
import { env } from "../../config/env.js";
import { sendMessage } from "../whatsapp/whatsapp.service.js";
import { sendOwnerEmail } from "../integrations/google/google.gmail.js";

// Gap between the two post-assignment sends (staff handoff, then the owner ack) so the
// gateway doesn't flag back-to-back sends as spam.
const HANDOFF_ACK_GAP_MS = 5000;

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
      .select("full_name, assigned_to, assigned_handler_id")
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
      .select("full_name, email")
      .eq("id", staffId)
      .maybeSingle();

    const staffEmail = (staff?.email as string | null) ?? null;
    if (!staffEmail) {
      logger.warn({ meetingId, staffId }, "notifyStaffHandoff: staff has no email");
      return;
    }

    const summaryText = ((meeting.summary_final ?? meeting.summary_draft ?? "") as string).trim();
    const lines = [`👤 דידי הקצה אותך לטיפול בלקוח ${client.full_name as string}`];
    if (summaryText) {
      lines.push("", "📝 סיכום הפגישה", summaryText);
    }
    const body = lines.join("\n");
    const subject = `הקצאת לקוח חדשה — ${client.full_name as string}`;

    if (env.STAFF_EMAIL_NOTIFY_MODE === "send") {
      await sendOwnerEmail(staffEmail, subject, body);
      logger.info({ meetingId, staffId, to: staffEmail }, "notifyStaffHandoff: email sent");
    } else {
      logger.info({ meetingId, staffId, to: staffEmail, subject, body }, "notifyStaffHandoff (DRY RUN — not sent)");
    }
  } catch (err) {
    logger.error({ err, meetingId }, "notifyStaffHandoff: unexpected error");
  }
}

export async function assignStaffToMeeting(
  meetingId: string,
  staffId: string,
  ownerChatId: string,
): Promise<void> {
  const { data: meeting } = await supabaseAdmin
    .from("meetings")
    .select("id, client_id")
    .eq("id", meetingId)
    .maybeSingle();

  if (!meeting) {
    await sendMessage(ownerChatId, "❌ הפגישה לא נמצאה.");
    return;
  }

  const { data: staff } = await supabaseAdmin
    .from("staff")
    .select("full_name, phone")
    .eq("id", staffId)
    .maybeSingle();

  if (!staff) {
    await sendMessage(ownerChatId, "❌ העובד לא נמצא.");
    return;
  }

  const clientId = meeting.client_id as string;
  const fullName = staff.full_name as string;

  // First-tap-wins: atomically claim the assignment only if no handler is set yet.
  const { data: claimed } = await supabaseAdmin
    .from("clients")
    .update({ assigned_handler_id: staffId })
    .eq("id", clientId)
    .is("assigned_handler_id", null)
    .select("id")
    .maybeSingle();

  if (!claimed) {
    const { data: cur } = await supabaseAdmin
      .from("clients")
      .select("assigned_handler_id")
      .eq("id", clientId)
      .maybeSingle();
    const currentId = (cur?.assigned_handler_id as string | null) ?? null;
    let currentName = "";
    if (currentId) {
      const { data: curStaff } = await supabaseAdmin
        .from("staff")
        .select("full_name")
        .eq("id", currentId)
        .maybeSingle();
      currentName = (curStaff?.full_name as string | null) ?? "";
    }
    await sendMessage(ownerChatId, currentName ? `✅ כבר הוקצה ל${currentName}` : "✅ כבר הוקצה");
    return;
  }

  // Set last_service_date = today if not already set (starts the biennial clock).
  const today = new Date().toISOString().slice(0, 10);
  await supabaseAdmin
    .from("clients")
    .update({ last_service_date: today })
    .eq("id", clientId)
    .is("last_service_date", null);

  await notifyStaffHandoff(meetingId);
  await new Promise((resolve) => setTimeout(resolve, HANDOFF_ACK_GAP_MS));
  await sendMessage(ownerChatId, `✅ הוקצה ל${fullName}`);
}
