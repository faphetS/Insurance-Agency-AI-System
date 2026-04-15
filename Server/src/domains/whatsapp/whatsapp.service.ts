import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { AppError } from "../../lib/errors.js";

const base = () =>
  `${env.GREENAPI_BASE_URL}/waInstance${env.GREENAPI_ID_INSTANCE}`;
const token = () => env.GREENAPI_API_TOKEN;

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${base()}/${path}/${token()}`;
  logger.debug({ method, url }, "GreenAPI request");

  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    logger.error({ status: res.status, url, body: text }, "GreenAPI error");
    throw new AppError(
      502,
      `GreenAPI responded with ${res.status}: ${text}`,
      "GREENAPI_ERROR",
    );
  }

  const data = (await res.json()) as T;
  logger.debug({ url, data }, "GreenAPI response");
  return data;
}

export async function sendMessage(
  chatId: string,
  text: string,
): Promise<{ idMessage: string }> {
  return request<{ idMessage: string }>("POST", "sendMessage", {
    chatId,
    message: text,
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

export async function setWebhookSettings(webhookUrl: string): Promise<void> {
  await request<unknown>("POST", "setSettings", {
    webhookUrl,
    webhookUrlToken: env.GREENAPI_WEBHOOK_TOKEN,
    incomingWebhook: "yes",
    stateWebhook: "yes",
    outgoingMessageWebhook: "yes",
  });
}
