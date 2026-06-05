import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../config/logger.js";
import { sendStaffMessage, sendMessageWithTyping } from "../whatsapp/whatsapp.service.js";
import { toChatId } from "../whatsapp/whatsapp.util.js";
import { TASK_LABELS_HE } from "./operations.format.js";

export async function sendOverdueAlert(task: {
  id: string;
  client_id: string;
  type: string;
  assigned_to: string;
}): Promise<void> {
  try {
    const { data: client } = await supabaseAdmin
      .from("clients")
      .select("full_name")
      .eq("id", task.client_id)
      .maybeSingle();

    if (!client) {
      logger.warn({ taskId: task.id, clientId: task.client_id }, "sendOverdueAlert: client not found");
      return;
    }

    const { data: staff } = await supabaseAdmin
      .from("staff")
      .select("full_name, phone")
      .eq("id", task.assigned_to)
      .maybeSingle();

    const chatId = toChatId(staff?.phone ?? null);
    if (!chatId) {
      logger.warn({ taskId: task.id, staffId: task.assigned_to }, "sendOverdueAlert: staff has no usable phone");
      return;
    }

    const label = TASK_LABELS_HE[task.type] ?? task.type;
    const body = `🔴 משימה באיחור: "${label}" עבור ${client.full_name as string} — נא לטפל.`;

    await sendStaffMessage(chatId, body);
    logger.info({ taskId: task.id, staffId: task.assigned_to }, "sendOverdueAlert: sent");
  } catch (err) {
    logger.error({ err, taskId: task.id }, "sendOverdueAlert: unexpected error");
  }
}

// Biennial retention outreach: messages the CLIENT directly on the conversational
// line (instance #1), proactively inviting them to book a periodic service meeting
// ~2 years after their last one. This is a retention strategy — not a staff alert.
export async function sendServiceDueToClient(client: {
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

export async function sendSlaAlert(client: {
  id: string;
  full_name: string | null;
  derived_stage: string | null;
}): Promise<void> {
  try {
    const { data: clientRow } = await supabaseAdmin
      .from("clients")
      .select("assigned_handler_id, assigned_to")
      .eq("id", client.id)
      .maybeSingle();

    const staffId =
      (clientRow?.assigned_handler_id as string | null) ??
      (clientRow?.assigned_to as string | null);

    if (!staffId) {
      logger.warn({ clientId: client.id }, "sendSlaAlert: no staff assigned to client");
      return;
    }

    const { data: staff } = await supabaseAdmin
      .from("staff")
      .select("full_name, phone")
      .eq("id", staffId)
      .maybeSingle();

    const chatId = toChatId(staff?.phone ?? null);
    if (!chatId) {
      logger.warn({ clientId: client.id, staffId }, "sendSlaAlert: staff has no usable phone");
      return;
    }

    const name = client.full_name ?? client.id;
    const stage = client.derived_stage ?? "לא ידוע";
    const body = `🚨 חריגה מזמן טיפול: הלקוח ${name} תקוע בשלב "${stage}" מעבר למועד היעד. נא לטפל.`;

    await sendStaffMessage(chatId, body);
    logger.info({ clientId: client.id, staffId }, "sendSlaAlert: sent");
  } catch (err) {
    logger.error({ err, clientId: client.id }, "sendSlaAlert: unexpected error");
  }
}
