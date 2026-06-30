import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { INQUIRY_TYPE_HE } from "../ai/intake.prompts.js";
import { sendMessage } from "./whatsapp.service.js";
import { toChatId } from "./whatsapp.util.js";

function deptPhone(inquiryId: string): string | null {
  if (["vehicle", "home", "business"].includes(inquiryId)) {
    return env.DEPT_ELEMENTARY_PHONE ?? null;
  }
  if (["life_health_pension", "finance"].includes(inquiryId)) {
    return env.DEPT_LIFE_FINANCE_PHONE ?? null;
  }
  return null;
}

export async function notifyDepartmentForInquiry(
  inquiryId: string,
  opts: { phone: string; clientType: string | null },
): Promise<void> {
  const phone = deptPhone(inquiryId);
  if (!phone) {
    logger.info({ inquiryId }, "department-routing: no department phone for inquiry — skipping");
    return;
  }

  const chatId = toChatId(phone);
  if (!chatId) {
    logger.info({ inquiryId, phone }, "department-routing: could not normalise dept phone — skipping");
    return;
  }

  const clientLabel = opts.clientType === "old" ? "לקוח קיים" : "מתעניין";
  const inquiryLabel = INQUIRY_TYPE_HE[inquiryId] ?? inquiryId;

  const text =
    `📩 פנייה חדשה מהבוט\n` +
    `סוג הביטוח: ${inquiryLabel}\n` +
    `טלפון הלקוח: ${opts.phone}\n` +
    `סוג לקוח: ${clientLabel}`;

  try {
    await sendMessage(chatId, text);
  } catch (err) {
    logger.warn({ err, inquiryId, chatId }, "department-routing: failed to send dept ping — ignoring");
  }
}
