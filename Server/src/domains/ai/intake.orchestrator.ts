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
import { analyzeImage, classifyIntakeResponse } from "./ai.service.js";

// ---------------------------------------------------------------------------
// Type helpers — the DB types file predates the migration; cast as needed
// ---------------------------------------------------------------------------

/** Extended client update shape that includes the new intake columns. */
interface ClientIntakeUpdate {
  full_name?: string;
  email?: string | null;
  inquiry_type?: string;
  id_photo_url?: string;
  id_validated?: boolean;
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
  const fullText = `${prompt.text}\n${prompt.footer}`;

  try {
    const { idMessage } = await sendInteractiveButtons(
      chatId,
      prompt.text,
      [...prompt.buttons],
      prompt.footer,
    );
    await persistOutbound(conversationId, fullText, idMessage);
  } catch (err) {
    logger.warn(
      { conversationId, err },
      "intake: interactive buttons failed — falling back to plain text",
    );
    try {
      const buttonList = prompt.buttons
        .map((b) => `• ${b.buttonText}`)
        .join("\n");
      const fallback = `${prompt.text}\n\n${buttonList}\n\n${prompt.footer}`;
      const { idMessage } = await sendMessage(chatId, fallback);
      await persistOutbound(conversationId, fallback, idMessage);
    } catch (fallbackErr) {
      logger.error(
        { conversationId, fallbackErr },
        "intake: sendInquiryPrompt fallback also failed",
      );
    }
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

async function handleWelcome(
  conversationId: string,
  chatId: string,
  clientId: string,
): Promise<void> {
  await sendTextPrompt(conversationId, chatId, "welcome");
  await updateClient(clientId, { intake_current_slot: "full_name" });
}

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

  const result = await classifyIntakeResponse(
    payload.text.trim(),
    "full_name",
    INTAKE_PROMPTS.full_name.text,
    "A person's full name (first and last name). Not a greeting, question, or sentence.",
  );

  if (!result.valid) {
    await sendTextPrompt(conversationId, chatId, "full_name");
    return;
  }

  await updateClient(clientId, { full_name: result.extracted });
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

  // Fast path: valid email regex — no need for LLM
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) {
    await updateClient(clientId, { email: raw });
    await advanceTo(conversationId, chatId, clientId, "inquiry_type");
    return;
  }

  // Fast path: explicit skip
  if (raw.toLowerCase() === "skip") {
    await updateClient(clientId, { email: null });
    await advanceTo(conversationId, chatId, clientId, "inquiry_type");
    return;
  }

  // LLM decides: maybe they said "I don't have one" (→ skip) or asked a question (→ re-ask)
  const result = await classifyIntakeResponse(
    raw,
    "email",
    INTAKE_PROMPTS.email.text,
    'A valid email address, or "skip" if they want to skip. If they indicate they don\'t have email or want to skip, extracted should be "skip".',
  );

  if (!result.valid) {
    await sendTextPrompt(conversationId, chatId, "email");
    return;
  }

  if (result.extracted.toLowerCase() === "skip") {
    await updateClient(clientId, { email: null });
  } else {
    await updateClient(clientId, { email: result.extracted });
  }
  await advanceTo(conversationId, chatId, clientId, "inquiry_type");
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

  // Fast path: exact match against known types
  const value = payload.text.trim().toLowerCase();
  if ((INQUIRY_TYPES as readonly string[]).includes(value)) {
    await updateClient(clientId, { inquiry_type: value as InquiryType });
    await advanceTo(conversationId, chatId, clientId, "id_photo");
    return;
  }

  // LLM: "I need car insurance" → "vehicle", "life insurance please" → "life"
  const result = await classifyIntakeResponse(
    payload.text.trim(),
    "inquiry_type",
    INTAKE_PROMPTS.inquiry_type.text,
    `One of these insurance types: ${INQUIRY_TYPES.join(", ")}. Extract the matching type keyword.`,
  );

  if (result.valid && (INQUIRY_TYPES as readonly string[]).includes(result.extracted.toLowerCase())) {
    await updateClient(clientId, { inquiry_type: result.extracted.toLowerCase() as InquiryType });
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

  await supabaseAdmin.from("documents").insert({
    client_id: clientId,
    type: "id_photo",
    file_url: payload.fileUrl,
    file_name: payload.fileName ?? null,
    mime_type: payload.mimeType ?? null,
  });

  await updateClient(clientId, { id_photo_url: payload.fileUrl });

  // OCR validation via Gemini
  try {
    const ocrResult = await analyzeImage(
      payload.fileUrl,
      'Is this a valid, readable government-issued ID document? Check: (1) Is the image clear and not blurry? (2) Can you read a name and ID number? (3) Is it an actual ID document? Respond ONLY with JSON: {"valid": true, "reason": "short explanation"} or {"valid": false, "reason": "short explanation"}',
    );

    const cleaned = ocrResult.replace(/```json\n?|\n?```/g, "").trim();
    const parsed = JSON.parse(cleaned) as { valid: boolean; reason: string };

    if (!parsed.valid) {
      const rePrompt = INTAKE_PROMPTS.id_photo_invalid.text.replace(
        "{reason}",
        parsed.reason,
      );
      try {
        const { idMessage } = await sendMessage(chatId, rePrompt);
        await persistOutbound(conversationId, rePrompt, idMessage);
      } catch (sendErr) {
        logger.error({ sendErr }, "intake: failed to send OCR rejection");
      }
      return;
    }
  } catch (err) {
    logger.warn({ err }, "OCR validation failed — accepting photo and continuing");
  }

  await updateClient(clientId, { id_validated: true });
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
    case "welcome":
      await handleWelcome(conversationId, chatId, clientId);
      break;
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
