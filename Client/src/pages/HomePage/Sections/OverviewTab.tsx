import { useMemo } from "react";
import { usePipeline, useConversations, useConversationsWithLastMessage } from "@/features/pipeline/hooks";
import type { ConversationWithLastMessage } from "@/features/pipeline/api";
import { format } from "date-fns";
import { Bot, MessageSquare, AlertTriangle, Users, TrendingUp } from "lucide-react";

// ── KPI derivation hook ───────────────────────────────────────────────────

function useOverviewKPIs() {
  const { data: pipeline } = usePipeline();
  const { data: conversations } = useConversations();
  const { data: convWithMsg } = useConversationsWithLastMessage();

  return useMemo(() => {
    const now = Date.now();
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

    // Total leads
    const totalLeads = pipeline?.length ?? 0;

    // New this week
    const newThisWeek = (pipeline ?? []).filter(
      (c) => c.created_at && new Date(c.created_at).getTime() >= weekAgo,
    ).length;

    // Awaiting reply: open conversations with last msg direction = inbound (no outbound after)
    const awaitingReply = (convWithMsg ?? []).filter((c) => c.has_pending_reply).length;

    // SLA breaches
    const slaBreaches = (pipeline ?? []).filter((c) => c.sla_breached).length;

    // Bot replies today: proxy via open convs not paused active today
    const today = new Date().toDateString();
    const botRepliesToday = (conversations ?? []).filter(
      (c) =>
        !c.bot_paused &&
        c.last_message_at &&
        new Date(c.last_message_at).toDateString() === today,
    ).length;

    return { totalLeads, newThisWeek, awaitingReply, slaBreaches, botRepliesToday };
  }, [pipeline, conversations, convWithMsg]);
}

// ── KPI Card ──────────────────────────────────────────────────────────────

interface KpiCardProps {
  label: string;
  value: number;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  accent?: "default" | "amber" | "rose" | "indigo" | "emerald";
}

function KpiCard({ label, value, icon: Icon, accent = "default" }: KpiCardProps) {
  const accentMap = {
    default: { iconBg: "rgba(99,102,241,0.15)", iconColor: "#818cf8", valColor: "#e2e8f0" },
    indigo: { iconBg: "rgba(99,102,241,0.15)", iconColor: "#818cf8", valColor: "#e2e8f0" },
    amber: { iconBg: "rgba(245,158,11,0.15)", iconColor: "#fbbf24", valColor: "#fbbf24" },
    rose: { iconBg: "rgba(244,63,94,0.15)", iconColor: "#fb7185", valColor: "#fb7185" },
    emerald: { iconBg: "rgba(16,185,129,0.15)", iconColor: "#34d399", valColor: "#34d399" },
  };
  const colors = accentMap[accent];

  return (
    <div
      className="flex flex-col gap-4 rounded-xl p-4"
      style={{
        backgroundColor: "#0f172a",
        border: "1px solid rgba(255,255,255,0.07)",
      }}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-widest" style={{ color: "#475569" }}>
          {label}
        </span>
        <span
          className="flex h-8 w-8 items-center justify-center rounded-lg"
          style={{ backgroundColor: colors.iconBg }}
        >
          <span style={{ color: colors.iconColor }}>
            <Icon size={15} className="shrink-0" />
          </span>
        </span>
      </div>
      <p
        className="text-3xl font-bold tabular-nums leading-none"
        style={{ color: colors.valColor }}
      >
        {value}
      </p>
    </div>
  );
}

// ── SVG Funnel ────────────────────────────────────────────────────────────

function SvgFunnel({ pipeline }: { pipeline: ReturnType<typeof usePipeline>["data"] }) {
  const stages = useMemo(() => {
    if (!pipeline) return [];
    const counts: Record<string, number> = {};
    pipeline.forEach((c) => {
      const s = c.derived_stage ?? c.pipeline_stage ?? "new_lead";
      counts[s] = (counts[s] ?? 0) + 1;
    });
    const ORDERED = ["new_lead", "docs_pending", "meeting_scheduled", "awaiting_approval", "completed"];
    const LABELS: Record<string, string> = {
      new_lead: "New Lead",
      docs_pending: "Docs",
      meeting_scheduled: "Meeting",
      awaiting_approval: "Approval",
      completed: "Completed",
    };
    return ORDERED.map((key) => ({ key, label: LABELS[key] ?? key, count: counts[key] ?? 0 }));
  }, [pipeline]);

  const max = Math.max(...stages.map((s) => s.count), 1);
  const W = 480;
  const H = 180;
  const slotH = H / stages.length;
  const minW = 80;

  const COLORS = ["#6366f1", "#818cf8", "#a5b4fc", "#c7d2fe", "#34d399"];

  return (
    <div
      className="overflow-hidden rounded-xl p-4"
      style={{ backgroundColor: "#0f172a", border: "1px solid rgba(255,255,255,0.07)" }}
    >
      <p className="mb-4 text-xs font-bold uppercase tracking-widest" style={{ color: "#475569" }}>
        Pipeline Funnel
      </p>
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          height={H}
          aria-label="Pipeline funnel chart"
          style={{ display: "block" }}
        >
          {stages.map((stage, i) => {
            const barW = minW + ((stage.count / max) * (W - minW - 120));
            const y = i * slotH + slotH * 0.15;
            const h = slotH * 0.7;
            const x = (W - 80 - barW) / 2;
            return (
              <g key={stage.key}>
                <rect
                  x={x}
                  y={y}
                  width={barW}
                  height={h}
                  rx={4}
                  fill={COLORS[i % COLORS.length]}
                  fillOpacity={0.8}
                />
                <text
                  x={x - 8}
                  y={y + h / 2 + 1}
                  textAnchor="end"
                  dominantBaseline="middle"
                  fontSize={10}
                  fill="#64748b"
                >
                  {stage.label}
                </text>
                <text
                  x={x + barW + 8}
                  y={y + h / 2 + 1}
                  textAnchor="start"
                  dominantBaseline="middle"
                  fontSize={11}
                  fontWeight={700}
                  fill="#e2e8f0"
                >
                  {stage.count}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

// ── Activity Timeline ─────────────────────────────────────────────────────

interface ActivityItemProps {
  conv: ConversationWithLastMessage;
}

function ActivityItem({ conv }: ActivityItemProps) {
  const name = conv.contact_name ?? conv.contact_phone ?? conv.whatsapp_chat_id;
  const isInbound = conv.last_message_direction === "inbound";
  const dotColor = conv.has_pending_reply ? "#fb7185" : isInbound ? "#818cf8" : "#34d399";

  return (
    <div className="flex items-start gap-3 py-2.5" style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
      <span
        className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: dotColor }}
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold" style={{ color: "#cbd5e1" }} dir="auto">
          {name}
        </p>
        <p className="truncate text-xs" style={{ color: "#475569" }} dir="auto">
          {conv.last_message_body ?? "—"}
        </p>
      </div>
      <span className="shrink-0 text-[10px] tabular-nums" style={{ color: "#334155" }}>
        {format(new Date(conv.last_message_at), "HH:mm")}
      </span>
    </div>
  );
}

function ActivityTimeline() {
  const { data: convs, isLoading } = useConversationsWithLastMessage();
  const recent = (convs ?? []).slice(0, 8);

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3 py-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3">
            <div className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-slate-700" />
            <div className="h-3 flex-1 animate-pulse rounded bg-slate-800" />
          </div>
        ))}
      </div>
    );
  }

  if (recent.length === 0) {
    return (
      <div className="py-8 text-center text-sm" style={{ color: "#334155" }}>
        No activity yet
      </div>
    );
  }

  return (
    <div>
      {recent.map((conv) => (
        <ActivityItem key={conv.id} conv={conv} />
      ))}
    </div>
  );
}

// ── Main Export ───────────────────────────────────────────────────────────

export function OverviewTab() {
  const kpis = useOverviewKPIs();
  const { data: pipeline } = usePipeline();

  return (
    <div className="mx-auto max-w-screen-2xl space-y-6 px-5 py-6">
      {/* KPI row */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <KpiCard label="Total Leads" value={kpis.totalLeads} icon={Users} accent="indigo" />
        <KpiCard label="New This Week" value={kpis.newThisWeek} icon={TrendingUp} accent="emerald" />
        <KpiCard label="Awaiting Reply" value={kpis.awaitingReply} icon={MessageSquare} accent={kpis.awaitingReply > 0 ? "rose" : "default"} />
        <KpiCard label="SLA Breaches" value={kpis.slaBreaches} icon={AlertTriangle} accent={kpis.slaBreaches > 0 ? "amber" : "default"} />
        <KpiCard label="Bot Active Today" value={kpis.botRepliesToday} icon={Bot} accent="indigo" />
      </div>

      {/* Funnel + Activity side by side */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SvgFunnel pipeline={pipeline} />

        {/* Recent activity */}
        <div
          className="rounded-xl p-4"
          style={{ backgroundColor: "#0f172a", border: "1px solid rgba(255,255,255,0.07)" }}
        >
          <p className="mb-3 text-xs font-bold uppercase tracking-widest" style={{ color: "#475569" }}>
            Recent Activity
          </p>
          <ActivityTimeline />
        </div>
      </div>
    </div>
  );
}
