import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";

interface ChatwootConfig {
  apiBase: string;
  inboxId: number;
  token: string;
}

interface ChatwootIds {
  contactId: number;
  conversationId: number;
}

const MAX_CONTENT_LENGTH = 4000;

// Warm cache in front of the conversations-row read; the DB columns stay the
// source of truth (this map just saves a roundtrip per message).
const idCache = new Map<string, ChatwootIds>();

export function resetChatwootCache(): void {
  idCache.clear();
}

function config(): ChatwootConfig | null {
  const base = env.CHATWOOT_BASE_URL;
  const account = env.CHATWOOT_ACCOUNT_ID;
  const inbox = env.CHATWOOT_INBOX_ID;
  const token = env.CHATWOOT_BOT_TOKEN;
  if (!base || !account || !inbox || !token) return null;
  return {
    apiBase: `${base}/api/v1/accounts/${account}`,
    inboxId: Number(inbox),
    token,
  };
}

async function cwFetch(
  cfg: ChatwootConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  const res = await fetch(`${cfg.apiBase}${path}`, {
    method,
    headers: {
      api_access_token: cfg.token,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data: unknown = await res.json().catch(() => null);
  return { status: res.status, data };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

// Contact create may return the contact bare or nested under payload.contact
// (version-dependent); contact search returns { payload: [contact, ...] }.
function contactFromResponse(data: unknown): Record<string, unknown> | null {
  const d = asRecord(data);
  if (!d) return null;
  const payload = d["payload"];
  if (Array.isArray(payload)) return asRecord(payload[0]);
  const p = asRecord(payload);
  if (p) {
    const nested = asRecord(p["contact"]);
    if (nested) return nested;
    if (p["id"] !== undefined) return p;
  }
  const direct = asRecord(d["contact"]);
  if (direct) return direct;
  if (d["id"] !== undefined) return d;
  return null;
}

function sourceIdOf(contact: Record<string, unknown>): string | null {
  const inboxes = contact["contact_inboxes"];
  if (!Array.isArray(inboxes)) return null;
  const sourceId = asRecord(inboxes[0])?.["source_id"];
  return typeof sourceId === "string" && sourceId ? sourceId : null;
}

async function resolveContact(
  cfg: ChatwootConfig,
  chatId: string,
  senderName: string | undefined,
): Promise<{ contactId: number; sourceId: string } | null> {
  const digits = chatId.replace(/@c\.us$/, "");
  let res = await cwFetch(cfg, "POST", "/contacts", {
    inbox_id: cfg.inboxId,
    name: senderName ?? digits,
    phone_number: `+${digits}`,
    identifier: chatId,
  });

  if (res.status === 422) {
    res = await cwFetch(cfg, "GET", `/contacts/search?q=${encodeURIComponent(digits)}`);
  }

  if (res.status >= 400) {
    logger.warn({ chatId, status: res.status }, "chatwoot contact resolve failed");
    return null;
  }

  const contact = contactFromResponse(res.data);
  const contactId = Number(contact?.["id"]);
  const sourceId = contact ? sourceIdOf(contact) : null;
  if (!contact || !Number.isFinite(contactId) || contactId <= 0 || !sourceId) {
    logger.warn({ chatId }, "chatwoot contact response missing id/source_id — skipping mirror");
    return null;
  }
  return { contactId, sourceId };
}

async function ensureIds(
  cfg: ChatwootConfig,
  chatId: string,
  senderName: string | undefined,
): Promise<ChatwootIds | null> {
  const cached = idCache.get(chatId);
  if (cached) return cached;

  const { supabaseAdmin } = await import("../../config/supabase.js");
  const { data: row } = await supabaseAdmin
    .from("conversations")
    .select("chatwoot_contact_id, chatwoot_conversation_id")
    .eq("whatsapp_chat_id", chatId)
    .maybeSingle();

  const dbRow = row as
    | { chatwoot_contact_id: number | null; chatwoot_conversation_id: number | null }
    | null;
  const dbContactId = Number(dbRow?.chatwoot_contact_id ?? 0);
  const dbConversationId = Number(dbRow?.chatwoot_conversation_id ?? 0);
  if (dbContactId > 0 && dbConversationId > 0) {
    const ids = { contactId: dbContactId, conversationId: dbConversationId };
    idCache.set(chatId, ids);
    return ids;
  }

  const contact = await resolveContact(cfg, chatId, senderName);
  if (!contact) return null;

  const convRes = await cwFetch(cfg, "POST", "/conversations", {
    source_id: contact.sourceId,
    inbox_id: cfg.inboxId,
    contact_id: contact.contactId,
  });
  const conversationId = Number(asRecord(convRes.data)?.["id"]);
  if (convRes.status >= 400 || !Number.isFinite(conversationId) || conversationId <= 0) {
    logger.warn({ chatId, status: convRes.status }, "chatwoot conversation create failed");
    return null;
  }

  const ids = { contactId: contact.contactId, conversationId };
  idCache.set(chatId, ids);
  const { error } = await supabaseAdmin
    .from("conversations")
    .update({ chatwoot_contact_id: ids.contactId, chatwoot_conversation_id: ids.conversationId })
    .eq("whatsapp_chat_id", chatId);
  if (error) {
    logger.warn({ chatId, error }, "chatwoot id persist failed — continuing with cache only");
  }
  return ids;
}

async function clearIds(chatId: string): Promise<void> {
  idCache.delete(chatId);
  const { supabaseAdmin } = await import("../../config/supabase.js");
  const { error } = await supabaseAdmin
    .from("conversations")
    .update({ chatwoot_contact_id: null, chatwoot_conversation_id: null })
    .eq("whatsapp_chat_id", chatId);
  if (error) {
    logger.warn({ chatId, error }, "chatwoot id clear failed");
  }
}

async function postMessage(
  cfg: ChatwootConfig,
  ids: ChatwootIds,
  content: string,
  direction: "incoming" | "outgoing",
): Promise<number> {
  const res = await cwFetch(cfg, "POST", `/conversations/${ids.conversationId}/messages`, {
    content,
    message_type: direction,
    private: false,
  });
  return res.status;
}

async function mirrorMessage(
  chatId: string,
  text: string,
  direction: "incoming" | "outgoing",
  senderName?: string,
): Promise<void> {
  const cfg = config();
  if (!cfg) return;

  const trimmed = text.trim();
  if (!trimmed) return;
  const content =
    trimmed.length > MAX_CONTENT_LENGTH ? trimmed.slice(0, MAX_CONTENT_LENGTH) : trimmed;

  const ids = await ensureIds(cfg, chatId, senderName);
  if (!ids) return;

  const status = await postMessage(cfg, ids, content, direction);
  if (status === 404) {
    // Conversation deleted in Chatwoot — drop the cached ids and rebuild once.
    await clearIds(chatId);
    const freshIds = await ensureIds(cfg, chatId, senderName);
    if (!freshIds) return;
    const retryStatus = await postMessage(cfg, freshIds, content, direction);
    if (retryStatus >= 400) {
      logger.warn({ chatId, status: retryStatus }, "chatwoot message retry failed");
    }
    return;
  }
  if (status >= 400) {
    logger.warn({ chatId, status }, "chatwoot message post failed");
  }
}

export async function mirrorInbound(
  chatId: string,
  text: string,
  senderName?: string,
): Promise<void> {
  try {
    await mirrorMessage(chatId, text, "incoming", senderName);
  } catch (err) {
    logger.warn({ err, chatId }, "chatwoot mirrorInbound failed — continuing");
  }
}

export async function mirrorOutbound(chatId: string, text: string): Promise<void> {
  try {
    await mirrorMessage(chatId, text, "outgoing");
  } catch (err) {
    logger.warn({ err, chatId }, "chatwoot mirrorOutbound failed — continuing");
  }
}
