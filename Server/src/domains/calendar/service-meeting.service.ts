import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../config/logger.js";
import { sendMessageWithTyping } from "../whatsapp/whatsapp.service.js";
import { toChatId } from "../whatsapp/whatsapp.util.js";

async function sendServiceDueToClient(client: {
  id: string;
  full_name: string | null;
  phone: string | null;
}): Promise<void> {
  try {
    const chatId = toChatId(client.phone ?? null);
    if (!chatId) {
      logger.warn({ clientId: client.id }, "sendServiceDueToClient: client has no usable phone");
      return;
    }

    const name = client.full_name?.trim();
    const body = [
      `שלום${name ? " " + name : ""} 😊`,
      "עברו שנתיים מאז הפגישה האחרונה שלנו — זה הזמן לפגישת שירות תקופתית.",
      "נשמח לבדוק יחד שהביטוחים שלך עדיין מתאימים לצרכים שלך ולעדכן במידת הצורך.",
      "מתי נוח לך שנקבע פגישה? 📅",
    ].join("\n");

    await sendMessageWithTyping(chatId, body);
    logger.info({ clientId: client.id }, "sendServiceDueToClient: sent");
  } catch (err) {
    logger.error({ err, clientId: client.id }, "sendServiceDueToClient: unexpected error");
  }
}

export async function checkServiceMeetingEligibility(): Promise<void> {
  const twoYearsAgo = new Date();
  twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
  const twoYearsAgoStr = twoYearsAgo.toISOString().split("T")[0]!;

  const { data: clients, error } = await supabaseAdmin
    .from("clients")
    .select("id, full_name, phone, last_service_date")
    .eq("status", "active")
    .or(`last_service_date.is.null,last_service_date.lte.${twoYearsAgoStr}`);

  if (error) {
    logger.error({ error }, "checkServiceMeetingEligibility: query failed");
    return;
  }

  for (const client of clients ?? []) {
    try {
      await sendServiceDueToClient({
        id: client.id as string,
        full_name: client.full_name as string | null,
        phone: client.phone as string | null,
      });
    } catch (err) {
      logger.error({ err, clientId: client.id }, "checkServiceMeetingEligibility: error processing client");
    }
  }
}
