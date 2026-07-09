import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { notifyCreds, sendMessage, sendMessageWith } from "../whatsapp/whatsapp.service.js";
import { toChatId } from "../whatsapp/whatsapp.util.js";

// Send an operational reminder to the owner (Didi) via the conversational GreenAPI instance.
// Returns false and sends nothing if the owner number is unset or creds are blank (no-op guard
// is inside sendMessage).
export async function notifyOwner(text: string): Promise<boolean> {
  const chatId = toChatId(env.SUMMARY_RECIPIENT_PHONE ?? null);
  if (!chatId) {
    logger.warn("owner-notify: SUMMARY_RECIPIENT_PHONE not set — skipping");
    return false;
  }
  try {
    await sendMessage(chatId, text);
    return true;
  } catch (err) {
    logger.warn({ err }, "owner-notify: sendMessage failed");
    return false;
  }
}

// Send an operational reminder to the owner via the dedicated notify GreenAPI instance
// (GREENAPI_NOTIFY_*). Used by the operational bot's owner sends (digest, call-reminder,
// commitments, unanswered-WA alerts). Returns false and sends nothing when the owner
// number is unset or the notify creds are blank.
export async function notifyOwnerOps(text: string): Promise<boolean> {
  const chatId = toChatId(env.SUMMARY_RECIPIENT_PHONE ?? null);
  if (!chatId) {
    logger.warn("owner-notify: SUMMARY_RECIPIENT_PHONE not set — skipping (ops)");
    return false;
  }
  const creds = notifyCreds();
  if (!creds) {
    logger.warn("owner-notify: notify GreenAPI creds not set — skipping (ops)");
    return false;
  }
  try {
    await sendMessageWith(creds, chatId, text);
    return true;
  } catch (err) {
    logger.warn({ err }, "owner-notify: sendMessageWith (ops) failed");
    return false;
  }
}
