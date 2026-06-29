import { logger } from "../../config/logger.js";
import { opCreds } from "../whatsapp/whatsapp.service.js";
import { refreshCommitments } from "../commitments/commitments.service.js";
import { buildMorningCommitmentSection, markCommitmentsSent } from "../commitments/commitments.reminders.js";
import { buildCallReminderSection } from "./call-reminder.service.js";
import { pruneCallsOlderThan } from "./call-events.service.js";
import { notifyOwner } from "./owner-notify.js";

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

  const text = [commit.text, call].filter(Boolean).join("\n\n");
  const ok = await notifyOwner(text);
  logger.info({ hasCommit: !!commit.text, hasCalls: !!call, ok }, "morning-digest: sent");
  if (ok && commit.ids.length > 0) {
    await markCommitmentsSent(commit.ids);
  }
  await pruneCallsOlderThan(new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString());
}
