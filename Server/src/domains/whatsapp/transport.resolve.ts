import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { mirrorInbound, mirrorOutbound } from "../chatwoot/chatwoot.service.js";
import type { MessagePayload } from "./whatsapp.validator.js";

// "greenapi" is kept only so historically-stamped conversations.channel values
// and InboundCustomerMessage.channel (inbound.pipeline.ts) still type-check —
// the 945 GreenAPI transport itself is gone; every send now goes via Meta.
export type ConversationalChannel = "greenapi" | "meta";

// The DB + meta modules are imported lazily so unit tests that mock env with
// plain objects lacking META_* keys never touch the pg pool.

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
  // Agent-forwarded replies already exist in Chatwoot as the agent's own
  // message — mirroring the delivery back would duplicate it in the thread.
  skipMirror?: boolean;
};

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
  const result = await sendViaMeta(chatId, outbound);

  if (!outbound.skipMirror) {
    void mirrorOutboundHook(chatId, outbound, "meta").catch((err: unknown) =>
      logger.warn({ err, chatId }, "mirrorOutboundHook failed — continuing"),
    );
  }

  return result;
}

function inboundMirrorText(payload: MessagePayload): string | null {
  if (payload.kind === "text") return payload.buttonTitle ?? payload.text;
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
