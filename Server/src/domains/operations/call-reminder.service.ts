import { logger } from "../../config/logger.js";
import { getUnresolvedMissedSince, pruneCallsOlderThan } from "./call-events.service.js";
import { notifyOwner } from "./owner-notify.js";

const TZ = "Asia/Jerusalem";

function formatTime(calledAt: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(calledAt));
}

function stripCus(phone: string): string {
  return phone.endsWith("@c.us") ? phone.slice(0, -5) : phone;
}

export async function buildCallReminderSection(): Promise<string | null> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const rows = await getUnresolvedMissedSince(since);
  if (rows.length === 0) return null;

  const lines = rows
    .map((r) => `- ${stripCus(r.counterpart_phone)} בשעה ${formatTime(r.called_at)}`)
    .join("\n");

  return `היי, תזכורת על שיחות שלא נענו אתמול:\n\n${lines}`;
}

export async function sendDailyCallReminder(): Promise<void> {
  const text = await buildCallReminderSection();
  if (!text) {
    logger.info("call-reminder: no missed/declined calls in the last 24h — skipping");
    return;
  }

  const ok = await notifyOwner(text);
  if (ok) {
    logger.info({ count: text.split("\n").length - 2 }, "call-reminder: daily reminder sent");
    await pruneCallsOlderThan(new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString());
  }
}
