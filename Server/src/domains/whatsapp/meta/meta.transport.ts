import { env } from "../../../config/env.js";
import { logger } from "../../../config/logger.js";
import { AppError } from "../../../lib/errors.js";

// Carries the raw Graph error code (e.g. 131047 = outside 24h window,
// 130429/131056 = pacing) so callers can branch on it.
export class MetaSendError extends Error {
  constructor(
    message: string,
    public code?: number,
  ) {
    super(message);
    this.name = "MetaSendError";
  }
}

interface MetaCreds {
  token: string;
  phoneNumberId: string;
}

function metaCreds(): MetaCreds | null {
  const token = env.META_ACCESS_TOKEN;
  const phoneNumberId = env.META_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) return null;
  return { token, phoneNumberId };
}

export function metaConfigured(): boolean {
  return metaCreds() !== null;
}

function graphBase(): string {
  return `https://graph.facebook.com/${env.META_GRAPH_API_VERSION ?? "v24.0"}`;
}

interface MetaMessagesResponse {
  messages?: { id: string }[];
}

async function graphPost<T>(
  creds: MetaCreds,
  path: string,
  body: unknown,
): Promise<T> {
  const url = `${graphBase()}/${path}`;
  logger.debug({ url }, "Meta Graph request");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${creds.token}`,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text().catch(() => "");

  if (!res.ok) {
    let code: number | undefined;
    let message = text;
    try {
      const parsed = JSON.parse(text) as { error?: { code?: number; message?: string } };
      code = parsed.error?.code;
      message = parsed.error?.message ?? text;
    } catch {
      // non-JSON error body — keep raw text
    }
    if (code === 131047) {
      logger.warn(
        { status: res.status, code, message },
        "Meta send outside 24h window — approved template required (TODO)",
      );
    } else {
      logger.error({ status: res.status, code, message }, "Meta Graph error");
    }
    throw new MetaSendError(`Meta Graph responded with ${res.status}: ${message}`, code);
  }

  const data = JSON.parse(text) as T;
  logger.debug({ url, data }, "Meta Graph response");
  return data;
}

function toIdMessage(res: MetaMessagesResponse): { idMessage: string } {
  return { idMessage: res.messages?.[0]?.id ?? `meta:${Date.now()}` };
}

export async function sendText(
  waId: string,
  text: string,
): Promise<{ idMessage: string }> {
  const creds = metaCreds();
  if (!creds) {
    logger.warn({ waId }, "meta.sendText: Meta creds not set — skipping");
    return { idMessage: `noop:${Date.now()}` };
  }
  const res = await graphPost<MetaMessagesResponse>(creds, `${creds.phoneNumberId}/messages`, {
    messaging_product: "whatsapp",
    to: waId,
    type: "text",
    text: { body: text },
  });
  return toIdMessage(res);
}

export async function sendInteractive(
  waId: string,
  body: string,
  buttons: { buttonId: string; buttonText: string }[],
  footer?: string,
): Promise<{ idMessage: string }> {
  const creds = metaCreds();
  if (!creds) {
    logger.warn({ waId, buttonCount: buttons.length }, "meta.sendInteractive: Meta creds not set — skipping");
    return { idMessage: `noop:${Date.now()}` };
  }
  if (buttons.length === 0) {
    throw new AppError(400, "buttons must have at least 1 item", "INVALID_BUTTONS");
  }

  let interactive: Record<string, unknown>;

  if (buttons.length <= 3) {
    for (const btn of buttons) {
      if (btn.buttonText.length > 20) {
        throw new AppError(
          400,
          `buttonText "${btn.buttonText}" exceeds 20 characters (Meta reply-button cap)`,
          "INVALID_BUTTON_TEXT",
        );
      }
    }
    interactive = {
      type: "button",
      body: { text: body },
      ...(footer ? { footer: { text: footer } } : {}),
      action: {
        buttons: buttons.map((b) => ({
          type: "reply",
          reply: { id: b.buttonId, title: b.buttonText },
        })),
      },
    };
  } else {
    if (buttons.length > 10) {
      throw new AppError(
        400,
        `list message supports at most 10 rows, got ${buttons.length}`,
        "INVALID_BUTTONS",
      );
    }
    for (const btn of buttons) {
      if (btn.buttonText.length > 24) {
        throw new AppError(
          400,
          `row title "${btn.buttonText}" exceeds 24 characters (Meta list-row cap)`,
          "INVALID_BUTTON_TEXT",
        );
      }
    }
    interactive = {
      type: "list",
      body: { text: body },
      ...(footer ? { footer: { text: footer } } : {}),
      action: {
        button: "בחירה מהתפריט",
        sections: [
          {
            title: "אפשרויות",
            rows: buttons.map((b) => ({ id: b.buttonId, title: b.buttonText })),
          },
        ],
      },
    };
  }

  const res = await graphPost<MetaMessagesResponse>(creds, `${creds.phoneNumberId}/messages`, {
    messaging_product: "whatsapp",
    to: waId,
    type: "interactive",
    interactive,
  });
  return toIdMessage(res);
}

export interface MetaTemplateSpec {
  name: string;
  language: string; // e.g. "he"
  bodyParams?: string[]; // ordered {{1}}..{{n}}
  headerMedia?: { type: "image" | "document" | "video"; link: string };
}

export async function sendTemplate(
  waId: string,
  tpl: MetaTemplateSpec,
): Promise<{ idMessage: string }> {
  const creds = metaCreds();
  if (!creds) {
    logger.warn({ waId, name: tpl.name }, "meta.sendTemplate: Meta creds not set — skipping");
    return { idMessage: `noop:${Date.now()}` };
  }

  const components: Record<string, unknown>[] = [];
  if (tpl.headerMedia) {
    components.push({
      type: "header",
      parameters: [
        { type: tpl.headerMedia.type, [tpl.headerMedia.type]: { link: tpl.headerMedia.link } },
      ],
    });
  }
  if (tpl.bodyParams && tpl.bodyParams.length > 0) {
    components.push({
      type: "body",
      parameters: tpl.bodyParams.map((text) => ({ type: "text", text })),
    });
  }

  const res = await graphPost<MetaMessagesResponse>(creds, `${creds.phoneNumberId}/messages`, {
    messaging_product: "whatsapp",
    to: waId,
    type: "template",
    template: {
      name: tpl.name,
      language: { code: tpl.language },
      ...(components.length > 0 ? { components } : {}),
    },
  });
  return toIdMessage(res);
}

export async function sendImage(
  waId: string,
  media: { mediaId?: string; link?: string },
  caption?: string,
): Promise<{ idMessage: string }> {
  const creds = metaCreds();
  if (!creds) {
    logger.warn({ waId }, "meta.sendImage: Meta creds not set — skipping");
    return { idMessage: `noop:${Date.now()}` };
  }
  const image = {
    ...(media.mediaId ? { id: media.mediaId } : { link: media.link }),
    ...(caption ? { caption } : {}),
  };
  const res = await graphPost<MetaMessagesResponse>(creds, `${creds.phoneNumberId}/messages`, {
    messaging_product: "whatsapp",
    to: waId,
    type: "image",
    image,
  });
  return toIdMessage(res);
}

// Marks the inbound message read and shows a typing indicator (auto-dismiss ~25s).
// Best-effort — never throws.
export async function sendTypingAndRead(wamid: string): Promise<void> {
  const creds = metaCreds();
  if (!creds) return;
  try {
    await graphPost<unknown>(creds, `${creds.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      status: "read",
      message_id: wamid,
      typing_indicator: { type: "text" },
    });
  } catch (err) {
    logger.debug({ err, wamid }, "meta.sendTypingAndRead failed — continuing");
  }
}

export async function uploadMedia(
  bytes: Buffer,
  mimeType: string,
): Promise<string> {
  const creds = metaCreds();
  if (!creds) {
    throw new MetaSendError("Meta creds not set — cannot upload media");
  }
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", new Blob([new Uint8Array(bytes)], { type: mimeType }), "upload");

  const url = `${graphBase()}/${creds.phoneNumberId}/media`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${creds.token}` },
    body: form,
  });

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    let code: number | undefined;
    let message = text;
    try {
      const parsed = JSON.parse(text) as { error?: { code?: number; message?: string } };
      code = parsed.error?.code;
      message = parsed.error?.message ?? text;
    } catch {
      // non-JSON error body — keep raw text
    }
    logger.error({ status: res.status, code, message }, "Meta media upload error");
    throw new MetaSendError(`Meta media upload responded with ${res.status}: ${message}`, code);
  }

  const data = JSON.parse(text) as { id?: string };
  if (!data.id) {
    throw new MetaSendError("Meta media upload returned no id");
  }
  return data.id;
}
