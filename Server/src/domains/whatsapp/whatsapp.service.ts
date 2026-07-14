import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { AppError } from "../../lib/errors.js";
import { dispatchConversationalSend } from "./transport.resolve.js";

export interface GreenApiCreds {
  idInstance: string;
  token: string;
  baseUrl: string;
}

export function scanCreds(): GreenApiCreds | null {
  const id = env.GREENAPI_SCAN_ID_INSTANCE;
  const tok = env.GREENAPI_SCAN_API_TOKEN;
  const url = env.GREENAPI_SCAN_BASE_URL;
  if (!id || !tok || !url) return null;
  return { idInstance: id, token: tok, baseUrl: url };
}

async function requestWith<T>(
  creds: GreenApiCreds,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${creds.baseUrl}/waInstance${creds.idInstance}/${path}/${creds.token}`;
  const redactedUrl = url.replace(creds.token, "***");
  logger.debug({ method, url: redactedUrl }, "GreenAPI request");

  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    logger.error({ status: res.status, url: redactedUrl, body: text }, "GreenAPI error");
    throw new AppError(
      502,
      `GreenAPI responded with ${res.status}: ${text}`,
      "GREENAPI_ERROR",
    );
  }

  const data = (await res.json()) as T;
  logger.debug({ url: redactedUrl, data }, "GreenAPI response");
  return data;
}

export async function sendMessage(
  chatId: string,
  text: string,
  opts?: { skipMirror?: boolean },
): Promise<{ idMessage: string }> {
  return dispatchConversationalSend(chatId, {
    type: "text",
    text,
    skipMirror: opts?.skipMirror,
  });
}

export async function sendFileByUrl(
  chatId: string,
  urlFile: string,
  fileName: string,
  caption?: string,
): Promise<{ idMessage: string }> {
  return dispatchConversationalSend(chatId, {
    type: "file",
    url: urlFile,
    fileName,
    caption,
  });
}

export async function sendInteractiveButtons(
  chatId: string,
  body: string,
  buttons: { buttonId: string; buttonText: string }[],
  footer?: string,
): Promise<{ idMessage: string }> {
  return dispatchConversationalSend(chatId, {
    type: "buttons",
    body,
    buttons,
    footer,
  });
}

export async function sendTyping(chatId: string, typingTimeMs = 2000): Promise<void> {
  await dispatchConversationalSend(chatId, {
    type: "typing",
    typingMs: typingTimeMs,
  });
}

export async function sendMessageWithTyping(
  chatId: string,
  message: string,
  typingMs = 2000,
): Promise<{ idMessage: string }> {
  return dispatchConversationalSend(chatId, {
    type: "text",
    text: message,
    typingMs,
  });
}

export async function sendInteractiveButtonsWithTyping(
  chatId: string,
  body: string,
  buttons: { buttonId: string; buttonText: string }[],
  footer?: string,
  typingMs = 2000,
): Promise<{ idMessage: string }> {
  return dispatchConversationalSend(chatId, {
    type: "buttons",
    body,
    buttons,
    footer,
    typingMs,
  });
}

export interface GreenApiHistoryMessage {
  type: "incoming" | "outgoing";
  idMessage: string;
  timestamp: number; // unix seconds
  typeMessage: string;
  chatId: string;
  textMessage?: string;
  senderId?: string;
  senderName?: string;
  senderContactName?: string;
  statusMessage?: string;
  sendByApi?: boolean;
}

// Journal query string must follow the token: .../{endpoint}/{token}?minutes=N
async function journalGetWith(creds: GreenApiCreds, endpoint: string, minutes: number): Promise<GreenApiHistoryMessage[]> {
  const url = `${creds.baseUrl}/waInstance${creds.idInstance}/${endpoint}/${creds.token}?minutes=${minutes}`;
  const redactedUrl = url.replace(creds.token, "***");
  const res = await fetch(url, { method: "GET" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    logger.error({ status: res.status, url: redactedUrl, endpoint, body: text }, "GreenAPI journal error");
    throw new AppError(502, `GreenAPI ${endpoint} responded with ${res.status}: ${text}`, "GREENAPI_ERROR");
  }
  return (await res.json()) as GreenApiHistoryMessage[];
}

export async function getChatHistoryWith(
  creds: GreenApiCreds,
  chatId: string,
  count = 20,
): Promise<GreenApiHistoryMessage[]> {
  return requestWith<GreenApiHistoryMessage[]>(creds, "POST", "getChatHistory", { chatId, count });
}

export async function lastIncomingMessagesWith(creds: GreenApiCreds, minutes = 1440): Promise<GreenApiHistoryMessage[]> {
  return journalGetWith(creds, "lastIncomingMessages", minutes);
}

export async function lastOutgoingMessagesWith(creds: GreenApiCreds, minutes = 1440): Promise<GreenApiHistoryMessage[]> {
  return journalGetWith(creds, "lastOutgoingMessages", minutes);
}

// Instance #2 is the operational line — shared with the channel scanner.
// GREENAPI_SCAN_* creds serve both purposes (pull-based scanning + staff notifications).
export function opsCreds(): GreenApiCreds | null {
  return scanCreds();
}

// Dedicated operational GreenAPI line (GREENAPI_OP_*) — used by the call-reminder feature.
// Returns null when any of the three env vars is missing (feature stays dormant).
export function opCreds(): GreenApiCreds | null {
  const id = env.GREENAPI_OP_ID_INSTANCE;
  const tok = env.GREENAPI_OP_API_TOKEN;
  const url = env.GREENAPI_OP_BASE_URL;
  if (!id || !tok || !url) return null;
  return { idInstance: id, token: tok, baseUrl: url };
}

export async function sendMessageWith(
  creds: GreenApiCreds,
  chatId: string,
  text: string,
): Promise<{ idMessage: string }> {
  return requestWith<{ idMessage: string }>(creds, "POST", "sendMessage", {
    chatId,
    message: text,
  });
}

// Dedicated operational-notify GreenAPI line (GREENAPI_NOTIFY_*) — carries every owner
// notification the operational bot sends (digest, call-reminder, commitments, unanswered-WA).
// Returns null when any of the three env vars is missing (feature stays dormant).
export function notifyCreds(): GreenApiCreds | null {
  const id = env.GREENAPI_NOTIFY_ID_INSTANCE;
  const tok = env.GREENAPI_NOTIFY_API_TOKEN;
  const url = env.GREENAPI_NOTIFY_BASE_URL;
  if (!id || !tok || !url) return null;
  return { idInstance: id, token: tok, baseUrl: url };
}

export async function sendTypingWith(
  creds: GreenApiCreds,
  chatId: string,
  typingTimeMs = 2000,
): Promise<void> {
  const url = `${creds.baseUrl}/waInstance${creds.idInstance}/sendTyping/${creds.token}`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, typingTime: typingTimeMs }),
    });
  } catch (err) {
    logger.warn({ err, chatId }, "sendTypingWith failed — continuing");
  }
}

export async function sendMessageWithTypingWith(
  creds: GreenApiCreds,
  chatId: string,
  message: string,
  typingMs = 2000,
): Promise<{ idMessage: string }> {
  await sendTypingWith(creds, chatId, typingMs);
  await new Promise((r) => setTimeout(r, typingMs));
  return sendMessageWith(creds, chatId, message);
}

export async function sendInteractiveButtonsWith(
  creds: GreenApiCreds,
  chatId: string,
  body: string,
  buttons: { buttonId: string; buttonText: string }[],
  footer?: string,
): Promise<{ idMessage: string }> {
  if (buttons.length === 0) {
    throw new AppError(400, "buttons must have at least 1 item", "INVALID_BUTTONS");
  }
  for (const btn of buttons) {
    if (btn.buttonText.length > 25) {
      throw new AppError(
        400,
        `buttonText "${btn.buttonText}" exceeds 25 characters`,
        "INVALID_BUTTON_TEXT",
      );
    }
  }

  return requestWith<{ idMessage: string }>(creds, "POST", "sendInteractiveButtonsReply", {
    chatId,
    body,
    ...(footer ? { footer } : {}),
    buttons: buttons.map((b) => ({
      buttonId: b.buttonId,
      buttonText: b.buttonText,
    })),
  });
}

// Staff-facing text — sent via the Meta conversational transport. Staff numbers
// are blocklisted from the lead/intake flow (isStaffChat), so reusing this line is safe.
export async function sendStaffMessage(
  chatId: string,
  text: string,
): Promise<{ idMessage: string }> {
  return sendMessageWithTyping(chatId, text);
}

// Staff-facing buttons — sent via the Meta conversational transport; staff numbers
// are blocklisted from intake, so reusing this line is safe.
export async function sendStaffButtons(
  chatId: string,
  body: string,
  buttons: { buttonId: string; buttonText: string }[],
  footer?: string,
): Promise<{ idMessage: string }> {
  return sendInteractiveButtonsWithTyping(chatId, body, buttons, footer);
}

