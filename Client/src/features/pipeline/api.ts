import { supabase } from "@/lib/supabase";
import api from "@/services/api";
import type { PipelineRow, BotSettingsRow, WhatsAppState, QrCodeResponse, SendMessagePayload } from "./types";

// ── Pipeline / Clients ─────────────────────────────────────────────────────

export async function fetchPipeline(): Promise<PipelineRow[]> {
  const { data, error } = await supabase
    .from("v_client_pipeline")
    .select("*")
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function updateClientStage(clientId: string, stage: string): Promise<void> {
  const { error } = await supabase
    .from("clients")
    .update({ pipeline_stage: stage, updated_at: new Date().toISOString() })
    .eq("id", clientId);
  if (error) throw error;
}

// ── Conversations ─────────────────────────────────────────────────────────

export async function fetchConversations() {
  const { data, error } = await supabase
    .from("conversations")
    .select("*")
    .order("last_message_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export interface ConversationWithLastMessage {
  id: string;
  contact_name: string | null;
  contact_phone: string | null;
  whatsapp_chat_id: string;
  bot_paused: boolean;
  status: string;
  last_message_at: string;
  client_id: string | null;
  created_at: string;
  last_message_body: string | null;
  last_message_direction: string | null;
  has_pending_reply: boolean;
}

export async function fetchConversationsWithLastMessage(
  limit = 20,
): Promise<ConversationWithLastMessage[]> {
  // Fetch conversations ordered by recency
  const { data: convs, error: convErr } = await supabase
    .from("conversations")
    .select("*")
    .order("last_message_at", { ascending: false })
    .limit(limit);
  if (convErr) throw convErr;
  if (!convs || convs.length === 0) return [];

  const convIds = convs.map((c) => c.id);

  // Fetch the latest message per conversation in one query
  const { data: msgs, error: msgErr } = await supabase
    .from("messages")
    .select("id, conversation_id, body, direction, created_at")
    .in("conversation_id", convIds)
    .order("created_at", { ascending: false });
  if (msgErr) throw msgErr;

  // Build a map: conversation_id → latest message (first hit per conv since ordered DESC)
  const latestMsgMap = new Map<
    string,
    { body: string | null; direction: string; created_at: string }
  >();
  for (const msg of msgs ?? []) {
    if (!latestMsgMap.has(msg.conversation_id)) {
      latestMsgMap.set(msg.conversation_id, {
        body: msg.body,
        direction: msg.direction,
        created_at: msg.created_at,
      });
    }
  }

  // Build pending-reply map: true if the latest message is inbound (no outbound after it)
  const pendingMap = new Map<string, boolean>();
  for (const [convId, msg] of latestMsgMap) {
    pendingMap.set(convId, msg.direction === "inbound");
  }

  return convs.map((c) => {
    const latest = latestMsgMap.get(c.id);
    return {
      ...c,
      last_message_body: latest?.body ?? null,
      last_message_direction: latest?.direction ?? null,
      has_pending_reply: pendingMap.get(c.id) ?? false,
    };
  });
}

export async function fetchMessages(conversationId: string) {
  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function pauseBotForConversation(conversationId: string, paused: boolean): Promise<void> {
  const { error } = await supabase
    .from("conversations")
    .update({ bot_paused: paused })
    .eq("id", conversationId);
  if (error) throw error;
}

// ── Bot Settings ──────────────────────────────────────────────────────────

export async function fetchBotSettings(): Promise<BotSettingsRow | null> {
  const { data, error } = await supabase
    .from("bot_settings")
    .select("*")
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function updateBotSettings(patch: Partial<BotSettingsRow>): Promise<void> {
  const { error } = await supabase
    .from("bot_settings")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .neq("id", 0); // update all rows (there's only 1)
  if (error) throw error;
}

// ── WhatsApp (via Express) ────────────────────────────────────────────────

export async function fetchWhatsappState(): Promise<WhatsAppState> {
  const { data } = await api.get<{ data: WhatsAppState }>("/whatsapp/state");
  return data.data;
}

export async function fetchQrCode(): Promise<QrCodeResponse> {
  const { data } = await api.get<{ data: QrCodeResponse }>("/whatsapp/qr");
  return data.data;
}

export async function sendManualMessage(payload: SendMessagePayload): Promise<void> {
  await api.post("/whatsapp/send", payload);
}

// ── Tasks ─────────────────────────────────────────────────────────────────

export async function fetchClientTasks(clientId: string) {
  const { data, error } = await supabase
    .from("tasks")
    .select("*")
    .eq("client_id", clientId)
    .eq("status", "open")
    .order("due_at", { ascending: true });
  if (error) throw error;
  return data ?? [];
}
