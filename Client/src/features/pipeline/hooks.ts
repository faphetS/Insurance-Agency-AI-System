import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { supabase } from "@/lib/supabase";
import {
  fetchPipeline,
  updateClientStage,
  fetchConversations,
  fetchConversationsWithLastMessage,
  fetchMessages,
  fetchBotSettings,
  updateBotSettings,
  fetchWhatsappState,
  fetchQrCode,
  pauseBotForConversation,
  fetchClientTasks,
} from "./api";
import type { BotSettingsRow } from "./types";

// ── Query Keys ────────────────────────────────────────────────────────────

export const PIPELINE_KEY = ["pipeline"] as const;
export const CONVERSATIONS_KEY = ["conversations"] as const;
export const CONVERSATIONS_WITH_LAST_MSG_KEY = ["conversations-with-last-msg"] as const;
export const BOT_SETTINGS_KEY = ["bot-settings"] as const;
export const WHATSAPP_STATE_KEY = ["whatsapp-state"] as const;

// ── Pipeline ──────────────────────────────────────────────────────────────

export function usePipeline() {
  return useQuery({
    queryKey: PIPELINE_KEY,
    queryFn: fetchPipeline,
    staleTime: 30_000,
  });
}

export function useUpdateClientStage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ clientId, stage }: { clientId: string; stage: string }) =>
      updateClientStage(clientId, stage),
    onMutate: async ({ clientId, stage }) => {
      await qc.cancelQueries({ queryKey: PIPELINE_KEY });
      const prev = qc.getQueryData(PIPELINE_KEY);
      qc.setQueryData(PIPELINE_KEY, (old: ReturnType<typeof fetchPipeline> extends Promise<infer T> ? T : never) => {
        if (!old) return old;
        return (old as Array<Record<string, unknown>>).map((row) =>
          row.id === clientId ? { ...row, pipeline_stage: stage, derived_stage: stage } : row,
        );
      });
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(PIPELINE_KEY, ctx.prev);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: PIPELINE_KEY });
    },
  });
}

// ── Conversations ─────────────────────────────────────────────────────────

export function useConversations() {
  return useQuery({
    queryKey: CONVERSATIONS_KEY,
    queryFn: fetchConversations,
    staleTime: 30_000,
  });
}

export function useConversationsWithLastMessage() {
  return useQuery({
    queryKey: CONVERSATIONS_WITH_LAST_MSG_KEY,
    queryFn: () => fetchConversationsWithLastMessage(20),
    staleTime: 20_000,
  });
}

export function useMessages(conversationId: string | null) {
  return useQuery({
    queryKey: ["messages", conversationId],
    queryFn: () => fetchMessages(conversationId!),
    enabled: conversationId !== null,
    staleTime: 10_000,
  });
}

export function usePauseBotMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ conversationId, paused }: { conversationId: string; paused: boolean }) =>
      pauseBotForConversation(conversationId, paused),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: CONVERSATIONS_KEY });
    },
  });
}

// ── Bot Settings ──────────────────────────────────────────────────────────

export function useBotSettings() {
  return useQuery({
    queryKey: BOT_SETTINGS_KEY,
    queryFn: fetchBotSettings,
    staleTime: 60_000,
  });
}

export function useUpdateBotSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<BotSettingsRow>) => updateBotSettings(patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: BOT_SETTINGS_KEY });
    },
  });
}

// ── WhatsApp ──────────────────────────────────────────────────────────────

export function useWhatsappState() {
  return useQuery({
    queryKey: WHATSAPP_STATE_KEY,
    queryFn: fetchWhatsappState,
    refetchInterval: 10_000,
    retry: false,
    staleTime: 0,
  });
}

export function useQrCode(enabled: boolean) {
  return useQuery({
    queryKey: ["whatsapp-qr"],
    queryFn: fetchQrCode,
    enabled,
    retry: false,
    staleTime: 60_000,
  });
}

// ── Tasks ─────────────────────────────────────────────────────────────────

export function useClientTasks(clientId: string | null) {
  return useQuery({
    queryKey: ["tasks", clientId],
    queryFn: () => fetchClientTasks(clientId!),
    enabled: clientId !== null,
    staleTime: 30_000,
  });
}

// ── Realtime Subscription ─────────────────────────────────────────────────

export function useRealtimePipeline() {
  const qc = useQueryClient();

  useEffect(() => {
    const channel = supabase
      .channel("pipeline-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "clients" },
        () => {
          qc.invalidateQueries({ queryKey: PIPELINE_KEY });
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "messages" },
        (payload) => {
          // Invalidate specific conversation messages
          const convId = (payload.new as Record<string, unknown>)?.conversation_id as string | undefined;
          if (convId) {
            qc.invalidateQueries({ queryKey: ["messages", convId] });
          }
          qc.invalidateQueries({ queryKey: PIPELINE_KEY });
          qc.invalidateQueries({ queryKey: CONVERSATIONS_WITH_LAST_MSG_KEY });
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "conversations" },
        () => {
          qc.invalidateQueries({ queryKey: CONVERSATIONS_KEY });
          qc.invalidateQueries({ queryKey: CONVERSATIONS_WITH_LAST_MSG_KEY });
          qc.invalidateQueries({ queryKey: PIPELINE_KEY });
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [qc]);
}
