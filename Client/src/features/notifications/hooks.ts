import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { supabase } from "@/lib/supabase";
import {
  fetchNotifications,
  fetchUnreadCount,
  markNotificationRead,
  markAllNotificationsRead,
} from "./api";
import type { Notification, NotificationsFilter } from "./api";

// ── Query Keys ────────────────────────────────────────────────────────────

export const NOTIFICATIONS_KEY = ["notifications"] as const;
export const UNREAD_COUNT_KEY = ["notifications", "unread-count"] as const;

// ── Queries ───────────────────────────────────────────────────────────────

export function useNotifications(filters?: NotificationsFilter) {
  return useQuery({
    queryKey: [...NOTIFICATIONS_KEY, filters],
    queryFn: () => fetchNotifications(filters),
    refetchInterval: 15_000,
  });
}

export function useUnreadCount() {
  return useQuery({
    queryKey: UNREAD_COUNT_KEY,
    queryFn: fetchUnreadCount,
    refetchInterval: 10_000,
  });
}

// ── Mutations ─────────────────────────────────────────────────────────────

export function useMarkRead() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: markNotificationRead,
    onMutate: async (id: string) => {
      await qc.cancelQueries({ queryKey: NOTIFICATIONS_KEY });
      await qc.cancelQueries({ queryKey: UNREAD_COUNT_KEY });

      const prevNotifications = qc.getQueriesData<{ data: Notification[]; total: number }>({
        queryKey: NOTIFICATIONS_KEY,
      });
      const prevUnreadCount = qc.getQueryData<{ count: number }>(UNREAD_COUNT_KEY);

      // Optimistically mark the notification as read in all matching caches
      qc.setQueriesData<{ data: Notification[]; total: number }>(
        { queryKey: NOTIFICATIONS_KEY },
        (old) => {
          if (!old) return old;
          return {
            ...old,
            data: old.data.map((n) =>
              n.id === id ? { ...n, is_read: true, read_at: new Date().toISOString() } : n,
            ),
          };
        },
      );

      // Optimistically decrement unread count
      qc.setQueryData<{ count: number }>(UNREAD_COUNT_KEY, (old) => {
        if (!old) return old;
        return { count: Math.max(0, old.count - 1) };
      });

      return { prevNotifications, prevUnreadCount };
    },
    onError: (_err, _id, context) => {
      if (context?.prevNotifications) {
        for (const [queryKey, data] of context.prevNotifications) {
          qc.setQueryData(queryKey, data);
        }
      }
      if (context?.prevUnreadCount) {
        qc.setQueryData(UNREAD_COUNT_KEY, context.prevUnreadCount);
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
      void qc.invalidateQueries({ queryKey: UNREAD_COUNT_KEY });
    },
  });
}

export function useMarkAllRead() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: markAllNotificationsRead,
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: NOTIFICATIONS_KEY });
      await qc.cancelQueries({ queryKey: UNREAD_COUNT_KEY });

      const prevNotifications = qc.getQueriesData<{ data: Notification[]; total: number }>({
        queryKey: NOTIFICATIONS_KEY,
      });
      const prevUnreadCount = qc.getQueryData<{ count: number }>(UNREAD_COUNT_KEY);

      const now = new Date().toISOString();

      qc.setQueriesData<{ data: Notification[]; total: number }>(
        { queryKey: NOTIFICATIONS_KEY },
        (old) => {
          if (!old) return old;
          return {
            ...old,
            data: old.data.map((n) => ({ ...n, is_read: true, read_at: now })),
          };
        },
      );

      qc.setQueryData<{ count: number }>(UNREAD_COUNT_KEY, { count: 0 });

      return { prevNotifications, prevUnreadCount };
    },
    onError: (_err, _vars, context) => {
      if (context?.prevNotifications) {
        for (const [queryKey, data] of context.prevNotifications) {
          qc.setQueryData(queryKey, data);
        }
      }
      if (context?.prevUnreadCount) {
        qc.setQueryData(UNREAD_COUNT_KEY, context.prevUnreadCount);
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
      void qc.invalidateQueries({ queryKey: UNREAD_COUNT_KEY });
    },
  });
}

// ── Realtime Subscription ─────────────────────────────────────────────────

export function useNotificationsRealtime() {
  const qc = useQueryClient();

  useEffect(() => {
    const channel = supabase
      .channel("notifications-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "notifications" },
        () => {
          void qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
          void qc.invalidateQueries({ queryKey: UNREAD_COUNT_KEY });
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [qc]);
}
