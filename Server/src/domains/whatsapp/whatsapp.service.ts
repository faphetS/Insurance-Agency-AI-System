import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { AppError } from "../../lib/errors.js";

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

function envCreds(): GreenApiCreds | null {
  const id = env.GREENAPI_ID_INSTANCE;
  const tok = env.GREENAPI_API_TOKEN;
  const url = env.GREENAPI_BASE_URL;
  if (!id || !tok || !url) return null;
  return { idInstance: id, token: tok, baseUrl: url };
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const creds = envCreds();
  if (!creds) {
    throw new AppError(503, "Conversational GreenAPI creds not configured", "GREENAPI_NOT_CONFIGURED");
  }
  return requestWith<T>(creds, method, path, body);
}

export async function sendMessage(
  chatId: string,
  text: string,
): Promise<{ idMessage: string }> {
  const creds = envCreds();
  if (!creds) {
    logger.warn({ chatId }, "sendMessage: conversational GreenAPI creds not set — skipping");
    return { idMessage: `noop:${Date.now()}` };
  }
  return requestWith<{ idMessage: string }>(creds, "POST", "sendMessage", {
    chatId,
    message: text,
  });
}

export async function sendFileByUrl(
  chatId: string,
  urlFile: string,
  fileName: string,
  caption?: string,
): Promise<{ idMessage: string }> {
  const creds = envCreds();
  if (!creds) {
    logger.warn({ chatId }, "sendFileByUrl: conversational GreenAPI creds not set — skipping");
    return { idMessage: `noop:${Date.now()}` };
  }
  return requestWith<{ idMessage: string }>(creds, "POST", "sendFileByUrl", {
    chatId,
    urlFile,
    fileName,
    ...(caption ? { caption } : {}),
  });
}

export async function getState(): Promise<{ stateInstance: string }> {
  return request<{ stateInstance: string }>("GET", "getStateInstance");
}

export async function getQrCode(): Promise<{
  type: "qrCode" | "alreadyLogged" | "error";
  message: string;
}> {
  return request<{ type: "qrCode" | "alreadyLogged" | "error"; message: string }>(
    "GET",
    "qr",
  );
}

export async function sendButtons(
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

  return request<{ idMessage: string }>("POST", "sendInteractiveButtonsReply", {
    chatId,
    body,
    ...(footer ? { footer } : {}),
    buttons: buttons.map((b) => ({
      buttonId: b.buttonId,
      buttonText: b.buttonText,
    })),
  });
}

export async function sendInteractiveButtons(
  chatId: string,
  body: string,
  buttons: { buttonId: string; buttonText: string }[],
  footer?: string,
): Promise<{ idMessage: string }> {
  const creds = envCreds();
  if (!creds) {
    logger.warn({ chatId, buttonCount: buttons.length }, "sendInteractiveButtons: conversational GreenAPI creds not set — skipping");
    return { idMessage: `noop:${Date.now()}` };
  }
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

export async function setWebhookSettings(webhookUrl: string): Promise<void> {
  await request<unknown>("POST", "setSettings", {
    webhookUrl,
    webhookUrlToken: env.GREENAPI_WEBHOOK_TOKEN,
    incomingWebhook: "yes",
    stateWebhook: "yes",
    outgoingMessageWebhook: "yes",
    outgoingAPIMessageWebhook: "no",
    markIncomingMessagesReadedOnReply: "yes",
  });
}

export async function sendTyping(chatId: string, typingTimeMs = 2000): Promise<void> {
  const creds = envCreds();
  if (!creds) {
    logger.warn({ chatId }, "sendTyping: conversational GreenAPI creds not set — skipping");
    return;
  }
  const url = `${creds.baseUrl}/waInstance${creds.idInstance}/sendTyping/${creds.token}`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, typingTime: typingTimeMs }),
    });
  } catch (err) {
    logger.warn({ err, chatId }, "sendTyping failed — continuing");
  }
}

export async function sendMessageWithTyping(
  chatId: string,
  message: string,
  typingMs = 2000,
): Promise<{ idMessage: string }> {
  const creds = envCreds();
  if (!creds) {
    logger.warn({ chatId }, "sendMessageWithTyping: conversational GreenAPI creds not set — skipping");
    return { idMessage: `noop:${Date.now()}` };
  }
  await sendTyping(chatId, typingMs);
  await new Promise((r) => setTimeout(r, typingMs));
  return requestWith<{ idMessage: string }>(creds, "POST", "sendMessage", {
    chatId,
    message,
  });
}

export async function sendInteractiveButtonsWithTyping(
  chatId: string,
  body: string,
  buttons: { buttonId: string; buttonText: string }[],
  footer?: string,
  typingMs = 2000,
): Promise<{ idMessage: string }> {
  const creds = envCreds();
  if (!creds) {
    logger.warn({ chatId, buttonCount: buttons.length }, "sendInteractiveButtonsWithTyping: conversational GreenAPI creds not set — skipping");
    return { idMessage: `noop:${Date.now()}` };
  }
  await sendTyping(chatId, typingMs);
  await new Promise((r) => setTimeout(r, typingMs));
  return sendInteractiveButtons(chatId, body, buttons, footer);
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

async function journalGet(endpoint: string, minutes: number): Promise<GreenApiHistoryMessage[]> {
  const creds = envCreds();
  if (!creds) {
    throw new AppError(503, "Conversational GreenAPI creds not configured", "GREENAPI_NOT_CONFIGURED");
  }
  return journalGetWith(creds, endpoint, minutes);
}

export async function lastIncomingMessages(minutes = 1440): Promise<GreenApiHistoryMessage[]> {
  return journalGet("lastIncomingMessages", minutes);
}

export async function lastOutgoingMessages(minutes = 1440): Promise<GreenApiHistoryMessage[]> {
  return journalGet("lastOutgoingMessages", minutes);
}

export async function getChatHistory(
  chatId: string,
  count = 20,
): Promise<GreenApiHistoryMessage[]> {
  return request<GreenApiHistoryMessage[]>("POST", "getChatHistory", { chatId, count });
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

export async function ensureHistorySettings(): Promise<void> {
  await request<unknown>("POST", "setSettings", {
    incomingWebhook: "yes",
    outgoingMessageWebhook: "yes",
    outgoingWebhook: "yes",
  });
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

// Staff-facing text — sent via the conversational GreenAPI instance. Staff numbers
// are blocklisted from the lead/intake flow (isStaffChat), so reusing this line is safe.
export async function sendStaffMessage(
  chatId: string,
  text: string,
): Promise<{ idMessage: string }> {
  return sendMessageWithTyping(chatId, text);
}

// Staff-facing buttons — sent via the conversational GreenAPI instance; staff numbers
// are blocklisted from intake, so reusing this line is safe.
export async function sendStaffButtons(
  chatId: string,
  body: string,
  buttons: { buttonId: string; buttonText: string }[],
  footer?: string,
): Promise<{ idMessage: string }> {
  return sendInteractiveButtonsWithTyping(chatId, body, buttons, footer);
}

