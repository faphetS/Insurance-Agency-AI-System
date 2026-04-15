import { useMemo, useState } from "react";
import { AlertCircle, Clock, Wrench, MessageSquare } from "lucide-react";
import { usePipeline, useConversations } from "@/features/pipeline/hooks";
import type { PipelineRow } from "@/features/pipeline/types";
import { ConversationDrawer } from "./ConversationDrawer";
import type { ConversationRow } from "@/features/pipeline/types";
import { formatDistanceToNow } from "date-fns";

type AlertType = "unanswered" | "idle" | "service_due";

interface Alert {
  id: string;
  type: AlertType;
  label: string;
  detail: string;
  client: PipelineRow;
  conversation: ConversationRow | null;
}

const ALERT_META: Record<AlertType, { icon: typeof AlertCircle; color: string; bg: string }> = {
  unanswered: { icon: MessageSquare, color: "text-rose-600", bg: "bg-rose-50" },
  idle: { icon: Clock, color: "text-amber-600", bg: "bg-amber-50" },
  service_due: { icon: Wrench, color: "text-sky-600", bg: "bg-sky-50" },
};

export function AlertsSection() {
  const { data: pipeline } = usePipeline();
  const { data: conversations } = useConversations();
  const [selectedClient, setSelectedClient] = useState<PipelineRow | null>(null);
  const [selectedConversation, setSelectedConversation] = useState<ConversationRow | null>(null);

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

      // Unanswered: last_message_at > 30 min ago and conversation status open
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

      // Idle: time_in_stage_hours > 168 (7 days)
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

      // Service due: last_service_date + 24 months within 30 days
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

  const handleOpen = (alert: Alert) => {
    setSelectedClient(alert.client);
    setSelectedConversation(alert.conversation);
  };

  if (alerts.length === 0) {
    return (
      <div className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
        <h2 className="mb-4 text-base font-bold text-neutral-900">Alerts</h2>
        <div className="flex flex-col items-center gap-2 py-6 text-neutral-400">
          <AlertCircle size={28} />
          <p className="text-sm">No active alerts — all clear!</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-bold text-neutral-900">Alerts</h2>
          <span className="flex h-6 min-w-6 items-center justify-center rounded-full bg-rose-500 px-2 text-xs font-bold tabular-nums text-white">
            {alerts.length}
          </span>
        </div>

        <div className="flex flex-col gap-2">
          {alerts.map((alert) => {
            const meta = ALERT_META[alert.type];
            const Icon = meta.icon;
            return (
              <div
                key={alert.id}
                className="flex items-center gap-3 rounded-xl border border-neutral-100 bg-neutral-50 px-3 py-2.5"
              >
                <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${meta.bg}`}>
                  <Icon size={14} className={meta.color} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-neutral-800">{alert.label}</p>
                  <p className="text-xs text-neutral-500">{alert.detail}</p>
                </div>
                <button
                  onClick={() => handleOpen(alert)}
                  className="shrink-0 rounded-lg bg-neutral-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-neutral-700"
                >
                  Open
                </button>
              </div>
            );
          })}
        </div>
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
