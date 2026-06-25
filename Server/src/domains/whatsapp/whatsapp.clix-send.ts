import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { AppError } from "../../lib/errors.js";

export interface ClixSendCreds {
  url: string;
  token: string;
}

export function clixSendCreds(): ClixSendCreds | null {
  const url = env.CLIX_SEND_URL;
  const token = env.CLIX_SEND_TOKEN;
  if (!url || !token) return null;
  return { url, token };
}

/**
 * Normalise a recipient address for the Clix send API:
 *   - Strip trailing "@c.us" → bare digits (person)
 *   - Leave "@g.us" addresses untouched (group)
 */
function normaliseRecipient(to: string): string {
  if (to.endsWith("@c.us")) return to.slice(0, -5);
  return to;
}

async function post(creds: ClixSendCreds, body: Record<string, unknown>): Promise<void> {
  const redactedUrl = creds.url.replace(/\/+$/, "");
  logger.debug({ url: redactedUrl, to: body.to }, "ClixSend request");

  const res = await fetch(creds.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${creds.token}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    logger.error({ status: res.status, url: redactedUrl, responseBody: text }, "ClixSend error");
    throw new AppError(502, `Clix send responded with ${res.status}: ${text}`, "CLIX_SEND_ERROR");
  }

  const data = (await res.json()) as { ok?: boolean };
  logger.debug({ url: redactedUrl, to: body.to, ok: data.ok }, "ClixSend response");
}

export async function clixSendText(to: string, text: string): Promise<void> {
  const creds = clixSendCreds();
  if (!creds) {
    throw new AppError(502, "Clix send credentials not configured", "CLIX_SEND_NOT_CONFIGURED");
  }
  await post(creds, { to: normaliseRecipient(to), text });
}

export async function clixSendButtons(
  to: string,
  body: string,
  buttons: { buttonId: string; buttonText: string }[],
  header?: string,
  footer?: string,
): Promise<void> {
  const creds = clixSendCreds();
  if (!creds) {
    throw new AppError(502, "Clix send credentials not configured", "CLIX_SEND_NOT_CONFIGURED");
  }

  const mappedButtons = buttons.map((b) => ({
    id: b.buttonId,
    text: b.buttonText.slice(0, 25),
  }));

  const payload: Record<string, unknown> = {
    to: normaliseRecipient(to),
    body,
    buttons: mappedButtons,
  };
  if (header !== undefined) payload.header = header;
  if (footer !== undefined) payload.footer = footer;

  await post(creds, payload);
}
