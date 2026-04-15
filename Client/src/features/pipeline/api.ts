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
  const { data } = await api.get<WhatsAppState>("/whatsapp/state");
  return data;
}

export async function fetchQrCode(): Promise<QrCodeResponse> {
  const { data } = await api.get<QrCodeResponse>("/whatsapp/qr");
  return data;
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
