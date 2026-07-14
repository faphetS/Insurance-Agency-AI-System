import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { supabaseAdmin } from "../../config/supabase.js";
import { handleIntake } from "../ai/intake.orchestrator.js";
import { assignStaffToMeeting } from "../meetings/meeting-handoff.service.js";
import { mirrorInboundHook, type ConversationalChannel } from "./transport.resolve.js";
import type { MessagePayload } from "./whatsapp.validator.js";
import { isStaffChat, toChatId } from "./whatsapp.util.js";

export interface InboundCustomerMessage {
  chatId: string;
  senderName: string | null;
  messageId: string;
  payload: MessagePayload;
  channel: ConversationalChannel;
}

/**
 * Shared inbound gate chain — runs post-ACK for both providers (GreenAPI
 * controller and Meta webhook controller): owner guard → staff intercept →
 * conversation upsert (+ channel stamp) → message insert (dedup) → allowlist →
 * client link/create → mirror hook → intake.
 */
export async function processInboundCustomerMessage(
  msg: InboundCustomerMessage,
): Promise<void> {
  const { chatId, senderName, messageId, payload, channel } = msg;

  // Derive the body to store in messages table
  const messageBody =
    payload.kind === "text"
      ? payload.text
      : payload.kind === "image"
        ? payload.caption ?? "[image]"
        : payload.caption ?? "[document]";

  // Derive phone from chatId (format: "1234567890@c.us" or "group@g.us")
  const contactPhone = chatId.split("@")[0] ?? chatId;

  // The owner number is OPERATIONAL-ONLY: it must never enter the lead/intake
  // conversational flow. Handle its operational buttons (staff assignment) and
  // silently ignore anything else.
  const ownerChatId = toChatId(env.SUMMARY_RECIPIENT_PHONE ?? null);
  if (ownerChatId && chatId === ownerChatId) {
    const buttonId = payload.kind === "text" && payload.isButtonReply ? payload.text : "";
    const assignMatch = /^assign_staff:([^:]+):([^:]+)$/.exec(buttonId);
    if (assignMatch) {
      try {
        await assignStaffToMeeting(assignMatch[1]!, assignMatch[2]!, chatId);
      } catch (err) {
        logger.error({ err, chatId }, "assignStaffToMeeting failed");
      }
    } else {
      logger.info({ chatId }, "owner message ignored — operational-only number (no lead/intake)");
    }
    return;
  }

  // Staff intercept — if this chat belongs to a staff member, log and skip.
  const staff = await isStaffChat(chatId);
  if (staff) {
    return;
  }

  // Upsert conversation by whatsapp_chat_id
  const conversationUpsertData: Record<string, unknown> = {
    whatsapp_chat_id: chatId,
    contact_name: senderName,
    contact_phone: contactPhone,
    last_message_at: new Date().toISOString(),
    channel,
  };

  const { data: conversation, error: convErr } = await supabaseAdmin
    .from("conversations")
    .upsert(conversationUpsertData, { onConflict: "whatsapp_chat_id", ignoreDuplicates: false })
    .select("id")
    .single();

  if (convErr || !conversation) {
    logger.error({ chatId, convErr }, "Failed to upsert conversation");
    return;
  }

  const conversationId = conversation.id;

  // Insert inbound message — unique index rejects duplicate whatsapp_message_id
  const { data: inserted, error: msgErr } = await supabaseAdmin
    .from("messages")
    .insert({
      conversation_id: conversationId,
      direction: "inbound",
      sent_by: "customer",
      body: messageBody,
      whatsapp_message_id: messageId,
      status: "received",
    })
    .select("id")
    .maybeSingle();

  if (msgErr) {
    if (msgErr.code === "23505") {
      logger.debug({ idMessage: messageId }, "Duplicate webhook — skipping");
      return;
    }
    logger.error({ conversationId, msgErr }, "Failed to insert inbound message");
  }

  if (!inserted) {
    return;
  }

  // Reply allowlist gate: when set, non-allowlisted senders are stored but get no reply.
  if (env.REPLY_ALLOWLIST.length > 0) {
    const senderDigits = contactPhone.replace(/\D/g, "");
    const allowed = env.REPLY_ALLOWLIST.some(
      (entry) => entry.replace(/\D/g, "") === senderDigits,
    );
    if (!allowed) {
      logger.info({ conversationId, chatId }, "sender not in reply allowlist — skipping conversational bot");
      return;
    }
  }

  // Link client if conversation has no client_id yet
  let linkedClientId: string | null = null;

  try {
    const { data: convRow } = await supabaseAdmin
      .from("conversations")
      .select("client_id")
      .eq("id", conversationId)
      .single();

    if (convRow && convRow.client_id === null) {
      // Look for an existing client keyed by phone
      const { data: existingClient } = await supabaseAdmin
        .from("clients")
        .select("id")
        .eq("phone", contactPhone)
        .maybeSingle();

      let clientId: string | null = existingClient?.id ?? null;

      if (!clientId) {
        // Need a valid assigned_to staff id — grab any active staff member as fallback
        const { data: staffRow } = await supabaseAdmin
          .from("staff")
          .select("id")
          .eq("is_active", true)
          .limit(1)
          .maybeSingle();

        if (staffRow) {
          const { data: newClient, error: clientErr } = await supabaseAdmin
            .from("clients")
            .insert({
              full_name: senderName ?? contactPhone,
              phone: contactPhone,
              status: "new",
              pipeline_stage: "new_lead",
              source_channel: "wa",
              inquiry_type: "general",
              id_validated: false,
              assigned_to: staffRow.id,
            })
            .select("id")
            .single();

          if (clientErr) {
            logger.warn(
              { contactPhone, clientErr },
              "Failed to insert new client from webhook — skipping link",
            );
          } else {
            clientId = newClient?.id ?? null;
            logger.info(
              { contactPhone, clientId },
              "Created new client from inbound WhatsApp",
            );
          }
        } else {
          logger.warn(
            { contactPhone },
            "No active staff found — cannot assign new client, skipping link",
          );
        }
      }

      if (clientId) {
        const { error: linkErr } = await supabaseAdmin
          .from("conversations")
          .update({ client_id: clientId })
          .eq("id", conversationId);

        if (linkErr) {
          logger.warn(
            { conversationId, clientId, linkErr },
            "Failed to link client_id to conversation",
          );
        } else {
          logger.info(
            { conversationId, clientId },
            "Linked conversation to client",
          );
          linkedClientId = clientId;
        }
      }
    } else if (convRow?.client_id) {
      linkedClientId = convRow.client_id;
    }
  } catch (clientLinkErr) {
    logger.error(
      { conversationId, clientLinkErr },
      "Unexpected error during client link — continuing",
    );
  }

  void mirrorInboundHook(chatId, payload, senderName).catch((err: unknown) =>
    logger.warn({ err, chatId }, "mirrorInboundHook failed — continuing"),
  );

  try {
    if (linkedClientId) {
      await handleIntake(
        conversationId,
        linkedClientId,
        chatId,
        payload,
      );
    }
  } catch (err) {
    logger.error({ conversationId, err }, "Async message processing error");
  }
}
