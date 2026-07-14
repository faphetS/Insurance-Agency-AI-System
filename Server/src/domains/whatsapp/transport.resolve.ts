import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { mirrorInbound, mirrorOutbound } from "../chatwoot/chatwoot.service.js";
import type { MessagePayload } from "./whatsapp.validator.js";

export type ConversationalChannel = "greenapi" | "meta";

// The DB + meta modules are imported lazily so the greenapi fast path (Meta creds
// blank) has zero import side effects — existing unit tests mock env with plain
// objects that lack META_* keys and must never touch the pg pool.

export type ConversationalOutbound = (
  | { type: "text"; text: string; typingMs?: number }
  | { type: "file"; url: string; fileName: string; caption?: string }
  | {
      type: "buttons";
      body: string;
      buttons: { buttonId: string; buttonText: string }[];
      footer?: string;
      typingMs?: number;
    }
  | { type: "typing"; typingMs: number }
) & {
  // GreenAPI executor supplied by whatsapp.service — keeps this module free of
  // GreenAPI request code and avoids a service<->dispatcher import cycle.
  greenapi: () => Promise<{ idMessage: string }>;
  // Agent-forwarded replies already exist in Chatwoot as the agent's own
  // message — mirroring the delivery back would duplicate it in the thread.
  skipMirror?: boolean;
};

function metaConfigured(): boolean {
  return !!(env.META_ACCESS_TOKEN && env.META_PHONE_NUMBER_ID);
}

function greenapiConfigured(): boolean {
  return !!(env.GREENAPI_ID_INSTANCE && env.GREENAPI_API_TOKEN && env.GREENAPI_BASE_URL);
}

export async function resolveChannel(chatId: string): Promise<ConversationalChannel> {
  if (!metaConfigured()) return "greenapi";
  if (!greenapiConfigured()) return "meta";

  try {
    const { supabaseAdmin } = await import("../../config/supabase.js");
    const { data } = await supabaseAdmin
      .from("conversations")
      .select("channel")
      .eq("whatsapp_chat_id", chatId)
      .maybeSingle();
    const channel = (data as { channel?: string | null } | null)?.channel;
    if (channel === "greenapi" || channel === "meta") return channel;
  } catch (err) {
    logger.warn({ err, chatId }, "resolveChannel: conversation lookup failed — falling back to env provider");
  }

  return (env.WHATSAPP_PROVIDER as ConversationalChannel | undefined) ?? "greenapi";
}

async function metaTyping(
  chatId: string,
  meta: typeof import("./meta/meta.transport.js"),
): Promise<void> {
  try {
    const { supabaseAdmin } = await import("../../config/supabase.js");
    const { data: conv } = await supabaseAdmin
      .from("conversations")
      .select("id")
      .eq("whatsapp_chat_id", chatId)
      .maybeSingle();
    if (!conv?.id) return;

    const { data: msg } = await supabaseAdmin
      .from("messages")
      .select("whatsapp_message_id")
      .eq("conversation_id", conv.id)
      .eq("direction", "inbound")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const wamid = (msg?.whatsapp_message_id as string | null) ?? null;
    if (wamid) await meta.sendTypingAndRead(wamid);
  } catch (err) {
    logger.debug({ err, chatId }, "meta typing lookup failed — continuing");
  }
}

async function sendBrandImageViaMeta(
  waId: string,
  chatId: string,
  url: string,
  caption: string | undefined,
  meta: typeof import("./meta/meta.transport.js"),
): Promise<{ idMessage: string }> {
  const media = await import("./meta/meta.media.js");

  const mediaId = await media.getBrandImageMediaId();
  if (mediaId) {
    try {
      return await meta.sendImage(waId, { mediaId }, caption);
    } catch (err) {
      if (!(err instanceof meta.MetaSendError)) throw err;
      logger.warn({ err, chatId, mediaId }, "meta brand image send by id failed — re-uploading once");
      await media.invalidateBrandMediaId();
      const retryId = await media.getBrandImageMediaId();
      if (retryId) {
        try {
          return await meta.sendImage(waId, { mediaId: retryId }, caption);
        } catch (retryErr) {
          if (!(retryErr instanceof meta.MetaSendError)) throw retryErr;
          logger.warn({ retryErr, chatId }, "meta brand image re-upload retry failed — falling back to link");
        }
      }
    }
  }

  return meta.sendImage(waId, { link: url }, caption);
}

async function sendViaMeta(
  chatId: string,
  outbound: ConversationalOutbound,
): Promise<{ idMessage: string }> {
  const meta = await import("./meta/meta.transport.js");
  const { chatIdToWaId } = await import("./meta/meta.validator.js");
  const waId = chatIdToWaId(chatId);

  switch (outbound.type) {
    case "text": {
      if (outbound.typingMs) {
        await metaTyping(chatId, meta);
        await new Promise((r) => setTimeout(r, outbound.typingMs));
      }
      return meta.sendText(waId, outbound.text);
    }
    case "buttons": {
      if (outbound.typingMs) {
        await metaTyping(chatId, meta);
        await new Promise((r) => setTimeout(r, outbound.typingMs));
      }
      return meta.sendInteractive(waId, outbound.body, outbound.buttons, outbound.footer);
    }
    case "file": {
      const brandUrl = env.WELCOME_IMAGE_URL ?? `${env.BACKEND_URL}/assets/brand.jpeg`;
      if (outbound.url === brandUrl) {
        return sendBrandImageViaMeta(waId, chatId, outbound.url, outbound.caption, meta);
      }
      return meta.sendImage(waId, { link: outbound.url }, outbound.caption);
    }
    case "typing": {
      await metaTyping(chatId, meta);
      return { idMessage: `noop:${Date.now()}` };
    }
  }
}

export async function dispatchConversationalSend(
  chatId: string,
  outbound: ConversationalOutbound,
): Promise<{ idMessage: string }> {
  const channel = await resolveChannel(chatId);

  const result =
    channel === "meta" ? await sendViaMeta(chatId, outbound) : await outbound.greenapi();

  if (!outbound.skipMirror) {
    void mirrorOutboundHook(chatId, outbound, channel).catch((err: unknown) =>
      logger.warn({ err, chatId }, "mirrorOutboundHook failed — continuing"),
    );
  }

  return result;
}

function inboundMirrorText(payload: MessagePayload): string | null {
  if (payload.kind === "text") return payload.text;
  const label = payload.kind === "image" ? "[תמונה]" : "[מסמך]";
  return payload.caption ? `${label}\n${payload.caption}` : label;
}

function outboundMirrorText(outbound: ConversationalOutbound): string | null {
  switch (outbound.type) {
    case "text":
      return outbound.text;
    case "buttons":
      return [outbound.body, ...outbound.buttons.map((b) => `▫️ ${b.buttonText}`)].join("\n");
    case "file":
      return outbound.caption ? `[תמונה]\n${outbound.caption}` : "[תמונה]";
    case "typing":
      return null;
  }
}

export async function mirrorInboundHook(
  chatId: string,
  payload: MessagePayload,
  senderName?: string | null,
): Promise<void> {
  const text = inboundMirrorText(payload);
  if (!text) return;
  await mirrorInbound(chatId, text, senderName ?? undefined);
}

export async function mirrorOutboundHook(
  chatId: string,
  outbound: ConversationalOutbound,
  _channel: ConversationalChannel,
): Promise<void> {
  const text = outboundMirrorText(outbound);
  if (!text) return;
  await mirrorOutbound(chatId, text);
}
