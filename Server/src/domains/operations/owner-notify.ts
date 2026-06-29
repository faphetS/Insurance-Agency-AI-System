import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { sendMessage } from "../whatsapp/whatsapp.service.js";
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
