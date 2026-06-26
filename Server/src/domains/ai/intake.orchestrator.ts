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
import { validateIdPhoto, classifyComplexity, classifyIntakeResponse } from "./ai.service.js";
import { fetchRemoteFile } from "../../lib/storage.js";
import { uploadLeadDocument } from "../integrations/google/google.drive.js";
import { mirrorLeadToSheet } from "../integrations/google/leads-mirror.service.js";

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
  id_number?: string | null;
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

/** Send an interactive-buttons prompt for any button-bearing slot and persist it. */
async function sendButtonPrompt(
  conversationId: string,
  chatId: string,
  slot: "client_type" | "team_routing" | "inquiry_type",
): Promise<void> {
  const prompt = INTAKE_PROMPTS[slot];
  const footer = "footer" in prompt ? prompt.footer : undefined;
  const fullText = footer ? `${prompt.text}\n${footer}` : prompt.text;

  try {
    const { idMessage } = await sendInteractiveButtonsWithTyping(
      chatId,
      prompt.text,
      [...prompt.buttons],
      footer,
    );
    await persistOutbound(conversationId, fullText, idMessage);
  } catch (err) {
    logger.warn(
      { conversationId, slot, err },
      "intake: interactive buttons failed — falling back to plain text",
    );
    try {
      const buttonList = prompt.buttons
        .map((b) => `• ${b.buttonText}`)
        .join("\n");
      const fallback = footer
        ? `${prompt.text}\n\n${buttonList}\n\n${footer}`
        : `${prompt.text}\n\n${buttonList}`;
      const { idMessage } = await sendMessageWithTyping(chatId, fallback);
      await persistOutbound(conversationId, fallback, idMessage);
    } catch (fallbackErr) {
      logger.error(
        { conversationId, slot, fallbackErr },
        "intake: sendButtonPrompt fallback also failed",
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

  try {
    await mirrorLeadToSheet(clientId);
  } catch (err) {
    logger.warn({ err, clientId }, "intake: advanceTo lead sheet sync failed");
  }

  if (next === "done") {
    await finalize(conversationId, chatId, clientId);
    return;
  }

  const prompt = INTAKE_PROMPTS[next as keyof typeof INTAKE_PROMPTS];
  if ("buttons" in prompt) {
    await sendButtonPrompt(conversationId, chatId, next as "client_type" | "team_routing" | "inquiry_type");
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
    logger.info({ clientId, complexity }, "intake: complex case flagged");
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

  try {
    await mirrorLeadToSheet(clientId);
  } catch (err) {
    logger.error({ err, clientId }, "finalize: lead sheet mirror failed");
  }

  await supabaseAdmin
    .from("conversations")
    .update({ bot_paused: true })
    .eq("id", conversationId);

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
  await advanceTo(conversationId, chatId, clientId, "client_type");
}

async function handleClientType(
  conversationId: string,
  chatId: string,
  clientId: string,
  _payload: MessagePayload,
): Promise<void> {
  // TODO: future routing will branch on _payload.text (the tapped label)
  await advanceTo(conversationId, chatId, clientId, "team_routing");
}

async function handleTeamRouting(
  conversationId: string,
  chatId: string,
  clientId: string,
  _payload: MessagePayload,
): Promise<void> {
  // TODO: future routing will branch on _payload.text (the tapped label)
  await advanceTo(conversationId, chatId, clientId, "full_name");
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
    await sendButtonPrompt(conversationId, chatId, "inquiry_type");
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

  await sendButtonPrompt(conversationId, chatId, "inquiry_type");
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

  // Combined OCR pass: validate the ID photo AND extract the ID number in one call.
  // For Clix-path payloads the media arrives as base64 (no remote URL); pass a data URL.
  const imageUrl = payload.base64
    ? `data:${payload.mimeType ?? "image/jpeg"};base64,${payload.base64}`
    : payload.fileUrl;
  let ocrResult: Awaited<ReturnType<typeof validateIdPhoto>> | undefined;
  try {
    ocrResult = await validateIdPhoto(imageUrl);
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

  if (!ocrResult) return;

  if (!ocrResult.valid) {
    const rePrompt = INTAKE_PROMPTS.id_photo_invalid.text.replace(
      "{reason}",
      ocrResult.reason,
    );
    try {
      const { idMessage } = await sendMessageWithTyping(chatId, rePrompt);
      await persistOutbound(conversationId, rePrompt, idMessage);
    } catch (sendErr) {
      logger.error({ sendErr }, "intake: failed to send OCR rejection");
    }
    return;
  }

  const extractedIdNumber = ocrResult.idNumber;

  // Load client name for Drive filename (best-effort fallback to phone)
  const { data: clientRow } = await supabaseAdmin
    .from("clients")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .select("full_name, phone" as any)
    .eq("id", clientId)
    .maybeSingle();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nameRow = clientRow as any as { full_name?: string | null; phone?: string | null } | null;
  const fullName = nameRow?.full_name ?? nameRow?.phone ?? clientId;

  const resendText = "לא הצלחנו לשמור את הקובץ, נא לשלוח מחדש את תעודת הזהות.";

  const bytes = payload.base64
    ? Buffer.from(payload.base64, "base64")
    : await fetchRemoteFile(payload.fileUrl);
  if (!bytes) {
    try {
      const { idMessage } = await sendMessageWithTyping(chatId, resendText);
      await persistOutbound(conversationId, resendText, idMessage);
    } catch (sendErr) {
      logger.error({ sendErr }, "intake: failed to send file-fetch error message");
    }
    return;
  }

  const up = await uploadLeadDocument({
    name: `${fullName} - ID`,
    mimeType: payload.mimeType ?? "image/jpeg",
    bytes,
  });
  if (!up) {
    try {
      const { idMessage } = await sendMessageWithTyping(chatId, resendText);
      await persistOutbound(conversationId, resendText, idMessage);
    } catch (sendErr) {
      logger.error({ sendErr }, "intake: failed to send drive-upload error message");
    }
    return;
  }

  await supabaseAdmin.from("documents").insert({
    client_id: clientId,
    type: "id_photo",
    file_url: up.webViewLink,
    file_name: payload.fileName ?? null,
    mime_type: payload.mimeType ?? null,
  });

  const photoUpdate: ClientIntakeUpdate = {
    id_photo_url: up.webViewLink,
    id_validated: true,
    ...(extractedIdNumber ? { id_number: extractedIdNumber } : {}),
  };
  if (extractedIdNumber) {
    logger.info({ clientId, idNumber: extractedIdNumber }, "intake: ID number extracted and will be persisted");
  }
  await updateClient(clientId, photoUpdate);

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
    // Load client name for Drive filename (best-effort fallback to phone)
    const { data: clientRow } = await supabaseAdmin
      .from("clients")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .select("full_name, phone" as any)
      .eq("id", clientId)
      .maybeSingle();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nameRow = clientRow as any as { full_name?: string | null; phone?: string | null } | null;
    const fullName = nameRow?.full_name ?? nameRow?.phone ?? clientId;

    const resendText = "לא הצלחנו לשמור את הקובץ, נא לשלוח מחדש את ייפוי הכוח.";

    const bytes = payload.base64
      ? Buffer.from(payload.base64, "base64")
      : await fetchRemoteFile(payload.fileUrl);
    if (!bytes) {
      try {
        const { idMessage } = await sendMessageWithTyping(chatId, resendText);
        await persistOutbound(conversationId, resendText, idMessage);
      } catch (sendErr) {
        logger.error({ sendErr }, "intake: failed to send poa file-fetch error message");
      }
      return;
    }

    const up = await uploadLeadDocument({
      name: `${fullName} - POA`,
      mimeType: payload.mimeType ?? "application/pdf",
      bytes,
    });
    if (!up) {
      try {
        const { idMessage } = await sendMessageWithTyping(chatId, resendText);
        await persistOutbound(conversationId, resendText, idMessage);
      } catch (sendErr) {
        logger.error({ sendErr }, "intake: failed to send poa drive-upload error message");
      }
      return;
    }

    await supabaseAdmin.from("documents").insert({
      client_id: clientId,
      type: "poa",
      file_url: up.webViewLink,
      file_name: payload.fileName ?? null,
      mime_type: payload.mimeType ?? null,
    });

    await updateClient(clientId, { poa_doc_url: up.webViewLink });
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
    case "client_type":
      await handleClientType(conversationId, chatId, clientId, payload);
      break;
    case "team_routing":
      await handleTeamRouting(conversationId, chatId, clientId, payload);
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
