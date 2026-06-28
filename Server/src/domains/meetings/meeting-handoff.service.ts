import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../config/logger.js";
import { clixSendText } from "../whatsapp/whatsapp.clix-send.js";
import { toChatId } from "../whatsapp/whatsapp.util.js";

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
      .select("full_name, phone")
      .eq("id", staffId)
      .maybeSingle();

    const chatId = toChatId(staff?.phone ?? null);
    if (!chatId) {
      logger.warn({ meetingId, staffId }, "notifyStaffHandoff: staff has no usable phone");
      return;
    }

    const summaryText = ((meeting.summary_final ?? meeting.summary_draft ?? "") as string).trim();
    const lines = [`👤 דידי הקצה אותך לטיפול בלקוח ${client.full_name as string}`];
    if (summaryText) {
      lines.push("", "📝 סיכום הפגישה", summaryText);
    }
    const body = lines.join("\n");

    await clixSendText(chatId, body);
    logger.info({ meetingId, staffId }, "notifyStaffHandoff: sent");
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
    await clixSendText(ownerChatId, "❌ הפגישה לא נמצאה.");
    return;
  }

  const { data: staff } = await supabaseAdmin
    .from("staff")
    .select("full_name, phone")
    .eq("id", staffId)
    .maybeSingle();

  if (!staff) {
    await clixSendText(ownerChatId, "❌ העובד לא נמצא.");
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
    await clixSendText(ownerChatId, currentName ? `✅ כבר הוקצה ל${currentName}` : "✅ כבר הוקצה");
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
  await clixSendText(ownerChatId, `✅ הוקצה ל${fullName}`);
}
