import { useState, useCallback, useMemo } from "react";
import { MessageSquare } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useConversationsWithLastMessage, usePipeline } from "@/features/pipeline/hooks";
import { InlineConversationPanel } from "./InlineConversationPanel";
import type { ConversationWithLastMessage } from "@/features/pipeline/api";
import type { ConversationRow, PipelineRow } from "@/features/pipeline/types";

// ── Avatar ────────────────────────────────────────────────────────────────

const PALETTE = [
  { bg: "rgba(99,102,241,0.2)", color: "#818cf8" },
  { bg: "rgba(245,158,11,0.15)", color: "#fbbf24" },
  { bg: "rgba(16,185,129,0.15)", color: "#34d399" },
  { bg: "rgba(244,63,94,0.15)", color: "#fb7185" },
  { bg: "rgba(139,92,246,0.2)", color: "#c4b5fd" },
  { bg: "rgba(20,184,166,0.15)", color: "#2dd4bf" },
];

function Avatar({ name }: { name: string }) {
  const idx = name.charCodeAt(0) % PALETTE.length;
  const p = PALETTE[idx];
  return (
    <span
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold"
      style={{ backgroundColor: p.bg, color: p.color }}
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

// ── Time chip ─────────────────────────────────────────────────────────────

function TimeChip({ iso }: { iso: string }) {
  const distance = formatDistanceToNow(new Date(iso), { addSuffix: false })
    .replace(/about /, "")
    .replace(/less than a minute/, "<1m")
    .replace(/(\d+) minutes?/, "$1m")
    .replace(/(\d+) hours?/, "$1h")
    .replace(/(\d+) days?/, "$1d")
    .replace(/(\d+) months?/, "$1mo");
  return (
    <span
      className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold tabular-nums"
      style={{ backgroundColor: "rgba(255,255,255,0.06)", color: "#475569" }}
    >
      {distance}
    </span>
  );
}

// ── Row ───────────────────────────────────────────────────────────────────

interface RowProps {
  conv: ConversationWithLastMessage;
  isSelected: boolean;
  onClick: () => void;
}

function ConvRow({ conv, isSelected, onClick }: RowProps) {
  const name = conv.contact_name ?? conv.contact_phone ?? conv.whatsapp_chat_id;
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors"
      style={
        isSelected
          ? { backgroundColor: "rgba(99,102,241,0.12)", borderLeft: "2px solid #6366f1" }
          : { borderLeft: "2px solid transparent" }
      }
      onMouseEnter={(e) => {
        if (!isSelected) (e.currentTarget as HTMLButtonElement).style.backgroundColor = "rgba(255,255,255,0.03)";
      }}
      onMouseLeave={(e) => {
        if (!isSelected) (e.currentTarget as HTMLButtonElement).style.backgroundColor = "transparent";
      }}
    >
      <Avatar name={name} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p
            className="truncate text-sm font-semibold"
            style={{ color: isSelected ? "#a5b4fc" : "#cbd5e1" }}
            dir="auto"
          >
            {name}
          </p>
          {conv.has_pending_reply && (
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: "#fb7185" }} title="Awaiting reply" />
          )}
        </div>
        <p className="truncate text-xs" style={{ color: "#475569" }} dir="auto">
          {conv.last_message_body ?? "No messages yet"}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <TimeChip iso={conv.last_message_at} />
        {conv.bot_paused && (
          <span
            className="rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide"
            style={{ backgroundColor: "rgba(245,158,11,0.15)", color: "#fbbf24" }}
          >
            Paused
          </span>
        )}
      </div>
    </button>
  );
}

// ── Skeleton ──────────────────────────────────────────────────────────────

function Skeleton() {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <div className="h-9 w-9 shrink-0 animate-pulse rounded-full" style={{ backgroundColor: "#1e293b" }} />
      <div className="flex-1 space-y-1.5">
        <div className="h-3 w-28 animate-pulse rounded" style={{ backgroundColor: "#1e293b" }} />
        <div className="h-2.5 w-44 animate-pulse rounded" style={{ backgroundColor: "#1e293b" }} />
      </div>
    </div>
  );
}

// ── Main Export ───────────────────────────────────────────────────────────

export function ConversationsTab() {
  const { data: conversations, isLoading } = useConversationsWithLastMessage();
  const { data: pipeline } = usePipeline();
  const [selectedConv, setSelectedConv] = useState<ConversationWithLastMessage | null>(null);

  // Build map: client_id → PipelineRow for the panel
  const clientMap = useMemo(() => {
    const m = new Map<string, PipelineRow>();
    (pipeline ?? []).forEach((c) => {
      if (c.id) m.set(c.id, c);
    });
    return m;
  }, [pipeline]);

  const handleRowClick = useCallback((conv: ConversationWithLastMessage) => {
    setSelectedConv(conv);
  }, []);

  const handleClose = useCallback(() => {
    setSelectedConv(null);
  }, []);

  const drawerConversation: ConversationRow | null = selectedConv
    ? {
        id: selectedConv.id,
        contact_name: selectedConv.contact_name,
        contact_phone: selectedConv.contact_phone,
        whatsapp_chat_id: selectedConv.whatsapp_chat_id,
        bot_paused: selectedConv.bot_paused,
        bot_paused_until: selectedConv.bot_paused_until ?? null,
        status: selectedConv.status,
        last_message_at: selectedConv.last_message_at,
        client_id: selectedConv.client_id,
        created_at: selectedConv.created_at,
      }
    : null;

  const linkedClient = selectedConv?.client_id ? (clientMap.get(selectedConv.client_id) ?? null) : null;

  return (
    <div
      className="mx-auto flex max-w-screen-2xl"
      style={{ height: "calc(100vh - 108px)" }}
    >
      {/* Left list */}
      <div
        className="flex w-80 shrink-0 flex-col"
        style={{ borderRight: "1px solid rgba(255,255,255,0.07)" }}
      >
        <div
          className="flex items-center gap-2 px-4 py-3"
          style={{ borderBottom: "1px solid rgba(255,255,255,0.07)" }}
        >
          <MessageSquare size={14} style={{ color: "#6366f1" }} />
          <span className="text-xs font-bold uppercase tracking-widest" style={{ color: "#475569" }}>
            Conversations
          </span>
          {conversations && conversations.length > 0 && (
            <span
              className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[10px] font-bold tabular-nums"
              style={{ backgroundColor: "rgba(99,102,241,0.2)", color: "#818cf8" }}
            >
              {conversations.length}
            </span>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            Array.from({ length: 7 }).map((_, i) => <Skeleton key={i} />)
          ) : !conversations || conversations.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-16" style={{ color: "#334155" }}>
              <MessageSquare size={28} strokeWidth={1.5} />
              <p className="text-center text-sm">No conversations yet.</p>
            </div>
          ) : (
            conversations.map((conv) => (
              <ConvRow
                key={conv.id}
                conv={conv}
                isSelected={selectedConv?.id === conv.id}
                onClick={() => handleRowClick(conv)}
              />
            ))
          )}
        </div>
      </div>

      {/* Right inline panel */}
      <div className="min-w-0 flex-1">
        {selectedConv !== null && drawerConversation !== null ? (
          <InlineConversationPanel
            client={linkedClient}
            conversation={drawerConversation}
            onClose={handleClose}
            contactName={selectedConv.contact_name}
            contactPhone={selectedConv.contact_phone}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3" style={{ color: "#1e293b" }}>
            <MessageSquare size={40} strokeWidth={1} />
            <p className="text-sm">Select a conversation</p>
          </div>
        )}
      </div>
    </div>
  );
}
