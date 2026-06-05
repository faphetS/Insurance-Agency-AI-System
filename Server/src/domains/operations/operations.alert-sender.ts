import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../config/logger.js";
import { sendStaffMessage } from "../whatsapp/whatsapp.service.js";
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

// Sends to the assigned agent, NOT the client directly — the agent is responsible
// for scheduling the meeting, and unsolicited outreach to clients must be avoided.
export async function sendServiceDueInvite(client: {
  id: string;
  full_name: string | null;
  assigned_handler_id: string | null;
  assigned_to: string | null;
}): Promise<void> {
  try {
    const staffId = client.assigned_handler_id ?? client.assigned_to;
    if (!staffId) {
      logger.warn({ clientId: client.id }, "sendServiceDueInvite: no staff assigned to client");
      return;
    }

    const { data: staff } = await supabaseAdmin
      .from("staff")
      .select("full_name, phone")
      .eq("id", staffId)
      .maybeSingle();

    const chatId = toChatId(staff?.phone ?? null);
    if (!chatId) {
      logger.warn({ clientId: client.id, staffId }, "sendServiceDueInvite: staff has no usable phone");
      return;
    }

    const name = client.full_name ?? client.id;
    const body = `📅 פגישת שירות דו-שנתית: הלקוח ${name} זכאי/ת לפגישת שירות. כדאי לקבוע מועד.`;

    await sendStaffMessage(chatId, body);
    logger.info({ clientId: client.id, staffId }, "sendServiceDueInvite: sent");
  } catch (err) {
    logger.error({ err, clientId: client.id }, "sendServiceDueInvite: unexpected error");
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
    const body = `🚨 חריגת SLA: הלקוח ${name} תקוע בשלב "${stage}" מעבר לזמן. נא לטפל.`;

    await sendStaffMessage(chatId, body);
    logger.info({ clientId: client.id, staffId }, "sendSlaAlert: sent");
  } catch (err) {
    logger.error({ err, clientId: client.id }, "sendSlaAlert: unexpected error");
  }
}
