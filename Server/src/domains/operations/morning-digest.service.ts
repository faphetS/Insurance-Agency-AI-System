import { logger } from "../../config/logger.js";
import { supabaseAdmin } from "../../config/supabase.js";
import { opCreds, sendMessageWith } from "../whatsapp/whatsapp.service.js";
import { refreshCommitments } from "../commitments/commitments.service.js";
import { buildMorningCommitmentSection, markCommitmentsSent } from "../commitments/commitments.reminders.js";
import { buildCallReminderSection } from "./call-reminder.service.js";
import { pruneCallsOlderThan } from "./call-events.service.js";

export async function sendMorningDigest(): Promise<void> {
  if (!opCreds()) {
    logger.info("morning-digest: op creds not configured — skipping");
    return;
  }

  await refreshCommitments();

  const [commit, call] = await Promise.all([
    buildMorningCommitmentSection(),
    buildCallReminderSection(),
  ]);

  if (!commit.text && !call) {
    logger.info("morning-digest: nothing to send — skipping");
    return;
  }

  const { data: settingRow } = await supabaseAdmin
    .from("system_settings")
    .select("value")
    .eq("key", "op_self_chat_id")
    .maybeSingle();

  const selfChatId = (settingRow?.value as string | null | undefined) ?? null;
  if (!selfChatId) {
    logger.warn("morning-digest: op_self_chat_id not set in system_settings — skipping");
    return;
  }

  const creds = opCreds();
  if (!creds) return;

  const text = [commit.text, call].filter(Boolean).join("\n\n");
  await sendMessageWith(creds, selfChatId, text);
  logger.info({ hasCommit: !!commit.text, hasCalls: !!call }, "morning-digest: sent");

  if (commit.ids.length > 0) {
    await markCommitmentsSent(commit.ids);
  }
  await pruneCallsOlderThan(new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString());
}
