import { supabaseAdmin } from "../../config/supabase.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import {
  sendMessageWithTyping,
  sendInteractiveButtonsWithTyping,
  sendFileByUrl,
} from "../whatsapp/whatsapp.service.js";
import type { MessagePayload } from "../whatsapp/whatsapp.validator.js";
import {
  INTAKE_PROMPTS,
  INQUIRY_TYPES,
  type IntakeSlot,
} from "./intake.prompts.js";
import { validateIdPhoto } from "./ai.service.js";
import { fetchRemoteFile } from "../../lib/storage.js";
import { downloadMetaMedia } from "../whatsapp/meta/meta.media.js";
import { uploadLeadDocument } from "../integrations/google/google.drive.js";
import { mirrorLeadToSheet } from "../integrations/google/leads-mirror.service.js";
import { notifyOwner } from "../operations/owner-notify.js";
import {
  sendStaffLeadEmail,
  buildCallbackAlert,
  sendCallbackRequestEmail,
} from "./intake-notify.service.js";
import { displayName } from "../whatsapp/whatsapp.util.js";
import { assignConversationForInquiry } from "../chatwoot/chatwoot.assign.js";

const COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** Lenient: first email-looking token anywhere in the message text. */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

// ---------------------------------------------------------------------------
// Type helpers — the DB types file predates the migration; cast as needed
// ---------------------------------------------------------------------------

/** Extended client update shape that includes the new intake columns. */
interface ClientIntakeUpdate {
  full_name?: string;
  inquiry_type?: string;
  id_photo_url?: string;
  id_validated?: boolean;
  id_number?: string | null;
  intake_state?: string;
  intake_current_slot?: string;
  intake_completed_at?: string | null;
  pipeline_stage?: string | null;
  client_type?: string | null;
  email?: string;
  consent_prompted_at?: string | null;
  stall_notified_at?: string | null;
}

function updateClient(id: string, values: ClientIntakeUpdate) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return supabaseAdmin.from("clients").update(values as any).eq("id", id);
}

/** Load the phone + WhatsApp display name for a client. */
async function loadContact(clientId: string): Promise<{ phone: string; fullName: string | null }> {
  const { data } = await supabaseAdmin
    .from("clients")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .select("full_name, phone" as any)
    .eq("id", clientId)
    .maybeSingle();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row = data as any as { full_name?: string | null; phone?: string | null } | null;
  return { phone: row?.phone ?? "", fullName: row?.full_name ?? null };
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

/** Send an arbitrary plain-text message and persist it. */
async function sendText(
  conversationId: string,
  chatId: string,
  text: string,
): Promise<void> {
  try {
    const { idMessage } = await sendMessageWithTyping(chatId, text);
    await persistOutbound(conversationId, text, idMessage);
  } catch (err) {
    logger.error({ conversationId, err }, "intake: sendText failed");
  }
}

/** Send the plain-text prompt for a given slot key and persist it. */
async function sendTextPrompt(
  conversationId: string,
  chatId: string,
  slot: keyof typeof INTAKE_PROMPTS,
): Promise<void> {
  const prompt = INTAKE_PROMPTS[slot] as { text: string };
  await sendText(conversationId, chatId, prompt.text);
}

/** Send an interactive-buttons prompt for any button-bearing slot and persist it. */
async function sendButtonPrompt(
  conversationId: string,
  chatId: string,
  slot: "menu" | "meeting_type" | "consent",
): Promise<void> {
  const prompt = INTAKE_PROMPTS[slot];

  try {
    const { idMessage } = await sendInteractiveButtonsWithTyping(
      chatId,
      prompt.text,
      [...prompt.buttons],
    );
    await persistOutbound(conversationId, prompt.text, idMessage);
  } catch (err) {
    logger.warn(
      { conversationId, slot, err },
      "intake: interactive buttons failed — falling back to plain text",
    );
    try {
      const buttonList = prompt.buttons.map((b) => `• ${b.buttonText}`).join("\n");
      const fallback = `${prompt.text}\n\n${buttonList}`;
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

/** Advance intake_current_slot to next and send the corresponding prompt. */
async function advanceTo(
  conversationId: string,
  chatId: string,
  clientId: string,
  next: IntakeSlot,
): Promise<void> {
  const { error } = await updateClient(clientId, { intake_current_slot: next });

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

  const prompt = INTAKE_PROMPTS[next as keyof typeof INTAKE_PROMPTS];
  if (prompt && "buttons" in prompt) {
    await sendButtonPrompt(conversationId, chatId, next as "menu" | "meeting_type" | "consent");
  } else {
    await sendTextPrompt(conversationId, chatId, next as keyof typeof INTAKE_PROMPTS);
  }
}

/** Terminal: mark intake complete, flip pipeline_stage, 24h cooldown pause, mirror. */
async function endFlow(
  conversationId: string,
  clientId: string,
  pipelineStage: "new_lead" | "meeting_scheduling",
): Promise<void> {
  await updateClient(clientId, {
    intake_state: "completed",
    intake_current_slot: "done",
    intake_completed_at: new Date().toISOString(),
    pipeline_stage: pipelineStage,
  });

  await supabaseAdmin
    .from("conversations")
    .update({
      bot_paused: true,
      bot_paused_until: new Date(Date.now() + COOLDOWN_MS).toISOString(),
    })
    .eq("id", conversationId);

  try {
    await mirrorLeadToSheet(clientId);
  } catch (err) {
    logger.warn({ err, clientId }, "endFlow: mirror failed");
  }
}

// ---------------------------------------------------------------------------
// Per-slot handlers
// ---------------------------------------------------------------------------

/** Fire-and-forget: send the brand image ~3-5s after the opening message. */
function sendWelcomeImage(conversationId: string, chatId: string): void {
  const imageUrl = env.WELCOME_IMAGE_URL ?? `${env.BACKEND_URL}/assets/brand.jpeg`;
  if (!imageUrl) return;

  const delayMs = 3000 + Math.floor(Math.random() * 2000);
  setTimeout(() => {
    void (async () => {
      try {
        const { idMessage } = await sendFileByUrl(chatId, imageUrl, "brand.jpeg");
        await persistOutbound(conversationId, "[image] brand", idMessage);
      } catch (err) {
        logger.warn({ conversationId, chatId, err }, "intake: welcome image send failed");
      }
    })();
  }, delayMs);
}

async function handleWelcome(
  conversationId: string,
  chatId: string,
  clientId: string,
): Promise<void> {
  await advanceTo(conversationId, chatId, clientId, "menu");
  sendWelcomeImage(conversationId, chatId);
}

async function handleMenu(
  conversationId: string,
  chatId: string,
  clientId: string,
  payload: MessagePayload,
): Promise<void> {
  if (payload.kind !== "text") {
    await sendTextPrompt(conversationId, chatId, "menu_reprompt");
    return;
  }

  const val = payload.text.trim();
  const matched = INTAKE_PROMPTS.menu.buttons.find(
    (b) => b.buttonId === val || b.buttonText === val,
  );

  if (!matched) {
    // Legacy grace: pre-2026-07-29 WhatsApp list messages stay tappable in a
    // client's chat history forever, so a stale tap on the removed "אחר" row
    // can still arrive here — no button offers it anymore. Same terminal as
    // the old button, minus staff email (that route never existed anyway).
    if (val === "other" || val === "אחר") {
      await updateClient(clientId, { inquiry_type: "other" });
      await sendTextPrompt(conversationId, chatId, "thanks_menu");
      await endFlow(conversationId, clientId, "new_lead");
      return;
    }
    await sendTextPrompt(conversationId, chatId, "menu_reprompt");
    return;
  }

  const id = matched.buttonId;

  // Buttons 1-6 — insurance type → staff email → thank-you → bot off.
  if ((INQUIRY_TYPES as readonly string[]).includes(id)) {
    await updateClient(clientId, { inquiry_type: id });
    const { phone, fullName } = await loadContact(clientId);
    void sendStaffLeadEmail(id, { phone, waName: displayName(fullName, phone) }).catch(
      (err: unknown) => logger.warn({ err, inquiryId: id }, "intake: staff lead email failed"),
    );
    void assignConversationForInquiry(chatId, id);
    await sendTextPrompt(conversationId, chatId, "thanks_menu");
    await endFlow(conversationId, clientId, "new_lead");
    return;
  }

  // Button 7 — request a callback from Didi.
  if (id === "callback_didi") {
    await updateClient(clientId, { inquiry_type: "callback" });
    void assignConversationForInquiry(chatId, "callback");
    const { phone, fullName } = await loadContact(clientId);
    try {
      await notifyOwner(buildCallbackAlert(phone, displayName(fullName, phone)));
    } catch (err) {
      logger.warn({ err, clientId }, "intake: callback owner alert failed");
    }
    try {
      await sendCallbackRequestEmail({ phone, waName: displayName(fullName, phone) });
    } catch (err) {
      logger.warn({ err, clientId }, "intake: callback owner email failed");
    }
    await sendTextPrompt(conversationId, chatId, "thanks_callback");
    await endFlow(conversationId, clientId, "new_lead");
    return;
  }

  // Button 8 — meeting request → existing/new sub-choice.
  if (id === "meeting_didi") {
    await updateClient(clientId, { inquiry_type: "meeting", client_type: null });
    void assignConversationForInquiry(chatId, "meeting");
    await advanceTo(conversationId, chatId, clientId, "meeting_type");
    return;
  }

  await sendTextPrompt(conversationId, chatId, "menu_reprompt");
}

async function handleMeetingType(
  conversationId: string,
  chatId: string,
  clientId: string,
  payload: MessagePayload,
): Promise<void> {
  if (payload.kind !== "text") {
    await sendTextPrompt(conversationId, chatId, "menu_reprompt");
    return;
  }

  const val = payload.text.trim();
  const matched = INTAKE_PROMPTS.meeting_type.buttons.find(
    (b) => b.buttonId === val || b.buttonText === val,
  );

  if (!matched) {
    await sendTextPrompt(conversationId, chatId, "menu_reprompt");
    return;
  }

  // Both branches: record the choice, then collect the email.
  // The branch continuation (booking link vs consent) lives in handleEmail.
  await updateClient(clientId, {
    client_type: matched.buttonId === "existing_client" ? "old" : "new",
  });
  await advanceTo(conversationId, chatId, clientId, "email");
}

async function handleEmail(
  conversationId: string,
  chatId: string,
  clientId: string,
  payload: MessagePayload,
): Promise<void> {
  // Free text only: images/documents and (stale) button taps re-prompt.
  const match =
    payload.kind === "text" && !payload.isButtonReply
      ? payload.text.match(EMAIL_RE)
      : null;

  if (!match) {
    await sendTextPrompt(conversationId, chatId, "email_reprompt");
    return;
  }

  // Lowercase is load-bearing: booking-sync lowercases calendar attendee
  // emails and compares with a case-sensitive SQL IN().
  const email = match[0].toLowerCase();
  await updateClient(clientId, { email });

  const { data } = await supabaseAdmin
    .from("clients")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .select("client_type" as any)
    .eq("id", clientId)
    .maybeSingle();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const clientType = (data as any as { client_type?: string | null } | null)?.client_type;

  if (clientType === "old") {
    await sendText(
      conversationId,
      chatId,
      `${INTAKE_PROMPTS.done_existing.text}\n\n${env.GOOGLE_CALENDAR_BOOKING_URL}`,
    );
    await endFlow(conversationId, clientId, "meeting_scheduling");
    return;
  }

  // 'new' (and defensively: null) → consent. Advance first, then stamp —
  // same ordering as before so the stall window opens at prompt time.
  await advanceTo(conversationId, chatId, clientId, "consent");
  await updateClient(clientId, {
    consent_prompted_at: new Date().toISOString(),
    stall_notified_at: null,
  });
}

async function handleConsent(
  conversationId: string,
  chatId: string,
  clientId: string,
  payload: MessagePayload,
): Promise<void> {
  if (
    payload.kind === "text" &&
    payload.isButtonReply &&
    (payload.text === "consent_approve" || payload.text === "מאשר")
  ) {
    await advanceTo(conversationId, chatId, clientId, "id_photo");
    return;
  }

  await sendTextPrompt(conversationId, chatId, "consent_reprompt");
}

/** Resolve inbound media bytes: GreenAPI delivers a fileUrl, Meta a mediaId. */
async function resolveInboundMedia(payload: MessagePayload): Promise<Buffer | null> {
  if (payload.kind === "text") return null;
  if (payload.fileUrl) {
    return fetchRemoteFile(payload.fileUrl);
  }
  if (payload.mediaId) {
    const media = await downloadMetaMedia(payload.mediaId);
    return media?.bytes ?? null;
  }
  return null;
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

  const resendText = "לא הצלחנו לשמור את הקובץ, נא לשלוח מחדש את תעודת הזהות.";

  // Download once — the same bytes feed the vision pass (as a data URL, since
  // Meta media URLs need a Bearer header OpenRouter can't send) AND the Drive upload.
  const bytes = await resolveInboundMedia(payload);
  if (!bytes) {
    await sendText(conversationId, chatId, resendText);
    return;
  }

  // Combined vision pass: validate the ID photo AND extract id number + name.
  const imageUrl = `data:${payload.mimeType ?? "image/jpeg"};base64,${bytes.toString("base64")}`;
  let ocrResult: Awaited<ReturnType<typeof validateIdPhoto>> | undefined;
  try {
    ocrResult = await validateIdPhoto(imageUrl);
  } catch (err) {
    logger.warn({ err }, "intake: OCR validation failed — requesting resend");
    await sendText(
      conversationId,
      chatId,
      "לא ניתן לקרוא את התמונה, נא לשלוח מחדש תמונה ברורה של תעודת הזהות.",
    );
    return;
  }

  if (!ocrResult) return;

  if (!ocrResult.valid) {
    logger.info({ hasIdCard: ocrResult.hasIdCard, hasAppendix: ocrResult.hasAppendix }, "intake: id_photo rejected");
    await sendText(conversationId, chatId, INTAKE_PROMPTS.id_photo_invalid.text);
    return;
  }

  const extractedIdNumber = ocrResult.idNumber;
  const ocrName = ocrResult.fullName;

  const { phone } = await loadContact(clientId);
  const phoneDigits = phone.replace(/\D/g, "");
  const fileBase = ocrName ?? phoneDigits ?? clientId;

  const up = await uploadLeadDocument({
    name: `${fileBase} - ID`,
    mimeType: payload.mimeType ?? "image/jpeg",
    bytes,
  });
  if (!up) {
    await sendText(conversationId, chatId, resendText);
    return;
  }

  await supabaseAdmin.from("documents").insert({
    client_id: clientId,
    type: "id_photo",
    file_url: up.webViewLink,
    file_name: payload.fileName ?? null,
    mime_type: payload.mimeType ?? null,
  });

  await updateClient(clientId, {
    id_photo_url: up.webViewLink,
    id_validated: true,
    ...(extractedIdNumber ? { id_number: extractedIdNumber } : {}),
    ...(ocrName ? { full_name: ocrName } : {}),
  });

  await sendText(
    conversationId,
    chatId,
    `${INTAKE_PROMPTS.done_new.text}\n\n${env.GOOGLE_CALENDAR_BOOKING_URL}`,
  );
  await endFlow(conversationId, clientId, "meeting_scheduling");
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

  // 0b. Respect per-conversation pause (auto-clear expired cooldowns)
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

  // Operator escape hatch — skipped conversations fall through to the AI layer.
  if (state === "skipped") {
    return { consumed: false };
  }

  // 2. Completed / terminal + unpaused (post-cooldown) → fresh menu restart.
  if (state === "completed" || slot === "done") {
    await updateClient(clientId, {
      intake_state: "collecting",
      intake_current_slot: "welcome",
      consent_prompted_at: null,
      stall_notified_at: null,
      intake_completed_at: null,
      inquiry_type: "general",
      client_type: null,
    });
    await handleWelcome(conversationId, chatId, clientId);
    return { consumed: true };
  }

  logger.info({ conversationId, clientId, slot }, "intake: handling slot");

  // 3. Dispatch
  switch (slot as IntakeSlot) {
    case "welcome":
      await handleWelcome(conversationId, chatId, clientId);
      break;
    case "menu":
      await handleMenu(conversationId, chatId, clientId, payload);
      break;
    case "meeting_type":
      await handleMeetingType(conversationId, chatId, clientId, payload);
      break;
    case "email":
      await handleEmail(conversationId, chatId, clientId, payload);
      break;
    case "consent":
      await handleConsent(conversationId, chatId, clientId, payload);
      break;
    case "id_photo":
      await handleIdPhoto(conversationId, chatId, clientId, payload);
      break;
    default:
      logger.warn(
        { conversationId, slot },
        "intake: unknown slot — falling through",
      );
      return { consumed: false };
  }

  return { consumed: true };
}
