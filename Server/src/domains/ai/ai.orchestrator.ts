import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../config/logger.js";
import { generateReply, type ChatTurn } from "./ai.service.js";
import * as whatsappService from "../whatsapp/whatsapp.service.js";

/**
 * Handles an inbound WhatsApp message end-to-end:
 * 1. Guards: bot_paused, bot disabled, auto_reply disabled
 * 2. Builds conversation history
 * 3. Generates reply via AI
 * 4. Persists outbound message row and sends via GreenAPI
 */
export async function handleIncomingMessage(
  conversationId: string,
  incomingText: string,
): Promise<void> {
  // 1. Fetch conversation — check bot_paused
  const { data: conversation, error: convErr } = await supabaseAdmin
    .from("conversations")
    .select("id, whatsapp_chat_id, bot_paused")
    .eq("id", conversationId)
    .single();

  if (convErr || !conversation) {
    logger.error({ conversationId, convErr }, "Conversation not found in orchestrator");
    return;
  }

  if (conversation.bot_paused) {
    logger.info({ conversationId }, "Bot paused — skipping auto-reply");
    return;
  }

  // 2. Fetch bot_settings (singleton row id=1)
  const { data: botSettings, error: settingsErr } = await supabaseAdmin
    .from("bot_settings")
    .select("enabled, auto_reply, system_prompt, model_name")
    .eq("id", 1)
    .single();

  if (settingsErr || !botSettings) {
    logger.warn({ settingsErr }, "bot_settings row not found — skipping auto-reply");
    return;
  }

  if (!botSettings.enabled || !botSettings.auto_reply) {
    logger.info(
      { enabled: botSettings.enabled, auto_reply: botSettings.auto_reply },
      "Bot disabled or auto_reply off — skipping",
    );
    return;
  }

  // 3. Fetch last 20 messages for history (oldest first)
  const { data: messages, error: msgErr } = await supabaseAdmin
    .from("messages")
    .select("direction, body")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(20);

  if (msgErr) {
    logger.error({ conversationId, msgErr }, "Failed to fetch message history");
    return;
  }

  const history: ChatTurn[] = (messages ?? [])
    .filter((m) => m.body)
    .map((m) => ({
      role: m.direction === "inbound" ? "user" : "model",
      text: m.body as string,
    }));

  // Guarantee at least one user turn — avoids "contents are required" from
  // the AI model when history fetch races the insert or message has no text body.
  const trimmed = incomingText?.trim();
  if (trimmed && (history.length === 0 || history[history.length - 1]?.text !== trimmed)) {
    history.push({ role: "user", text: trimmed });
  }

  if (history.length === 0) {
    logger.warn({ conversationId }, "No usable text to reply to — skipping AI");
    return;
  }

  // 4. Generate reply
  let reply: string;
  try {
    reply = await generateReply(history, botSettings.system_prompt, botSettings.model_name);
  } catch (err) {
    logger.error({ conversationId, err }, "generateReply failed");
    return;
  }

  if (!reply.trim()) {
    logger.warn({ conversationId }, "AI returned empty reply — skipping send");
    return;
  }

  // 5. Insert outbound message row with status 'sending'
  const { data: msgRow, error: insertErr } = await supabaseAdmin
    .from("messages")
    .insert({
      conversation_id: conversationId,
      direction: "outbound",
      sent_by: "bot",
      body: reply,
      status: "sent",
    })
    .select("id")
    .single();

  if (insertErr || !msgRow) {
    logger.error({ conversationId, insertErr }, "Failed to insert outbound message");
    return;
  }

  // 6. Send via GreenAPI
  try {
    const { idMessage } = await whatsappService.sendMessage(
      conversation.whatsapp_chat_id,
      reply,
    );

    // Update with whatsapp_message_id and status='sent'
    await supabaseAdmin
      .from("messages")
      .update({ whatsapp_message_id: idMessage, status: "sent" })
      .eq("id", msgRow.id);

    logger.info(
      { conversationId, idMessage },
      "Bot reply sent via WhatsApp",
    );
  } catch (err) {
    logger.error({ conversationId, err }, "Failed to send WhatsApp message");

    await supabaseAdmin
      .from("messages")
      .update({ status: "failed" })
      .eq("id", msgRow.id);
  }

  // 7. Update conversation.last_message_at
  await supabaseAdmin
    .from("conversations")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", conversationId);
}
