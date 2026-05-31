import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../config/logger.js";
import { sendMessageWithTyping } from "../whatsapp/whatsapp.service.js";
import { toChatId } from "../whatsapp/whatsapp.util.js";
import { TASK_LABELS_HE, formatDueDate } from "./operations.format.js";

export async function notifyStaffTaskOverdue(task: {
  id: string;
  client_id: string;
  type: string;
  due_at: string;
  assigned_to: string;
}): Promise<void> {
  try {
    const { data: client } = await supabaseAdmin
      .from("clients")
      .select("full_name")
      .eq("id", task.client_id)
      .maybeSingle();

    if (!client) {
      logger.warn({ taskId: task.id, clientId: task.client_id }, "notifyStaffTaskOverdue: client not found");
      return;
    }

    const { data: staff } = await supabaseAdmin
      .from("staff")
      .select("full_name, phone")
      .eq("id", task.assigned_to)
      .maybeSingle();

    const chatId = toChatId(staff?.phone ?? null);
    if (!chatId) {
      logger.warn({ taskId: task.id, staffId: task.assigned_to }, "notifyStaffTaskOverdue: staff has no usable phone");
      return;
    }

    const label = TASK_LABELS_HE[task.type] ?? task.type;
    const body = `🔔 תזכורת: המשימה "${label}" עבור הלקוח ${client.full_name} טרם הושלמה (יעד: ${formatDueDate(task.due_at)}). נא לטפל.`;

    await sendMessageWithTyping(chatId, body);
    logger.info({ taskId: task.id, staffId: task.assigned_to }, "notifyStaffTaskOverdue: sent");
  } catch (err) {
    logger.error({ err, taskId: task.id }, "notifyStaffTaskOverdue: unexpected error");
  }
}
