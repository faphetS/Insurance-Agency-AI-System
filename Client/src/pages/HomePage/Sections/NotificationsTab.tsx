import { useState } from "react";
import { Bell, RefreshCw, CheckCheck, ChevronDown, ChevronUp } from "lucide-react";
import {
  useNotifications,
  useMarkRead,
  useMarkAllRead,
  useNotificationsRealtime,
} from "@/features/notifications/hooks";
import type { Notification } from "@/features/notifications/api";

// ── Helpers ───────────────────────────────────────────────────────────────

function formatRelativeTime(dateString: string): string {
  const diff = Date.now() - new Date(dateString).getTime();
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);

  if (diff < 60_000) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  if (days === 1) return "Yesterday";
  return `${days} days ago`;
}

// ── Severity helpers ──────────────────────────────────────────────────────

const severityDot: Record<Notification["severity"], string> = {
  info: "#6366f1",
  warning: "#f59e0b",
  urgent: "#f43f5e",
};

const severityLabel: Record<Notification["severity"], string> = {
  info: "Info",
  warning: "Warning",
  urgent: "Urgent",
};

// ── Skeleton loader ───────────────────────────────────────────────────────

function NotificationSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          className="flex items-start gap-3 rounded-xl p-4"
          style={{ backgroundColor: "#0f172a", border: "1px solid rgba(255,255,255,0.07)" }}
        >
          <div className="mt-1 h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-slate-700" />
          <div className="flex-1 space-y-2">
            <div className="h-3 w-1/3 animate-pulse rounded bg-slate-800" />
            <div className="h-3 w-2/3 animate-pulse rounded bg-slate-800/70" />
          </div>
          <div className="h-3 w-12 animate-pulse rounded bg-slate-800" />
        </div>
      ))}
    </div>
  );
}

// ── Filter pill ───────────────────────────────────────────────────────────

interface FilterPillProps {
  label: string;
  active: boolean;
  onClick: () => void;
}

function FilterPill({ label, active, onClick }: FilterPillProps) {
  return (
    <button
      onClick={onClick}
      className="rounded-full px-3 py-1 text-xs font-semibold transition-all"
      style={
        active
          ? { backgroundColor: "#6366f1", color: "#ffffff" }
          : { backgroundColor: "rgba(255,255,255,0.05)", color: "#64748b" }
      }
      onMouseEnter={(e) => {
        if (!active) {
          e.currentTarget.style.color = "#94a3b8";
          e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.08)";
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          e.currentTarget.style.color = "#64748b";
          e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.05)";
        }
      }}
    >
      {label}
    </button>
  );
}

// ── Notification row ──────────────────────────────────────────────────────

interface NotificationRowProps {
  notification: Notification;
  onMarkRead: (id: string) => void;
}

function NotificationRow({ notification, onMarkRead }: NotificationRowProps) {
  const [expanded, setExpanded] = useState(false);
  const isUnread = !notification.is_read;
  const dotColor = severityDot[notification.severity];

  const handleClick = () => {
    setExpanded((prev) => !prev);
    if (isUnread) {
      onMarkRead(notification.id);
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className="w-full rounded-xl p-4 text-left transition-all"
      style={{
        backgroundColor: isUnread ? "rgba(99,102,241,0.06)" : "#0f172a",
        border: isUnread
          ? "1px solid rgba(99,102,241,0.18)"
          : "1px solid rgba(255,255,255,0.07)",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = isUnread
          ? "rgba(99,102,241,0.1)"
          : "rgba(255,255,255,0.03)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = isUnread
          ? "rgba(99,102,241,0.06)"
          : "#0f172a";
      }}
    >
      <div className="flex items-start gap-3">
        {/* Severity dot */}
        <span
          className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: dotColor }}
        />

        {/* Main content */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p
              className="text-sm leading-tight"
              style={{
                color: isUnread ? "#e2e8f0" : "#94a3b8",
                fontWeight: isUnread ? 600 : 400,
              }}
            >
              {notification.title}
            </p>
            <span
              className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide"
              style={{
                backgroundColor: `${dotColor}18`,
                color: dotColor,
              }}
            >
              {severityLabel[notification.severity]}
            </span>
          </div>

          <p
            className="mt-1 text-xs leading-relaxed"
            style={{ color: expanded ? "#64748b" : "#475569" }}
          >
            {expanded ? notification.message : notification.message.slice(0, 120) + (notification.message.length > 120 ? "…" : "")}
          </p>
        </div>

        {/* Right side: time + expand icon */}
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="text-[10px] tabular-nums" style={{ color: "#334155" }}>
            {formatRelativeTime(notification.created_at)}
          </span>
          {expanded ? (
            <ChevronUp className="h-3.5 w-3.5" style={{ color: "#334155" }} />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" style={{ color: "#334155" }} />
          )}
        </div>
      </div>

      {/* Expanded: unread dot */}
      {isUnread && (
        <div className="mt-2 flex justify-end">
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: "#6366f1" }}
          />
        </div>
      )}
    </button>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────

function EmptyState({ filtered }: { filtered: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div
        className="mb-4 flex h-12 w-12 items-center justify-center rounded-full"
        style={{ backgroundColor: "rgba(99,102,241,0.1)" }}
      >
        <Bell className="h-5 w-5" style={{ color: "#6366f1" }} />
      </div>
      <p className="text-sm font-medium" style={{ color: "#475569" }}>
        {filtered ? "No notifications match these filters" : "No notifications yet"}
      </p>
      <p className="mt-1 text-xs" style={{ color: "#334155" }}>
        {filtered
          ? "Try adjusting the filters above"
          : "Automated checks will appear here when they detect issues"}
      </p>
    </div>
  );
}

// ── Main tab ──────────────────────────────────────────────────────────────

type SeverityFilter = "all" | "info" | "warning" | "urgent";
type ReadFilter = "all" | "unread" | "read";

export function NotificationsTab() {
  useNotificationsRealtime();

  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>("all");
  const [readFilter, setReadFilter] = useState<ReadFilter>("all");

  const queryFilters = {
    ...(severityFilter !== "all" && { severity: severityFilter }),
    ...(readFilter === "unread" && { is_read: false }),
    ...(readFilter === "read" && { is_read: true }),
  };

  const { data, isLoading, isError, refetch, isFetching } = useNotifications(queryFilters);
  const markRead = useMarkRead();
  const markAllRead = useMarkAllRead();

  const notifications = data?.data ?? [];
  const total = data?.total ?? 0;
  const unreadCount = notifications.filter((n) => !n.is_read).length;
  const hasFilters = severityFilter !== "all" || readFilter !== "all";

  const hairline = "1px solid rgba(255,255,255,0.07)";

  return (
    <div className="mx-auto max-w-3xl px-5 py-6">
      {/* Top bar */}
      <div className="mb-5 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div
            className="flex h-9 w-9 items-center justify-center rounded-lg"
            style={{ backgroundColor: "rgba(99,102,241,0.12)", border: hairline }}
          >
            <Bell className="h-4 w-4" style={{ color: "#6366f1" }} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold" style={{ color: "#e2e8f0" }}>
                Notifications
              </h2>
              {unreadCount > 0 && (
                <span
                  className="flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold tabular-nums"
                  style={{ backgroundColor: "#f43f5e", color: "#fff" }}
                >
                  {unreadCount}
                </span>
              )}
            </div>
            {total > 0 && (
              <p className="mt-0.5 text-xs tabular-nums" style={{ color: "#334155" }}>
                {total} total
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void refetch()}
            disabled={isFetching}
            className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors disabled:opacity-40"
            style={{ backgroundColor: "rgba(255,255,255,0.05)", border: hairline }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.08)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.05)";
            }}
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`}
              style={{ color: "#64748b" }}
            />
          </button>

          {unreadCount > 0 && (
            <button
              type="button"
              onClick={() => markAllRead.mutate()}
              disabled={markAllRead.isPending}
              className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-40"
              style={{ backgroundColor: "rgba(99,102,241,0.12)", border: hairline, color: "#818cf8" }}
              onMouseEnter={(e) => {
                if (!markAllRead.isPending) {
                  e.currentTarget.style.backgroundColor = "rgba(99,102,241,0.2)";
                }
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = "rgba(99,102,241,0.12)";
              }}
            >
              <CheckCheck className="h-3.5 w-3.5" />
              Mark all as read
            </button>
          )}
        </div>
      </div>

      {/* Filter row */}
      <div
        className="mb-5 flex flex-wrap items-center gap-4 rounded-xl px-4 py-3"
        style={{ backgroundColor: "#0f172a", border: hairline }}
      >
        <div className="flex items-center gap-1.5">
          <span className="mr-1 text-[10px] font-bold uppercase tracking-widest" style={{ color: "#334155" }}>
            Severity
          </span>
          {(["all", "info", "warning", "urgent"] as SeverityFilter[]).map((s) => (
            <FilterPill
              key={s}
              label={s === "all" ? "All" : severityLabel[s as Notification["severity"]]}
              active={severityFilter === s}
              onClick={() => setSeverityFilter(s)}
            />
          ))}
        </div>

        <div
          className="hidden h-4 w-px sm:block"
          style={{ backgroundColor: "rgba(255,255,255,0.07)" }}
        />

        <div className="flex items-center gap-1.5">
          <span className="mr-1 text-[10px] font-bold uppercase tracking-widest" style={{ color: "#334155" }}>
            Status
          </span>
          {(["all", "unread", "read"] as ReadFilter[]).map((r) => (
            <FilterPill
              key={r}
              label={r === "all" ? "All" : r.charAt(0).toUpperCase() + r.slice(1)}
              active={readFilter === r}
              onClick={() => setReadFilter(r)}
            />
          ))}
        </div>
      </div>

      {/* Content */}
      {isLoading ? (
        <NotificationSkeleton />
      ) : isError ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3">
          <p className="text-sm" style={{ color: "#f43f5e" }}>
            Failed to load notifications
          </p>
          <button
            type="button"
            onClick={() => void refetch()}
            className="rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors"
            style={{ backgroundColor: "rgba(244,63,94,0.1)", color: "#fb7185", border: "1px solid rgba(244,63,94,0.2)" }}
          >
            Try again
          </button>
        </div>
      ) : notifications.length === 0 ? (
        <EmptyState filtered={hasFilters} />
      ) : (
        <div className="flex flex-col gap-2">
          {notifications.map((notification) => (
            <NotificationRow
              key={notification.id}
              notification={notification}
              onMarkRead={(id) => markRead.mutate(id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
