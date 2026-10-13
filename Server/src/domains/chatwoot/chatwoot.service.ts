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

export interface ChatwootAttachment {
  bytes: Buffer;
  fileName: string;
  contentType: string;
  isVoice?: boolean;
}

const MAX_CONTENT_LENGTH = 4000;
const REQUEST_TIMEOUT_MS = 20_000;
const UPLOAD_TIMEOUT_MS = 120_000;

// Warm cache in front of the conversations-row read; the DB columns stay the
// source of truth (this map just saves a roundtrip per message).
const idCache = new Map<string, ChatwootIds>();

// Tail of each chat's mirror queue: posts for one chat run one at a time, in call
// order. Two racing first posts for a new chat each created a Chatwoot conversation
// (seen 2026-10-01), and a slow upload must not let the next message overtake it.
const chatQueues = new Map<string, Promise<void>>();

// Also forgets the mirror queues: a queued task that never settles cannot hold up later ones.
export function resetChatwootCache(): void {
  idCache.clear();
  chatQueues.clear();
}

// The returned promise never rejects and settles when THIS task is done.
function enqueue(chatId: string, failureMessage: string, task: () => Promise<void>): Promise<void> {
  const run = (chatQueues.get(chatId) ?? Promise.resolve()).then(task).catch((err: unknown) => {
    logger.warn({ err, chatId }, failureMessage);
  });
  chatQueues.set(chatId, run);
  void run.then(() => {
    if (chatQueues.get(chatId) === run) chatQueues.delete(chatId);
  });
  return run;
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

// A FormData body goes as multipart: fetch sets the Content-Type itself (it carries the boundary).
async function cwFetch(
  cfg: ChatwootConfig,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<{ status: number; data: unknown }> {
  const isForm = body instanceof FormData;
  const res = await fetch(`${cfg.apiBase}${path}`, {
    method,
    headers: {
      api_access_token: cfg.token,
      ...(body !== undefined && !isForm ? { "Content-Type": "application/json" } : {}),
    },
    body: isForm ? body : body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
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

// Read-only counterpart to ensureIds — never creates a contact/conversation,
// just resolves the conversation id for callers (e.g. auto-assignment) that
// must no-op when the mirror hasn't run for this chat yet. Pass skipCache=true
// to bypass the warm cache and re-read the DB row directly (e.g. after a 404
// indicates the cached conversation id is dead).
export async function resolveConversationId(
  chatId: string,
  skipCache = false,
): Promise<number | null> {
  if (!skipCache) {
    const cached = idCache.get(chatId);
    if (cached) return cached.conversationId;
  }

  const { supabaseAdmin } = await import("../../config/supabase.js");
  const { data: row } = await supabaseAdmin
    .from("conversations")
    .select("chatwoot_conversation_id")
    .eq("whatsapp_chat_id", chatId)
    .maybeSingle();

  const dbRow = row as { chatwoot_conversation_id: number | null } | null;
  const conversationId = Number(dbRow?.chatwoot_conversation_id ?? 0);
  return conversationId > 0 ? conversationId : null;
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

// null = no answer at all (timeout or network error).
async function postAttachment(
  cfg: ChatwootConfig,
  chatId: string,
  ids: ChatwootIds,
  attachment: ChatwootAttachment,
  file: Blob,
  content: string,
): Promise<number | null> {
  const form = new FormData();
  if (content) form.append("content", content);
  form.append("message_type", "incoming");
  if (attachment.isVoice) form.append("is_voice_message", "true");
  form.append("attachments[]", file, attachment.fileName);
  try {
    const res = await cwFetch(
      cfg,
      "POST",
      `/conversations/${ids.conversationId}/messages`,
      form,
      UPLOAD_TIMEOUT_MS,
    );
    return res.status;
  } catch (err) {
    logger.warn({ err, chatId }, "chatwoot attachment upload got no answer");
    return null;
  }
}

function clip(text: string): string {
  return text.length > MAX_CONTENT_LENGTH ? text.slice(0, MAX_CONTENT_LENGTH) : text;
}

async function postText(
  cfg: ChatwootConfig,
  chatId: string,
  ids: ChatwootIds,
  content: string,
  direction: "incoming" | "outgoing",
  senderName: string | undefined,
): Promise<void> {
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
  const content = clip(trimmed);

  const ids = await ensureIds(cfg, chatId, senderName);
  if (!ids) return;

  await postText(cfg, chatId, ids, content, direction, senderName);
}

// Logs carry ids, status, type and size only — never the caption, file name or bytes.
async function mirrorAttachment(
  chatId: string,
  loadAttachment: () => Promise<ChatwootAttachment | null>,
  caption: string | undefined,
  fallbackText: string,
  senderName: string | undefined,
): Promise<void> {
  const cfg = config();
  if (!cfg) return;

  // Ids before the download: a lead's first message may be a big file, and the conversation
  // must already exist for a menu tap's auto-assign; with nowhere to post, nothing is fetched.
  let ids = await ensureIds(cfg, chatId, senderName);
  if (!ids) return;
  const placeholder = clip(fallbackText.trim());

  let attachment: ChatwootAttachment | null = null;
  try {
    attachment = await loadAttachment();
    if (!attachment) logger.warn({ chatId }, "chatwoot attachment unavailable — posting the placeholder");
  } catch (err) {
    logger.warn({ err, chatId }, "chatwoot attachment load threw — posting the placeholder");
  }
  if (!attachment) {
    await postText(cfg, chatId, ids, placeholder, "incoming", senderName);
    return;
  }

  const content = clip(caption?.trim() ?? "");
  // One copy of the bytes, reused by the 404 retry. The cast only satisfies BlobPart's
  // ArrayBuffer-only typing; these Buffers never sit on a SharedArrayBuffer.
  const file = new Blob([attachment.bytes as Uint8Array<ArrayBuffer>], { type: attachment.contentType });

  let status = await postAttachment(cfg, chatId, ids, attachment, file, content);
  if (status === 404) {
    // Conversation deleted in Chatwoot — drop the cached ids and rebuild once.
    await clearIds(chatId);
    ids = await ensureIds(cfg, chatId, senderName);
    if (!ids) return;
    status = await postAttachment(cfg, chatId, ids, attachment, file, content);
  }
  if (status !== null && status < 400) return;

  logger.warn(
    { chatId, status, contentType: attachment.contentType, size: attachment.bytes.byteLength },
    "chatwoot attachment upload failed — posting the placeholder",
  );
  await postText(cfg, chatId, ids, placeholder, "incoming", senderName);
}

export async function mirrorInbound(
  chatId: string,
  text: string,
  senderName?: string,
): Promise<void> {
  return enqueue(chatId, "chatwoot mirrorInbound failed — continuing", () =>
    mirrorMessage(chatId, text, "incoming", senderName),
  );
}

export async function mirrorOutbound(chatId: string, text: string): Promise<void> {
  return enqueue(chatId, "chatwoot mirrorOutbound failed — continuing", () =>
    mirrorMessage(chatId, text, "outgoing"),
  );
}

/**
 * Mirror an inbound file as a real Chatwoot attachment (photo inline, audio/video player,
 * anything else a file card), the caption as the message text. When the file cannot be
 * loaded or the upload fails, `fallbackText` is posted instead so the message never vanishes.
 */
export async function mirrorInboundAttachment(
  chatId: string,
  loadAttachment: () => Promise<ChatwootAttachment | null>,
  caption: string | undefined,
  fallbackText: string,
  senderName?: string,
): Promise<void> {
  return enqueue(chatId, "chatwoot mirrorInboundAttachment failed — continuing", () =>
    mirrorAttachment(chatId, loadAttachment, caption, fallbackText, senderName),
  );
}

// Best-effort private note (e.g. template-send failure surfaced to the agent) posted
// directly against a known conversation id — no contact/conversation resolution needed.
export async function postPrivateNote(conversationId: number, content: string): Promise<void> {
  const cfg = config();
  if (!cfg) return;
  try {
    const res = await cwFetch(cfg, "POST", `/conversations/${conversationId}/messages`, {
      content,
      message_type: "outgoing",
      private: true,
    });
    if (res.status >= 400) {
      logger.warn({ conversationId, status: res.status }, "chatwoot postPrivateNote failed");
    }
  } catch (err) {
    logger.warn({ err, conversationId }, "chatwoot postPrivateNote failed — continuing");
  }
}
