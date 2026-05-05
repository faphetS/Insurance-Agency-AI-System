import { useState, useRef, useEffect } from "react";
import { Send, Bot, User, ExternalLink, Clock, CheckSquare, X } from "lucide-react";
import { toast } from "sonner";
import { useMessages, usePauseBotMutation, useClientTasks } from "@/features/pipeline/hooks";
import { sendManualMessage } from "@/features/pipeline/api";
import type { PipelineRow, ConversationRow, MessageRow } from "@/features/pipeline/types";
import { STAGE_LABELS } from "@/features/pipeline/types";
import { format, formatDistanceToNow } from "date-fns";

type Tab = "conversation" | "details" | "tasks";

interface InlineConversationPanelProps {
  client: PipelineRow | null;
  conversation: ConversationRow | null;
  onClose: () => void;
  /** Display name override — used when client is null */
  contactName?: string | null;
  /** Phone override — used when client is null */
  contactPhone?: string | null;
}

// ── Message bubble (dark variant) ─────────────────────────────────────────

function MessageBubble({ msg }: { msg: MessageRow }) {
  const isOutbound = msg.direction === "outbound";
  const isBot = msg.sent_by === "bot";

  return (
    <div className={`group flex ${isOutbound ? "justify-end" : "justify-start"}`}>
      <div
        className="relative max-w-[78%] rounded-2xl px-4 py-2.5 text-sm"
        style={
          isOutbound
            ? { backgroundColor: "#4f46e5", color: "#ffffff", borderBottomRightRadius: 4 }
            : {
                backgroundColor: "#1e293b",
                color: "#cbd5e1",
                borderBottomLeftRadius: 4,
                border: "1px solid rgba(255,255,255,0.07)",
              }
        }
      >
        {isBot && isOutbound && (
          <span className="mb-1 flex items-center gap-1 text-[10px] font-semibold" style={{ color: "#a5b4fc" }}>
            <Bot size={10} />
            AI Reply
          </span>
        )}
        <p className="leading-relaxed" dir="auto">
          {msg.body ?? "(no text)"}
        </p>
        <span
          className="mt-1 block text-right text-[10px] opacity-0 transition-opacity group-hover:opacity-100"
          style={{ color: isOutbound ? "#a5b4fc" : "#475569" }}
        >
          {format(new Date(msg.created_at), "HH:mm")}
        </span>
      </div>
    </div>
  );
}

// ── Conversation body ─────────────────────────────────────────────────────

function ConversationBody({ conversation }: { conversation: ConversationRow }) {
  const { data: messages, isLoading } = useMessages(conversation.id);
  const { mutate: pauseBot } = usePauseBotMutation();
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async () => {
    if (!reply.trim() || sending) return;
    const msg = reply.trim();
    setReply("");
    setSending(true);
    try {
      pauseBot({ conversationId: conversation.id, paused: true });
      await sendManualMessage({ chatId: conversation.whatsapp_chat_id, message: msg });
    } catch (err) {
      toast.error("Failed to send message", {
        description: err instanceof Error ? err.message : "Check the backend URL / login",
      });
      setReply(msg);
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  return (
    <div className="flex h-full flex-col">
      {conversation.bot_paused && (
        <div
          className="mb-3 flex items-center justify-between rounded-lg px-3 py-2 text-xs"
          style={{ backgroundColor: "rgba(245,158,11,0.1)", color: "#fbbf24" }}
        >
          <span>
              Bot is paused for this chat
              {conversation.bot_paused_until && new Date(conversation.bot_paused_until) > new Date() && (
                <> · resumes {formatDistanceToNow(new Date(conversation.bot_paused_until), { addSuffix: true })}</>
              )}
            </span>
          <button
            onClick={() => pauseBot({ conversationId: conversation.id, paused: false })}
            className="font-semibold underline"
          >
            Resume bot
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-12 text-sm" style={{ color: "#475569" }}>
            Loading messages…
          </div>
        ) : messages && messages.length > 0 ? (
          <div className="flex flex-col gap-2 pb-4">
            {(messages as MessageRow[]).map((msg) => (
              <MessageBubble key={msg.id} msg={msg} />
            ))}
            <div ref={bottomRef} />
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 py-12" style={{ color: "#475569" }}>
            <User size={28} />
            <p className="text-sm">No messages yet</p>
          </div>
        )}
      </div>

      <div className="mt-3 pt-3" style={{ borderTop: "1px solid rgba(255,255,255,0.07)" }}>
        <div className="flex gap-2">
          <textarea
            rows={2}
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Reply as human (Enter to send)…"
            className="flex-1 resize-none rounded-xl px-3 py-2 text-sm outline-none"
            style={{
              backgroundColor: "#0f172a",
              border: "1px solid rgba(255,255,255,0.1)",
              color: "#e2e8f0",
            }}
          />
          <button
            onClick={() => void handleSend()}
            disabled={!reply.trim() || sending}
            className="flex items-center justify-center rounded-xl px-3"
            style={{ backgroundColor: "#6366f1", color: "#fff" }}
          >
            <Send size={16} />
          </button>
        </div>
        <p className="mt-1.5 text-[11px]" style={{ color: "#334155" }}>
          Sending a manual reply will pause the AI bot for this chat.
        </p>
      </div>
    </div>
  );
}

// ── Details panel ─────────────────────────────────────────────────────────

function DetailsPanel({ client }: { client: PipelineRow }) {
  const field = (label: string, value: string | null | undefined) => (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "#475569" }}>
        {label}
      </span>
      <span className="text-sm" style={{ color: "#94a3b8" }}>
        {value ?? "—"}
      </span>
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      {field("Full name", client.full_name)}
      {field("Phone", client.phone)}
      {field("Email", client.email)}
      {field("Inquiry type", client.inquiry_type)}
      {field("Source channel", client.source_channel)}
      {field("Status", client.status)}
      {field("ID validated", client.id_validated ? "Yes" : "No")}
      {field(
        "Last service date",
        client.last_service_date ? format(new Date(client.last_service_date), "dd MMM yyyy") : null,
      )}
      {field("Notes", client.notes)}
      {client.phone && (
        <a
          href={`https://wa.me/${client.phone.replace(/\D/g, "")}`}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold"
          style={{ backgroundColor: "rgba(16,185,129,0.12)", color: "#34d399" }}
        >
          <ExternalLink size={14} />
          Open in WhatsApp
        </a>
      )}
    </div>
  );
}

// ── Tasks panel ───────────────────────────────────────────────────────────

function TasksPanel({ clientId }: { clientId: string }) {
  const { data: tasks, isLoading } = useClientTasks(clientId);

  if (isLoading) return <p className="text-sm" style={{ color: "#475569" }}>Loading tasks…</p>;

  if (!tasks || tasks.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-10" style={{ color: "#334155" }}>
        <CheckSquare size={28} />
        <p className="text-sm">No open tasks</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {tasks.map((task) => (
        <div
          key={task.id}
          className="rounded-xl p-3"
          style={{ backgroundColor: "#0f172a", border: "1px solid rgba(255,255,255,0.07)" }}
        >
          <p className="text-sm font-medium" style={{ color: "#cbd5e1" }}>
            {task.description}
          </p>
          <div className="mt-1.5 flex items-center gap-2 text-xs" style={{ color: "#475569" }}>
            <Clock size={11} />
            <span>Due {formatDistanceToNow(new Date(task.due_at), { addSuffix: true })}</span>
            <span
              className="ml-auto rounded-full px-2 py-0.5 text-[10px] font-medium uppercase"
              style={{ backgroundColor: "rgba(255,255,255,0.07)" }}
            >
              {task.type}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Main Export ───────────────────────────────────────────────────────────

export function InlineConversationPanel({
  client,
  conversation,
  onClose,
  contactName,
  contactPhone,
}: InlineConversationPanelProps) {
  const [activeTab, setActiveTab] = useState<Tab>("conversation");

  const displayName = client?.full_name ?? contactName ?? conversation?.contact_name ?? "Unknown";
  const displayPhone = client?.phone ?? contactPhone ?? conversation?.contact_phone ?? undefined;

  const hasClient = client !== null;
  const stage = hasClient
    ? ((client.derived_stage ?? client.pipeline_stage ?? "") as keyof typeof STAGE_LABELS)
    : null;
  const stageLabel = stage ? (STAGE_LABELS[stage] ?? stage) : null;

  const tabs: { key: Tab; label: string }[] = hasClient
    ? [
        { key: "conversation", label: "Chat" },
        { key: "details", label: "Details" },
        { key: "tasks", label: "Tasks" },
      ]
    : [{ key: "conversation", label: "Chat" }];

  const resolvedTab: Tab = tabs.some((t) => t.key === activeTab) ? activeTab : "conversation";

  return (
    <div
      className="flex h-full flex-col"
      style={{ backgroundColor: "#0f172a", borderLeft: "1px solid rgba(255,255,255,0.07)" }}
    >
      {/* Panel header */}
      <div
        className="flex items-center gap-3 px-4 py-3"
        style={{ borderBottom: "1px solid rgba(255,255,255,0.07)" }}
      >
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold" style={{ color: "#e2e8f0" }} dir="auto">
            {displayName}
          </p>
          {displayPhone && (
            <p className="font-mono text-[11px]" style={{ color: "#475569" }}>
              {displayPhone}
            </p>
          )}
        </div>

        {/* Badges */}
        <div className="flex shrink-0 items-center gap-1.5">
          {stageLabel && (
            <span
              className="rounded-full px-2 py-0.5 text-[10px] font-semibold"
              style={{ backgroundColor: "rgba(99,102,241,0.2)", color: "#a5b4fc" }}
            >
              {stageLabel}
            </span>
          )}
          {hasClient && client.sla_breached && (
            <span
              className="rounded-full px-2 py-0.5 text-[10px] font-semibold"
              style={{ backgroundColor: "rgba(245,158,11,0.15)", color: "#fbbf24" }}
            >
              SLA
            </span>
          )}
          {conversation?.bot_paused && (
            <span
              className="rounded-full px-2 py-0.5 text-[10px] font-semibold"
              style={{ backgroundColor: "rgba(245,158,11,0.15)", color: "#fbbf24" }}
            >
              Paused
            </span>
          )}
        </div>

        {displayPhone && (
          <a
            href={`https://wa.me/${displayPhone.replace(/\D/g, "")}`}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold"
            style={{ backgroundColor: "rgba(16,185,129,0.12)", color: "#34d399" }}
          >
            <ExternalLink size={11} />
            <span className="hidden sm:inline">WA</span>
          </a>
        )}

        <button
          onClick={onClose}
          className="flex h-7 w-7 items-center justify-center rounded-lg transition-colors"
          style={{ color: "#475569" }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "#94a3b8")}
          onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "#475569")}
          aria-label="Close panel"
        >
          <X size={15} />
        </button>
      </div>

      {/* Tab bar */}
      {tabs.length > 1 && (
        <div
          className="flex px-4 py-2"
          style={{ borderBottom: "1px solid rgba(255,255,255,0.07)" }}
        >
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className="rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors"
              style={
                resolvedTab === tab.key
                  ? { backgroundColor: "rgba(99,102,241,0.2)", color: "#a5b4fc" }
                  : { color: "#475569" }
              }
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}

      {/* Tab content */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {resolvedTab === "conversation" ? (
          conversation ? (
            <ConversationBody conversation={conversation} />
          ) : (
            <div className="flex flex-col items-center gap-2 py-10" style={{ color: "#334155" }}>
              <User size={28} />
              <p className="text-sm">No conversation found</p>
            </div>
          )
        ) : resolvedTab === "details" && hasClient ? (
          <DetailsPanel client={client} />
        ) : hasClient && client.id ? (
          <TasksPanel clientId={client.id} />
        ) : null}
      </div>
    </div>
  );
}
