import { supabaseAdmin } from "../../config/supabase.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import {
  sendMessageWithTyping,
  sendInteractiveButtonsWithTyping,
} from "../whatsapp/whatsapp.service.js";
import type { MessagePayload } from "../whatsapp/whatsapp.validator.js";
import {
  INTAKE_PROMPTS,
  INQUIRY_TYPES,
  type InquiryType,
  type IntakeSlot,
} from "./intake.prompts.js";
import { analyzeImage, classifyComplexity, classifyIntakeResponse } from "./ai.service.js";
import { createNotification } from "../operations/operations.service.js";
import { persistRemoteFile, extFor } from "../../lib/storage.js";

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
  complexity?: string | null;
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
  slot: Exclude<IntakeSlot, "welcome">,
): Promise<void> {
  const prompt = INTAKE_PROMPTS[slot];
  const text = prompt.text;
  try {
    const { idMessage } = await sendMessageWithTyping(chatId, text);
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
    const { idMessage } = await sendInteractiveButtonsWithTyping(
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
      const { idMessage } = await sendMessageWithTyping(chatId, fallback);
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
    await sendTextPrompt(conversationId, chatId, next as Exclude<IntakeSlot, "welcome">);
  }
}

/** Mark intake complete, flip pipeline_stage, send done message. */
async function finalize(
  conversationId: string,
  chatId: string,
  clientId: string,
): Promise<void> {
  // Classify case complexity before marking complete — default to 'simple' on any error.
  const { data: clientForComplexity } = await supabaseAdmin
    .from("clients")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .select("inquiry_type, poa_doc_url, email" as any)
    .eq("id", clientId)
    .maybeSingle();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const clientRow = clientForComplexity as any as {
    inquiry_type?: string | null;
    poa_doc_url?: string | null;
    email?: string | null;
  } | null;

  const complexity = await classifyComplexity(
    clientRow?.inquiry_type ?? "unknown",
    { poa_doc_url: clientRow?.poa_doc_url, email: clientRow?.email },
  );

  const { error } = await updateClient(clientId, {
    intake_state: "completed",
    intake_current_slot: "done",
    intake_completed_at: new Date().toISOString(),
    pipeline_stage: "meeting_scheduling",
    complexity,
  });

  if (error) {
    logger.error(
      { conversationId, clientId, error },
      "intake: failed to finalize",
    );
    return;
  }

  if (complexity === "complex") {
    const notified = await createNotification({
      type: "complex_case",
      title: "תיק מורכב",
      message: `לקוח ${clientId} סווג כתיק מורכב (סוג פנייה: ${clientRow?.inquiry_type ?? "unknown"})`,
      severity: "warning",
      client_id: clientId,
      reference_key: `complex_case:${clientId}`,
    });
    if (notified) {
      logger.info({ clientId, complexity }, "intake: complex case notification created");
    }
  }

  // Insert pending meeting row so booking-sync can match it when the event arrives
  const now = new Date().toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabaseAdmin as any)
    .from("meetings")
    .insert({
      client_id: clientId,
      conversation_id: conversationId,
      type: "google_meet",
      scheduled_at: now,
      status: "pending_booking",
      created_at: now,
      updated_at: now,
    });

  const doneText = `${INTAKE_PROMPTS.done.text}\n\nלקביעת הפגישה: ${env.GOOGLE_CALENDAR_BOOKING_URL}`;
  try {
    const { idMessage } = await sendMessageWithTyping(chatId, doneText);
    await persistOutbound(conversationId, doneText, idMessage);
  } catch (err) {
    logger.error({ conversationId, err }, "intake: failed to send done message");
  }

  await supabaseAdmin
    .from("conversations")
    .update({ bot_paused: true })
    .eq("id", conversationId);

  logger.info({ conversationId, clientId }, "intake: completed");
}

async function persistIntakeFile(
  clientId: string,
  kind: "id_photo" | "poa",
  payload: Extract<MessagePayload, { kind: "image" | "document" }>,
): Promise<string | null> {
  const ext = extFor(payload.mimeType, payload.fileName);
  const destPath = `clients/${clientId}/${kind}_${Date.now()}.${ext}`;
  const stored = await persistRemoteFile(payload.fileUrl, destPath, payload.mimeType);
  if (!stored) {
    logger.warn({ clientId, kind }, "intake: file persist failed");
    return null;
  }
  return stored;
}

// ---------------------------------------------------------------------------
// Per-slot handlers
// ---------------------------------------------------------------------------

async function handleWelcome(
  conversationId: string,
  chatId: string,
  clientId: string,
): Promise<void> {
  const { text1, text2 } = INTAKE_PROMPTS.welcome;
  try {
    const { idMessage: id1 } = await sendMessageWithTyping(chatId, text1);
    await persistOutbound(conversationId, text1, id1);
    const { idMessage: id2 } = await sendMessageWithTyping(chatId, text2);
    await persistOutbound(conversationId, text2, id2);
  } catch (err) {
    logger.error({ conversationId, err }, "intake: handleWelcome send failed");
  }
  const { error } = await updateClient(clientId, { intake_current_slot: "full_name" });
  if (error) {
    logger.error(
      { conversationId, clientId, error },
      "intake: handleWelcome failed to advance slot to full_name",
    );
  }
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

  const result = await classifyIntakeResponse(
    raw,
    "email",
    INTAKE_PROMPTS.email.text,
    'A valid email address.',
  );

  if (!result.valid) {
    await sendTextPrompt(conversationId, chatId, "email");
    return;
  }

  await updateClient(clientId, { email: result.extracted });
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

  // OCR validation first — only persist on success (don't store rejected IDs)
  try {
    const ocrResult = await analyzeImage(
      payload.fileUrl,
      'Is this a government-issued ID document (passport, driver\'s license, national ID card, etc.)? Only check that the image shows an ID document and is readable. Do NOT judge authenticity or check expiration dates. Respond ONLY with JSON: {"valid": true, "reason": "<short explanation IN HEBREW>"} or {"valid": false, "reason": "<short explanation IN HEBREW>"}. The "reason" value MUST be in Hebrew with gender-neutral phrasing (use infinitives like לשלוח, impersonal forms like נדרש, avoid אתה/את).',
    );

    const cleaned = ocrResult.replace(/```json\n?|\n?```/g, "").trim();
    const parsed = JSON.parse(cleaned) as { valid: boolean; reason: string };

    if (!parsed.valid) {
      const rePrompt = INTAKE_PROMPTS.id_photo_invalid.text.replace(
        "{reason}",
        parsed.reason,
      );
      try {
        const { idMessage } = await sendMessageWithTyping(chatId, rePrompt);
        await persistOutbound(conversationId, rePrompt, idMessage);
      } catch (sendErr) {
        logger.error({ sendErr }, "intake: failed to send OCR rejection");
      }
      return;
    }
  } catch (err) {
    logger.warn({ err }, "intake: OCR validation failed — requesting resend");
    const retryText = "לא ניתן לקרוא את התמונה, נא לשלוח מחדש תמונה ברורה של תעודת הזהות.";
    try {
      const { idMessage } = await sendMessageWithTyping(chatId, retryText);
      await persistOutbound(conversationId, retryText, idMessage);
    } catch (sendErr) {
      logger.error({ sendErr }, "intake: failed to send OCR error message");
    }
    return;
  }

  const ref = await persistIntakeFile(clientId, "id_photo", payload);

  if (!ref) {
    const retryText = "לא הצלחנו לשמור את הקובץ, נא לשלוח מחדש את תעודת הזהות.";
    try {
      const { idMessage } = await sendMessageWithTyping(chatId, retryText);
      await persistOutbound(conversationId, retryText, idMessage);
    } catch (sendErr) {
      logger.error({ sendErr }, "intake: failed to send file-persist error message");
    }
    return;
  }

  await supabaseAdmin.from("documents").insert({
    client_id: clientId,
    type: "id_photo",
    file_url: ref,
    file_name: payload.fileName ?? null,
    mime_type: payload.mimeType ?? null,
  });

  await updateClient(clientId, { id_photo_url: ref, id_validated: true });
  await advanceTo(conversationId, chatId, clientId, "poa");
}

const POA_SKIP_EXACT = new Set([
  "skip", "no", "none",
  "דלג", "לא", "אין",
]);

function isPoaSkip(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (POA_SKIP_EXACT.has(t)) return true;
  return /\bאין\b|\bדלג\b|don'?t have|no poa/i.test(text);
}

async function handlePoa(
  conversationId: string,
  chatId: string,
  clientId: string,
  payload: MessagePayload,
): Promise<void> {
  if (payload.kind === "text" && isPoaSkip(payload.text)) {
    await advanceTo(conversationId, chatId, clientId, "done");
    return;
  }

  if (payload.kind === "image" || payload.kind === "document") {
    const ref = await persistIntakeFile(clientId, "poa", payload);

    if (!ref) {
      const retryText = "לא הצלחנו לשמור את הקובץ, נא לשלוח מחדש את ייפוי הכוח.";
      try {
        const { idMessage } = await sendMessageWithTyping(chatId, retryText);
        await persistOutbound(conversationId, retryText, idMessage);
      } catch (sendErr) {
        logger.error({ sendErr }, "intake: failed to send poa file-persist error message");
      }
      return;
    }

    await supabaseAdmin.from("documents").insert({
      client_id: clientId,
      type: "poa",
      file_url: ref,
      file_name: payload.fileName ?? null,
      mime_type: payload.mimeType ?? null,
    });

    await updateClient(clientId, { poa_doc_url: ref });
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
