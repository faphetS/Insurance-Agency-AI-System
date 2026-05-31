import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../config/logger.js";
import { createNotification } from "../operations/operations.service.js";
import { sendMessageWithTyping } from "./whatsapp.service.js";
import { toChatId } from "./whatsapp.util.js";

const WANTS_HUMAN_RE =
  /\b(נציג|בן\s*אדם|אנושי|לדבר\s*עם\s*נציג|לא\s*בוט|human|agent|representative|speak\s*to\s*someone)\b/i;

export function wantsHuman(text: string): boolean {
  return WANTS_HUMAN_RE.test(text);
}

export async function handleHumanEscalation(
  conversationId: string,
  chatId: string,
): Promise<void> {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const referenceKey = `escalation:${conversationId}:${today}`;

    // Pause bot for 2 hours
    const pausedUntil = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    await supabaseAdmin
      .from("conversations")
      .update({ bot_paused: true, bot_paused_until: pausedUntil })
      .eq("id", conversationId);

    // Reply to client
    const clientReply = "בקשתך התקבלה. נציג יצור איתך קשר בהקדם.";
    const { idMessage: clientMsgId } = await sendMessageWithTyping(chatId, clientReply);

    // Persist bot reply
    await supabaseAdmin.from("messages").insert({
      conversation_id: conversationId,
      direction: "outbound",
      sent_by: "bot",
      body: clientReply,
      whatsapp_message_id: clientMsgId,
      status: "sent",
    });

    // Resolve assigned staff + owner for notifications
    const { data: conv } = await supabaseAdmin
      .from("conversations")
      .select("client_id")
      .eq("id", conversationId)
      .maybeSingle();

    const clientId = (conv?.client_id as string | null) ?? null;

    let assignedStaffPhone: string | null = null;

    if (clientId) {
      const { data: client } = await supabaseAdmin
        .from("clients")
        .select("assigned_handler_id, assigned_to")
        .eq("id", clientId)
        .maybeSingle();

      const staffId =
        (client?.assigned_handler_id as string | null) ??
        (client?.assigned_to as string | null);

      if (staffId) {
        const { data: staffRow } = await supabaseAdmin
          .from("staff")
          .select("phone")
          .eq("id", staffId)
          .maybeSingle();
        assignedStaffPhone = (staffRow?.phone as string | null) ?? null;
      }
    }

    // Fetch owner
    const { data: ownerRow } = await supabaseAdmin
      .from("staff")
      .select("phone")
      .eq("role", "owner")
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();

    const ownerPhone = (ownerRow?.phone as string | null) ?? null;

    const staffAlertText = `⚠️ לקוח ביקש נציג אנושי. שיחה: ${conversationId}. אנא פנה ללקוח בהקדם.`;

    const notifiedPhones = new Set<string>();

    for (const phone of [assignedStaffPhone, ownerPhone]) {
      if (!phone) continue;
      const staffChatId = toChatId(phone);
      if (!staffChatId || notifiedPhones.has(staffChatId)) continue;
      notifiedPhones.add(staffChatId);
      try {
        await sendMessageWithTyping(staffChatId, staffAlertText);
      } catch (sendErr) {
        logger.warn({ sendErr, staffChatId }, "handleHumanEscalation: failed to notify staff");
      }
    }

    // Create in-app notification (idempotent by reference_key)
    const notif = await createNotification({
      type: "whatsapp_unanswered",
      title: "לקוח ביקש נציג אנושי",
      message: `לקוח בשיחה ${conversationId} ביקש להעביר לנציג אנושי.`,
      severity: "urgent",
      client_id: clientId ?? undefined,
      reference_key: referenceKey,
    });

    logger.info(
      { conversationId, chatId, notifCreated: !!notif },
      "handleHumanEscalation: escalation complete",
    );
  } catch (err) {
    logger.error({ err, conversationId }, "handleHumanEscalation: unexpected error");
  }
}
