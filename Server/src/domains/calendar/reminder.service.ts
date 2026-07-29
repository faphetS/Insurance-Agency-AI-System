import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../config/logger.js";
import { sendMessageWithTyping } from "../whatsapp/whatsapp.service.js";

const TZ = "Asia/Jerusalem";

// ---------------------------------------------------------------------------
// Timezone helpers
// ---------------------------------------------------------------------------

export function israelOffsetMs(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .formatToParts(at)
    .reduce<Record<string, string>>((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});

  const h = parts["hour"] === "24" ? 0 : Number(parts["hour"]);
  const utcEquiv = Date.UTC(
    Number(parts["year"]),
    Number(parts["month"]) - 1,
    Number(parts["day"]),
    h,
    Number(parts["minute"]),
    Number(parts["second"]),
  );
  return utcEquiv - at.getTime();
}

export function israelTimeOfDayMs(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .formatToParts(at)
    .reduce<Record<string, string>>((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});

  const h = parts["hour"] === "24" ? 0 : Number(parts["hour"]);
  return (h * 3600 + Number(parts["minute"]) * 60 + Number(parts["second"])) * 1000;
}

export function israelWallTimeInstant(ref: Date, hour: number, minute: number): Date {
  const dateParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(ref)
    .reduce<Record<string, string>>((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});

  const y = Number(dateParts["year"]);
  const mo = Number(dateParts["month"]);
  const d = Number(dateParts["day"]);

  const guess = Date.UTC(y, mo - 1, d, hour, minute, 0);
  // One correction pass for DST
  const instant = guess - israelOffsetMs(new Date(guess - israelOffsetMs(new Date(guess))));
  return new Date(instant);
}

export function clampedSendTime(scheduledAt: Date, offsetMs: number, startHour = 7, endHour = 21): Date {
  const natural = new Date(scheduledAt.getTime() - offsetMs);
  const tod = israelTimeOfDayMs(natural);
  const lo = startHour * 3600_000;
  const hi = endHour * 3600_000;

  if (tod < lo) return israelWallTimeInstant(natural, startHour, 0);
  if (tod > hi) return israelWallTimeInstant(natural, endHour, 0);
  return natural;
}

export function formatLeadTime(deltaMs: number): string {
  const totalMin = Math.max(1, Math.round(deltaMs / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;

  const hourWord =
    h === 1 ? "כשעה" : h === 2 ? "כשעתיים" : `כ-${h} שעות`;
  const minWord = m === 1 ? "דקה" : `${m} דקות`;

  if (h === 0) return m === 1 ? "כדקה" : `כ-${m} דקות`;
  if (m === 0) return hourWord;
  return `${hourWord} ו-${minWord}`;
}

// ---------------------------------------------------------------------------
// Offset constants
// ---------------------------------------------------------------------------

const OFFSET_MS = {
  reminder_24h_sent: 24 * 60 * 60 * 1000,
  reminder_1h_sent: 60 * 60 * 1000,
} as const;

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Core reminder sender
// ---------------------------------------------------------------------------

async function sendReminder(
  meetingId: string,
  conversationId: string,
  scheduledAt: string,
  flag: "reminder_24h_sent" | "reminder_1h_sent",
  now: Date,
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

  const lead = formatLeadTime(new Date(scheduledAt).getTime() - now.getTime());

  const text =
    flag === "reminder_24h_sent"
      ? `תזכורת: יש לך פגישה בעוד ${lead}, בתאריך ${formatDateTime(scheduledAt)}. נשמח לראותך! 😊`
      : `תזכורת: הפגישה שלך מתחילה בעוד ${lead} (${formatTime(scheduledAt)}). נא להתכונן.`;

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

// ---------------------------------------------------------------------------
// Mark a flag without sending (clamping edge cases)
// ---------------------------------------------------------------------------

async function markFlag(
  meetingId: string,
  flag: "reminder_24h_sent" | "reminder_1h_sent",
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabaseAdmin as any)
    .from("meetings")
    .update({ [flag]: true, updated_at: new Date().toISOString() })
    .eq("id", meetingId);
}

// ---------------------------------------------------------------------------
// Scheduled checker
// ---------------------------------------------------------------------------

export async function checkAndSendReminders(): Promise<void> {
  const now = new Date();

  // 24-hour reminders — widened to +27h to accommodate clamped sends
  const in27h = new Date(now.getTime() + 27 * 60 * 60 * 1000);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: meetings24h } = await (supabaseAdmin as any)
    .from("meetings")
    .select("id, conversation_id, scheduled_at")
    .eq("status", "scheduled")
    .eq("reminder_24h_sent", false)
    .gte("scheduled_at", now.toISOString())
    .lte("scheduled_at", in27h.toISOString());

  for (const m of meetings24h ?? []) {
    if (!m.conversation_id) continue;
    try {
      const scheduled = new Date(m.scheduled_at);

      // Meeting already inside the 1h window — let only the 1h reminder fire
      if (scheduled.getTime() - now.getTime() <= 90 * 60 * 1000) {
        await markFlag(m.id, "reminder_24h_sent");
        continue;
      }

      const send = clampedSendTime(scheduled, OFFSET_MS.reminder_24h_sent);

      // Clamped send would be at or after the meeting itself — skip and mark
      if (send.getTime() >= scheduled.getTime()) {
        await markFlag(m.id, "reminder_24h_sent");
        continue;
      }

      // Send time not yet reached — defer without setting the flag
      if (now.getTime() < send.getTime()) continue;

      await sendReminder(m.id, m.conversation_id, m.scheduled_at, "reminder_24h_sent", now);
    } catch (err) {
      logger.error({ err, meetingId: m.id }, "reminder: 24h reminder failed");
    }
  }

  // 1-hour reminders — widened to +3h to accommodate clamped sends
  const in3h = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: meetings1h } = await (supabaseAdmin as any)
    .from("meetings")
    .select("id, conversation_id, scheduled_at")
    .eq("status", "scheduled")
    .eq("reminder_1h_sent", false)
    .gte("scheduled_at", now.toISOString())
    .lte("scheduled_at", in3h.toISOString());

  for (const m of meetings1h ?? []) {
    if (!m.conversation_id) continue;
    try {
      const scheduled = new Date(m.scheduled_at);
      const send = clampedSendTime(scheduled, OFFSET_MS.reminder_1h_sent);

      // Early-morning meeting: clamped send is at or after the meeting — skip & mark
      if (send.getTime() >= scheduled.getTime()) {
        await markFlag(m.id, "reminder_1h_sent");
        continue;
      }

      // Send time not yet reached — defer without setting the flag
      if (now.getTime() < send.getTime()) continue;

      await sendReminder(m.id, m.conversation_id, m.scheduled_at, "reminder_1h_sent", now);
    } catch (err) {
      logger.error({ err, meetingId: m.id }, "reminder: 1h reminder failed");
    }
  }
}
