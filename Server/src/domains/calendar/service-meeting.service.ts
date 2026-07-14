import { pool } from "../../lib/db.js";
import { logger } from "../../config/logger.js";
// Only referenced from the commented-out body of the disabled send below.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { sendMessageWithTyping } from "../whatsapp/whatsapp.service.js";
import { toChatId } from "../whatsapp/whatsapp.util.js";

async function sendServiceDueToClient(client: {
  id: string;
  full_name: string | null;
  phone: string | null;
}): Promise<boolean> {
  // DISABLED (owner sends not needed 2026-07-15) — remove this early return
  // (and uncomment the body below) to restore.
  logger.info({ clientId: client.id }, "sendServiceDueToClient: disabled — skipping");
  return false;

  /*
  try {
    const chatId = toChatId(client.phone ?? null);
    if (!chatId) {
      logger.warn({ clientId: client.id }, "sendServiceDueToClient: client has no usable phone");
      return false;
    }

    const name = client.full_name?.trim();
    const body = [
      `שלום${name ? " " + name : ""} 😊`,
      "עברו שנתיים מאז הפגישה האחרונה שלנו — זה הזמן לפגישת שירות תקופתית.",
      "נשמח לבדוק יחד שהביטוחים שלך עדיין מתאימים לצרכים שלך ולעדכן במידת הצורך.",
    ].join("\n");

    await sendMessageWithTyping(chatId, body);
    logger.info({ clientId: client.id }, "sendServiceDueToClient: sent");
    return true;
  } catch (err) {
    logger.error({ err, clientId: client.id }, "sendServiceDueToClient: unexpected error");
    return false;
  }
  */
}

export async function checkServiceMeetingEligibility(): Promise<void> {
  let result: { rows: { id: string; full_name: string | null; phone: string | null }[] };
  try {
    result = await pool.query<{ id: string; full_name: string | null; phone: string | null }>(`
      SELECT id, full_name, phone
      FROM public.clients
      WHERE status = 'active'
        AND last_service_date IS NOT NULL
        AND last_service_date <= (CURRENT_DATE - INTERVAL '2 years')
        AND (last_service_reminder_at IS NULL OR last_service_reminder_at < last_service_date)
    `);
  } catch (err) {
    logger.error({ err }, "checkServiceMeetingEligibility: query failed");
    return;
  }

  for (const client of result.rows) {
    try {
      const ok = await sendServiceDueToClient({
        id: client.id,
        full_name: client.full_name,
        phone: client.phone,
      });

      if (ok === true) {
        await pool.query(
          `UPDATE public.clients
             SET last_service_reminder_at = CURRENT_DATE,
                 intake_state            = 'collecting',
                 intake_current_slot     = 'welcome',
                 updated_at              = now()
           WHERE id = $1`,
          [client.id],
        );

        const chatId = toChatId(client.phone);
        if (chatId) {
          await pool.query(
            `UPDATE public.conversations
                SET bot_paused = false, bot_paused_until = NULL
              WHERE whatsapp_chat_id = $1`,
            [chatId],
          );
        }
      }
    } catch (err) {
      logger.error({ err, clientId: client.id }, "checkServiceMeetingEligibility: error processing client");
    }
  }
}
