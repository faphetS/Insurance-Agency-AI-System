import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { clixSendText, clixSendCreds } from "../whatsapp/whatsapp.clix-send.js";
import { toChatId } from "../whatsapp/whatsapp.util.js";

// Send an operational reminder to the owner (Didi) via the Clix conversational-bot line
// (a real notification) instead of the silent self-note the op GreenAPI instance produced.
// Returns false and sends nothing if the owner number or Clix creds are unset.
export async function notifyOwnerViaClix(text: string): Promise<boolean> {
  const chatId = toChatId(env.SUMMARY_RECIPIENT_PHONE ?? null);
  if (!chatId) {
    logger.warn("owner-notify: SUMMARY_RECIPIENT_PHONE not set — skipping");
    return false;
  }
  if (!clixSendCreds()) {
    logger.warn("owner-notify: Clix send creds not configured — skipping");
    return false;
  }
  try {
    await clixSendText(chatId, text);
    return true;
  } catch (err) {
    logger.warn({ err }, "owner-notify: clixSendText failed");
    return false;
  }
}
