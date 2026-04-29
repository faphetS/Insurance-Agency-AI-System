import { useState, useRef, useEffect } from "react";
import { Send, Bot, User, ExternalLink, Clock, CheckSquare } from "lucide-react";
import { Drawer } from "@/components/ui/Drawer";
import { Badge } from "@/components/ui/Badge";
import { useMessages, usePauseBotMutation, useClientTasks } from "@/features/pipeline/hooks";
import { toast } from "sonner";
import { sendManualMessage } from "@/features/pipeline/api";
import type { PipelineRow, ConversationRow, MessageRow } from "@/features/pipeline/types";
import { STAGE_LABELS } from "@/features/pipeline/types";
import { format, formatDistanceToNow } from "date-fns";

type Tab = "conversation" | "details" | "tasks";

interface ConversationDrawerProps {
  client: PipelineRow | null;
  conversation: ConversationRow | null;
  open: boolean;
  onClose: () => void;
  /** Display name override — used when client is null (contact came directly via WhatsApp) */
  contactName?: string | null;
  /** Phone override — used when client is null */
  contactPhone?: string | null;
}

// ── Message bubble ────────────────────────────────────────────────────────

function MessageBubble({ msg }: { msg: MessageRow }) {
  const isOutbound = msg.direction === "outbound";
  const isBot = msg.sent_by === "bot";

  return (
    <div className={`group flex ${isOutbound ? "justify-end" : "justify-start"}`}>
      <div
        className={`relative max-w-[75%] rounded-2xl px-4 py-2.5 text-sm ${
          isOutbound
            ? "rounded-br-sm bg-neutral-900 text-white"
            : "rounded-bl-sm bg-white text-neutral-800 shadow-sm ring-1 ring-neutral-200"
        }`}
      >
        {isBot && isOutbound && (
          <span className="mb-1 flex items-center gap-1 text-[10px] font-semibold text-neutral-400">
            <Bot size={10} />
            AI Reply
          </span>
        )}
        <p className="leading-relaxed">{msg.body ?? "(no text)"}</p>
        <span className={`mt-1 block text-right text-[10px] ${isOutbound ? "text-neutral-400" : "text-neutral-400"} opacity-0 group-hover:opacity-100 transition-opacity`}>
          {format(new Date(msg.created_at), "HH:mm")}
        </span>
      </div>
    </div>
  );
}

// ── Conversation Tab ──────────────────────────────────────────────────────

function ConversationTab({
  conversation,
}: {
  conversation: ConversationRow;
  client: PipelineRow;
}) {
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
      // Pause bot and send
      pauseBot({ conversationId: conversation.id, paused: true });
      await sendManualMessage({
        chatId: conversation.whatsapp_chat_id,
        message: msg,
      });
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
        <div className="mb-3 flex items-center justify-between rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
          <span>
              Bot is paused for this chat
              {conversation.bot_paused_until && (
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
          <div className="flex items-center justify-center py-12 text-neutral-400 text-sm">Loading messages…</div>
        ) : messages && messages.length > 0 ? (
          <div className="flex flex-col gap-2 pb-4">
            {(messages as MessageRow[]).map((msg) => (
              <MessageBubble key={msg.id} msg={msg} />
            ))}
            <div ref={bottomRef} />
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-neutral-400">
            <User size={28} />
            <p className="text-sm">No messages yet</p>
          </div>
        )}
      </div>

      <div className="mt-3 border-t border-neutral-100 pt-3">
        <div className="flex gap-2">
          <textarea
            rows={2}
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Reply as human (⏎ to send, Shift+⏎ for newline)…"
            className="flex-1 resize-none rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-800 outline-none focus:border-neutral-400 focus:bg-white"
          />
          <button
            onClick={() => void handleSend()}
            disabled={!reply.trim() || sending}
            className="flex h-full items-center justify-center rounded-xl bg-neutral-900 px-3 text-white hover:bg-neutral-700 disabled:opacity-40"
          >
            <Send size={16} />
          </button>
        </div>
        <p className="mt-1.5 text-[11px] text-neutral-400">Sending a manual reply will pause the AI bot for this chat.</p>
      </div>
    </div>
  );
}

// ── Details Tab ───────────────────────────────────────────────────────────

function DetailsTab({ client }: { client: PipelineRow }) {
  const field = (label: string, value: string | null | undefined) => (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">{label}</span>
      <span className="text-sm text-neutral-800">{value ?? "—"}</span>
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
      {field("Last service date", client.last_service_date ? format(new Date(client.last_service_date), "dd MMM yyyy") : null)}
      {field("Notes", client.notes)}
      {client.phone && (
        <a
          href={`https://wa.me/${client.phone.replace(/\D/g, "")}`}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2 rounded-xl bg-emerald-50 px-4 py-2.5 text-sm font-semibold text-emerald-700 hover:bg-emerald-100"
        >
          <ExternalLink size={14} />
          Open in WhatsApp
        </a>
      )}
    </div>
  );
}

// ── Tasks Tab ─────────────────────────────────────────────────────────────

function TasksTab({ clientId }: { clientId: string }) {
  const { data: tasks, isLoading } = useClientTasks(clientId);

  if (isLoading) return <p className="text-sm text-neutral-400">Loading tasks…</p>;

  if (!tasks || tasks.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-10 text-neutral-400">
        <CheckSquare size={28} />
        <p className="text-sm">No open tasks</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {tasks.map((task) => (
        <div key={task.id} className="rounded-xl border border-neutral-200 bg-neutral-50 p-3">
          <p className="text-sm font-medium text-neutral-800">{task.description}</p>
          <div className="mt-1.5 flex items-center gap-2 text-xs text-neutral-500">
            <Clock size={11} />
            <span>Due {formatDistanceToNow(new Date(task.due_at), { addSuffix: true })}</span>
            <span className="ml-auto rounded-full bg-neutral-200 px-2 py-0.5 text-[10px] font-medium uppercase">{task.type}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────

export function ConversationDrawer({
  client,
  conversation,
  open,
  onClose,
  contactName,
  contactPhone,
}: ConversationDrawerProps) {
  const [activeTab, setActiveTab] = useState<Tab>("conversation");

  // Resolve display values — prefer client fields, fall back to conversation contact fields
  const displayName =
    client?.full_name ?? contactName ?? conversation?.contact_name ?? "Unknown";
  const displayPhone =
    client?.phone ?? contactPhone ?? conversation?.contact_phone ?? undefined;

  // Without a client, only show the conversation tab
  const hasClient = client !== null;
  const stage = hasClient
    ? ((client.derived_stage ?? client.pipeline_stage ?? "") as keyof typeof STAGE_LABELS)
    : null;
  const stageLabel = stage ? (STAGE_LABELS[stage] ?? stage) : null;

  const tabs: { key: Tab; label: string }[] = hasClient
    ? [
        { key: "conversation", label: "Conversation" },
        { key: "details", label: "Client Details" },
        { key: "tasks", label: "Tasks" },
      ]
    : [{ key: "conversation", label: "Conversation" }];

  // If the current activeTab is not available in the current tab list, reset to conversation
  const resolvedTab: Tab =
    tabs.some((t) => t.key === activeTab) ? activeTab : "conversation";

  if (!open) return null;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={displayName}
      subtitle={displayPhone}
    >
      <div className="mb-5 flex items-center gap-2 flex-wrap">
        {stageLabel && <Badge variant="info">{stageLabel}</Badge>}
        {hasClient && client.sla_breached && <Badge variant="warning">SLA Breached</Badge>}
        {conversation?.bot_paused && <Badge variant="warning">Bot Paused</Badge>}
        {displayPhone && (
          <a
            href={`https://wa.me/${displayPhone.replace(/\D/g, "")}`}
            target="_blank"
            rel="noreferrer"
            className="ml-auto flex items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-100"
          >
            <ExternalLink size={12} />
            WhatsApp
          </a>
        )}
      </div>

      {/* Tabs — only rendered when there's more than one */}
      {tabs.length > 1 && (
        <div className="mb-5 flex rounded-xl bg-neutral-100 p-1">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex-1 rounded-lg py-1.5 text-xs font-semibold transition-colors ${
                resolvedTab === tab.key
                  ? "bg-white text-neutral-900 shadow-sm"
                  : "text-neutral-500 hover:text-neutral-700"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}

      {/* Tab content */}
      <div className="min-h-0 flex-1">
        {resolvedTab === "conversation" ? (
          conversation ? (
            <ConversationTab
              conversation={conversation}
              client={client ?? ({ full_name: displayName, phone: displayPhone } as PipelineRow)}
            />
          ) : (
            <div className="flex flex-col items-center gap-2 py-10 text-neutral-400">
              <User size={28} />
              <p className="text-sm">No conversation found</p>
            </div>
          )
        ) : resolvedTab === "details" && hasClient ? (
          <DetailsTab client={client} />
        ) : hasClient && client.id ? (
          <TasksTab clientId={client.id} />
        ) : null}
      </div>
    </Drawer>
  );
}
