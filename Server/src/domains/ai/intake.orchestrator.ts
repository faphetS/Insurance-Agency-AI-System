import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../config/logger.js";
import {
  sendMessage,
  sendInteractiveButtons,
} from "../whatsapp/whatsapp.service.js";
import type { MessagePayload } from "../whatsapp/whatsapp.validator.js";
import {
  INTAKE_PROMPTS,
  INQUIRY_TYPES,
  type InquiryType,
  type IntakeSlot,
} from "./intake.prompts.js";

// ---------------------------------------------------------------------------
// Type helpers — the DB types file predates the migration; cast as needed
// ---------------------------------------------------------------------------

/** Extended client update shape that includes the new intake columns. */
interface ClientIntakeUpdate {
  full_name?: string;
  email?: string | null;
  inquiry_type?: string;
  id_photo_url?: string;
  poa_doc_url?: string;
  intake_state?: string;
  intake_current_slot?: string;
  intake_completed_at?: string | null;
  pipeline_stage?: string | null;
}

function updateClient(id: string, values: ClientIntakeUpdate) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return supabaseAdmin.from("clients").update(values as any).eq("id", id);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Persist a bot-sent intake message to the messages table. */
async function persistOutbound(
  conversationId: string,
  text: string,
  idMessage: string,
): Promise<void> {
  const { error } = await supabaseAdmin.from("messages").insert({
    conversation_id: conversationId,
    direction: "outbound",
    sent_by: "bot",
    body: text,
    status: "sent",
    whatsapp_message_id: idMessage,
  });
  if (error) {
    logger.warn(
      { conversationId, error },
      "intake: failed to persist outbound message",
    );
  }
}

/** Send the plain-text prompt for a given slot and persist it. */
async function sendTextPrompt(
  conversationId: string,
  chatId: string,
  slot: IntakeSlot,
): Promise<void> {
  const prompt = INTAKE_PROMPTS[slot];
  const text = prompt.text;
  try {
    const { idMessage } = await sendMessage(chatId, text);
    await persistOutbound(conversationId, text, idMessage);
  } catch (err) {
    logger.error({ conversationId, slot, err }, "intake: sendTextPrompt failed");
  }
}

/** Send the interactive-buttons prompt for inquiry_type and persist it. */
async function sendInquiryPrompt(
  conversationId: string,
  chatId: string,
): Promise<void> {
  const prompt = INTAKE_PROMPTS.inquiry_type;
  try {
    const { idMessage } = await sendInteractiveButtons(
      chatId,
      prompt.text,
      [...prompt.buttons],
      prompt.footer,
    );
    await persistOutbound(
      conversationId,
      `${prompt.text}\n${prompt.footer}`,
      idMessage,
    );
  } catch (err) {
    logger.error(
      { conversationId, err },
      "intake: sendInquiryPrompt failed",
    );
  }
}

/** Advance intake_current_slot to next and send the corresponding question. */
async function advanceTo(
  conversationId: string,
  chatId: string,
  clientId: string,
  next: IntakeSlot,
): Promise<void> {
  const { error } = await updateClient(clientId, {
    intake_current_slot: next,
  });

  if (error) {
    logger.error(
      { conversationId, clientId, next, error },
      "intake: failed to advance slot",
    );
    return;
  }

  if (next === "done") {
    await finalize(conversationId, chatId, clientId);
    return;
  }

  if (next === "inquiry_type") {
    await sendInquiryPrompt(conversationId, chatId);
  } else {
    await sendTextPrompt(conversationId, chatId, next);
  }
}

/** Mark intake complete, flip pipeline_stage, send done message. */
async function finalize(
  conversationId: string,
  chatId: string,
  clientId: string,
): Promise<void> {
  const { error } = await updateClient(clientId, {
    intake_state: "completed",
    intake_current_slot: "done",
    intake_completed_at: new Date().toISOString(),
    pipeline_stage: "meeting_scheduling",
  });

  if (error) {
    logger.error(
      { conversationId, clientId, error },
      "intake: failed to finalize",
    );
    return;
  }

  const doneText = INTAKE_PROMPTS.done.text;
  try {
    const { idMessage } = await sendMessage(chatId, doneText);
    await persistOutbound(conversationId, doneText, idMessage);
  } catch (err) {
    logger.error({ conversationId, err }, "intake: failed to send done message");
  }

  logger.info({ conversationId, clientId }, "intake: completed");
}

// ---------------------------------------------------------------------------
// Per-slot handlers
// ---------------------------------------------------------------------------

async function handleFullName(
  conversationId: string,
  chatId: string,
  clientId: string,
  payload: MessagePayload,
): Promise<void> {
  if (payload.kind !== "text" || payload.text.trim().length < 2) {
    await sendTextPrompt(conversationId, chatId, "full_name");
    return;
  }

  const name = payload.text.trim();
  await updateClient(clientId, { full_name: name });
  await advanceTo(conversationId, chatId, clientId, "email");
}

async function handleEmail(
  conversationId: string,
  chatId: string,
  clientId: string,
  payload: MessagePayload,
): Promise<void> {
  if (payload.kind !== "text") {
    await sendTextPrompt(conversationId, chatId, "email");
    return;
  }

  const raw = payload.text.trim();

  if (raw.toLowerCase() === "skip") {
    await updateClient(clientId, { email: null });
    await advanceTo(conversationId, chatId, clientId, "inquiry_type");
    return;
  }

  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) {
    await updateClient(clientId, { email: raw });
    await advanceTo(conversationId, chatId, clientId, "inquiry_type");
    return;
  }

  // Invalid — resend same question
  await sendTextPrompt(conversationId, chatId, "email");
}

async function handleInquiryType(
  conversationId: string,
  chatId: string,
  clientId: string,
  payload: MessagePayload,
): Promise<void> {
  if (payload.kind !== "text") {
    await sendInquiryPrompt(conversationId, chatId);
    return;
  }

  const value = payload.text.trim().toLowerCase() as InquiryType;

  if ((INQUIRY_TYPES as readonly string[]).includes(value)) {
    await updateClient(clientId, { inquiry_type: value });
    await advanceTo(conversationId, chatId, clientId, "id_photo");
    return;
  }

  await sendInquiryPrompt(conversationId, chatId);
}

async function handleIdPhoto(
  conversationId: string,
  chatId: string,
  clientId: string,
  payload: MessagePayload,
): Promise<void> {
  if (payload.kind !== "image") {
    await sendTextPrompt(conversationId, chatId, "id_photo");
    return;
  }

  // Insert document record
  await supabaseAdmin.from("documents").insert({
    client_id: clientId,
    type: "id_photo",
    file_url: payload.fileUrl,
    file_name: payload.fileName ?? null,
    mime_type: payload.mimeType ?? null,
  });

  // Update client id_photo_url (id_validated stays false — OCR pending)
  await updateClient(clientId, { id_photo_url: payload.fileUrl });

  await advanceTo(conversationId, chatId, clientId, "poa");
}

async function handlePoa(
  conversationId: string,
  chatId: string,
  clientId: string,
  payload: MessagePayload,
): Promise<void> {
  if (payload.kind === "text" && payload.text.trim().toLowerCase() === "skip") {
    await advanceTo(conversationId, chatId, clientId, "done");
    return;
  }

  if (payload.kind === "image" || payload.kind === "document") {
    await supabaseAdmin.from("documents").insert({
      client_id: clientId,
      type: "poa",
      file_url: payload.fileUrl,
      file_name: payload.fileName ?? null,
      mime_type: payload.mimeType ?? null,
    });

    await updateClient(clientId, { poa_doc_url: payload.fileUrl });
    await advanceTo(conversationId, chatId, clientId, "done");
    return;
  }

  // Invalid — resend
  await sendTextPrompt(conversationId, chatId, "poa");
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function handleIntake(
  conversationId: string,
  clientId: string,
  chatId: string,
  payload: MessagePayload,
): Promise<{ consumed: boolean }> {
  // 0. Respect bot_settings.enabled — if bot is off, skip intake entirely
  const { data: botSettings } = await supabaseAdmin
    .from("bot_settings")
    .select("enabled")
    .eq("id", 1)
    .single();

  if (!botSettings?.enabled) {
    logger.info({ conversationId }, "intake: bot disabled — skipping");
    return { consumed: false };
  }

  // 0b. Respect per-conversation pause
  const { data: conv } = await supabaseAdmin
    .from("conversations")
    .select("bot_paused, bot_paused_until")
    .eq("id", conversationId)
    .single();

  if (conv?.bot_paused) {
    if (conv.bot_paused_until && new Date(conv.bot_paused_until) <= new Date()) {
      await supabaseAdmin
        .from("conversations")
        .update({ bot_paused: false, bot_paused_until: null })
        .eq("id", conversationId);
      logger.info({ conversationId }, "intake: cooldown expired — auto-resumed");
    } else {
      logger.info({ conversationId }, "intake: conversation paused — skipping");
      return { consumed: false };
    }
  }

  // 1. Load intake state
  const { data: client, error: clientErr } = await supabaseAdmin
    .from("clients")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .select("intake_state, intake_current_slot" as any)
    .eq("id", clientId)
    .single();

  if (clientErr || !client) {
    logger.error(
      { conversationId, clientId, clientErr },
      "intake: failed to load client",
    );
    return { consumed: false };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row = client as any as {
    intake_state: string | null;
    intake_current_slot: string | null;
  };

  const state = row.intake_state;
  const slot = row.intake_current_slot;

  // 2. If already completed or at done slot, fall through to AI
  if (state === "completed" || slot === "done") {
    return { consumed: false };
  }

  logger.info({ conversationId, clientId, slot }, "intake: handling slot");

  // 3. Dispatch
  switch (slot as IntakeSlot) {
    case "full_name":
      await handleFullName(conversationId, chatId, clientId, payload);
      break;
    case "email":
      await handleEmail(conversationId, chatId, clientId, payload);
      break;
    case "inquiry_type":
      await handleInquiryType(conversationId, chatId, clientId, payload);
      break;
    case "id_photo":
      await handleIdPhoto(conversationId, chatId, clientId, payload);
      break;
    case "poa":
      await handlePoa(conversationId, chatId, clientId, payload);
      break;
    case "done":
      return { consumed: false };
    default:
      logger.warn(
        { conversationId, slot },
        "intake: unknown slot — falling through",
      );
      return { consumed: false };
  }

  return { consumed: true };
}
