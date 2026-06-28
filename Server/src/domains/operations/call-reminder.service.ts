import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../config/logger.js";
import { opCreds, sendMessageWith } from "../whatsapp/whatsapp.service.js";
import { getUnresolvedMissedSince, pruneCallsOlderThan } from "./call-events.service.js";

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

export async function sendDailyCallReminder(): Promise<void> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const rows = await getUnresolvedMissedSince(since);
  if (rows.length === 0) {
    logger.info("call-reminder: no missed/declined calls in the last 24h — skipping");
    return;
  }

  const { data: settingRow } = await supabaseAdmin
    .from("system_settings")
    .select("value")
    .eq("key", "op_self_chat_id")
    .maybeSingle();

  const selfChatId = (settingRow?.value as string | null | undefined) ?? null;
  if (!selfChatId) {
    logger.warn("call-reminder: op_self_chat_id not set in system_settings — skipping");
    return;
  }

  const creds = opCreds();
  if (!creds) {
    logger.warn("call-reminder: GREENAPI_OP_* creds not configured — skipping");
    return;
  }

  const lines = rows
    .map((r) => `- ${stripCus(r.counterpart_phone)} בשעה ${formatTime(r.called_at)}`)
    .join("\n");

  const text = `היי, תזכורת על שיחות שלא נענו אתמול:\n\n${lines}`;

  await sendMessageWith(creds, selfChatId, text);
  logger.info({ count: rows.length, selfChatId }, "call-reminder: daily reminder sent");

  await pruneCallsOlderThan(new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString());
}
