import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../config/logger.js";
import { sendMessageWithTyping } from "../whatsapp/whatsapp.service.js";

const TZ = "Asia/Jerusalem";

function formatDateTime(iso: string): string {
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

function formatTime(iso: string): string {
  return new Intl.DateTimeFormat("he-IL", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

async function sendReminder(
  meetingId: string,
  conversationId: string,
  scheduledAt: string,
  flag: "reminder_24h_sent" | "reminder_1h_sent",
): Promise<void> {
  const { data: conv } = await supabaseAdmin
    .from("conversations")
    .select("whatsapp_chat_id")
    .eq("id", conversationId)
    .single();

  if (!conv?.whatsapp_chat_id) {
    logger.warn({ meetingId, conversationId }, "reminder: no conversation found");
    return;
  }

  const text =
    flag === "reminder_24h_sent"
      ? `תזכורת: קבועה לך פגישה בתאריך ${formatDateTime(scheduledAt)}. נשמח לראותך! 😊`
      : `תזכורת: הפגישה שלך מתחילה בעוד כשעה (${formatTime(scheduledAt)}). נא להתכונן.`;

  const { idMessage } = await sendMessageWithTyping(conv.whatsapp_chat_id, text);

  await supabaseAdmin.from("messages").insert({
    conversation_id: conversationId,
    direction: "outbound",
    sent_by: "bot",
    body: text,
    status: "sent",
    whatsapp_message_id: idMessage,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabaseAdmin as any)
    .from("meetings")
    .update({ [flag]: true, updated_at: new Date().toISOString() })
    .eq("id", meetingId);

  logger.info({ meetingId, flag }, "reminder: sent");
}

export async function checkAndSendReminders(): Promise<void> {
  const now = new Date();

  // 24-hour reminders
  const in25h = new Date(now.getTime() + 25 * 60 * 60 * 1000);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: meetings24h } = await (supabaseAdmin as any)
    .from("meetings")
    .select("id, conversation_id, scheduled_at")
    .eq("status", "scheduled")
    .eq("reminder_24h_sent", false)
    .gte("scheduled_at", now.toISOString())
    .lte("scheduled_at", in25h.toISOString());

  for (const m of meetings24h ?? []) {
    if (!m.conversation_id) continue;
    try {
      await sendReminder(m.id, m.conversation_id, m.scheduled_at, "reminder_24h_sent");
    } catch (err) {
      logger.error({ err, meetingId: m.id }, "reminder: 24h reminder failed");
    }
  }

  // 1-hour reminders
  const in90min = new Date(now.getTime() + 90 * 60 * 1000);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: meetings1h } = await (supabaseAdmin as any)
    .from("meetings")
    .select("id, conversation_id, scheduled_at")
    .eq("status", "scheduled")
    .eq("reminder_1h_sent", false)
    .gte("scheduled_at", now.toISOString())
    .lte("scheduled_at", in90min.toISOString());

  for (const m of meetings1h ?? []) {
    if (!m.conversation_id) continue;
    try {
      await sendReminder(m.id, m.conversation_id, m.scheduled_at, "reminder_1h_sent");
    } catch (err) {
      logger.error({ err, meetingId: m.id }, "reminder: 1h reminder failed");
    }
  }
}
