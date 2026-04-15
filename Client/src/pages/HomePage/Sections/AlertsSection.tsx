import { useMemo, useState } from "react";
import { AlertCircle, Clock, Wrench, MessageSquare } from "lucide-react";
import { usePipeline, useConversations } from "@/features/pipeline/hooks";
import type { PipelineRow } from "@/features/pipeline/types";
import { ConversationDrawer } from "./ConversationDrawer";
import type { ConversationRow } from "@/features/pipeline/types";
import { formatDistanceToNow } from "date-fns";

type AlertType = "unanswered" | "idle" | "service_due";
type FilterKey = "all" | AlertType;

interface Alert {
  id: string;
  type: AlertType;
  label: string;
  detail: string;
  client: PipelineRow;
  conversation: ConversationRow | null;
}

const ALERT_META: Record<AlertType, { icon: typeof AlertCircle; dotColor: string; labelColor: string; chipBg: string }> = {
  unanswered: {
    icon: MessageSquare,
    dotColor: "#fb7185",
    labelColor: "#fb7185",
    chipBg: "rgba(244,63,94,0.12)",
  },
  idle: {
    icon: Clock,
    dotColor: "#fbbf24",
    labelColor: "#fbbf24",
    chipBg: "rgba(245,158,11,0.12)",
  },
  service_due: {
    icon: Wrench,
    dotColor: "#38bdf8",
    labelColor: "#38bdf8",
    chipBg: "rgba(56,189,248,0.12)",
  },
};

const FILTER_LABELS: Record<FilterKey, string> = {
  all: "All",
  unanswered: "Unanswered",
  idle: "Idle",
  service_due: "Service Due",
};

// ── Alert row ─────────────────────────────────────────────────────────────

function AlertRow({ alert, onOpen }: { alert: Alert; onOpen: () => void }) {
  const meta = ALERT_META[alert.type];
  const Icon = meta.icon;

  return (
    <div
      className="flex items-center gap-3 rounded-xl px-3 py-2.5"
      style={{ backgroundColor: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
    >
      <span
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
        style={{ backgroundColor: meta.chipBg }}
      >
        <Icon size={14} style={{ color: meta.dotColor } as React.CSSProperties} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold" style={{ color: "#cbd5e1" }} dir="auto">
          {alert.label}
        </p>
        <p className="text-xs" style={{ color: "#475569" }}>
          {alert.detail}
        </p>
      </div>
      <button
        onClick={onOpen}
        className="shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors"
        style={{ backgroundColor: "rgba(99,102,241,0.2)", color: "#818cf8" }}
        onMouseEnter={(e) =>
          ((e.currentTarget as HTMLButtonElement).style.backgroundColor = "rgba(99,102,241,0.35)")
        }
        onMouseLeave={(e) =>
          ((e.currentTarget as HTMLButtonElement).style.backgroundColor = "rgba(99,102,241,0.2)")
        }
      >
        Open
      </button>
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────

export function AlertsSection() {
  const { data: pipeline } = usePipeline();
  const { data: conversations } = useConversations();
  const [selectedClient, setSelectedClient] = useState<PipelineRow | null>(null);
  const [selectedConversation, setSelectedConversation] = useState<ConversationRow | null>(null);
  const [filter, setFilter] = useState<FilterKey>("all");

  const convMap = useMemo(() => {
    const m = new Map<string, ConversationRow>();
    (conversations ?? []).forEach((c) => {
      if (c.client_id) m.set(c.client_id, c);
    });
    return m;
  }, [conversations]);

  const alerts = useMemo<Alert[]>(() => {
    if (!pipeline) return [];
    const result: Alert[] = [];
    const now = Date.now();

    pipeline.forEach((client) => {
      if (!client.id) return;
      const conv = client.id ? (convMap.get(client.id) ?? null) : null;

      if (conv && conv.status === "open") {
        const lastMs = new Date(conv.last_message_at).getTime();
        const minutesSince = (now - lastMs) / 60_000;
        if (minutesSince > 30) {
          result.push({
            id: `unanswered-${client.id}`,
            type: "unanswered",
            label: client.full_name ?? "Unknown",
            detail: `No reply for ${Math.round(minutesSince)} min`,
            client,
            conversation: conv,
          });
        }
      }

      if (client.time_in_stage_hours != null && client.time_in_stage_hours > 168) {
        result.push({
          id: `idle-${client.id}`,
          type: "idle",
          label: client.full_name ?? "Unknown",
          detail: `Idle ${Math.round(client.time_in_stage_hours / 24)}d in stage`,
          client,
          conversation: conv,
        });
      }

      if (client.last_service_date) {
        const due = new Date(client.last_service_date);
        due.setMonth(due.getMonth() + 24);
        const daysUntil = (due.getTime() - now) / 86_400_000;
        if (daysUntil >= 0 && daysUntil <= 30) {
          result.push({
            id: `service-${client.id}`,
            type: "service_due",
            label: client.full_name ?? "Unknown",
            detail: `Service due ${formatDistanceToNow(due, { addSuffix: true })}`,
            client,
            conversation: conv,
          });
        }
      }
    });

    return result;
  }, [pipeline, convMap]);

  const filtered = filter === "all" ? alerts : alerts.filter((a) => a.type === filter);

  const handleOpen = (alert: Alert) => {
    setSelectedClient(alert.client);
    setSelectedConversation(alert.conversation);
  };

  const typeCounts: Record<FilterKey, number> = {
    all: alerts.length,
    unanswered: alerts.filter((a) => a.type === "unanswered").length,
    idle: alerts.filter((a) => a.type === "idle").length,
    service_due: alerts.filter((a) => a.type === "service_due").length,
  };

  return (
    <>
      <div
        className="flex h-full flex-col rounded-2xl p-5"
        style={{ backgroundColor: "#0f172a", border: "1px solid rgba(255,255,255,0.07)" }}
      >
        {/* Header */}
        <div className="mb-4 flex items-center gap-2">
          <h2 className="text-sm font-bold uppercase tracking-widest" style={{ color: "#475569" }}>
            Alerts
          </h2>
          {alerts.length > 0 && (
            <span
              className="flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-bold tabular-nums"
              style={{ backgroundColor: "#f43f5e", color: "#fff" }}
            >
              {alerts.length}
            </span>
          )}
        </div>

        {/* Filter pills */}
        <div className="mb-4 flex flex-wrap gap-1.5">
          {(["all", "unanswered", "idle", "service_due"] as FilterKey[]).map((key) => {
            const isActive = filter === key;
            return (
              <button
                key={key}
                onClick={() => setFilter(key)}
                className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold transition-all"
                style={
                  isActive
                    ? { backgroundColor: "#6366f1", color: "#fff" }
                    : {
                        backgroundColor: "rgba(255,255,255,0.05)",
                        color: "#64748b",
                        border: "1px solid rgba(255,255,255,0.07)",
                      }
                }
              >
                {FILTER_LABELS[key]}
                {typeCounts[key] > 0 && (
                  <span
                    className="rounded-full px-1 text-[9px] font-bold tabular-nums"
                    style={{
                      backgroundColor: isActive ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.08)",
                    }}
                  >
                    {typeCounts[key]}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Alert list */}
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8" style={{ color: "#1e293b" }}>
            <AlertCircle size={28} />
            <p className="text-sm">
              {alerts.length === 0 ? "All clear — no active alerts" : "No alerts in this category"}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {filtered.map((alert) => (
              <AlertRow key={alert.id} alert={alert} onOpen={() => handleOpen(alert)} />
            ))}
          </div>
        )}
      </div>

      <ConversationDrawer
        client={selectedClient}
        conversation={selectedConversation}
        open={selectedClient !== null}
        onClose={() => {
          setSelectedClient(null);
          setSelectedConversation(null);
        }}
      />
    </>
  );
}
