import { useState, useCallback } from "react";
import { MessageSquare } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useConversationsWithLastMessage } from "@/features/pipeline/hooks";
import { Badge } from "@/components/ui/Badge";
import { ConversationDrawer } from "./ConversationDrawer";
import type { ConversationWithLastMessage } from "@/features/pipeline/api";
import type { ConversationRow } from "@/features/pipeline/types";

// ── Avatar initial circle ─────────────────────────────────────────────────

const AVATAR_PALETTE = [
  "bg-sky-100 text-sky-700",
  "bg-violet-100 text-violet-700",
  "bg-amber-100 text-amber-700",
  "bg-emerald-100 text-emerald-700",
  "bg-rose-100 text-rose-700",
  "bg-teal-100 text-teal-700",
];

function AvatarCircle({ name }: { name: string }) {
  const initial = name.charAt(0).toUpperCase();
  const colorClass = AVATAR_PALETTE[name.charCodeAt(0) % AVATAR_PALETTE.length];
  return (
    <span
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold ${colorClass}`}
    >
      {initial}
    </span>
  );
}

// ── Relative time chip ────────────────────────────────────────────────────

function RelativeTime({ iso }: { iso: string }) {
  const distance = formatDistanceToNow(new Date(iso), { addSuffix: false });
  // Shorten long strings: "about 2 hours" → "2h", "3 days" → "3d", "1 minute" → "1m"
  const shortened = distance
    .replace(/about /, "")
    .replace(/less than a minute/, "<1m")
    .replace(/(\d+) minutes?/, "$1m")
    .replace(/(\d+) hours?/, "$1h")
    .replace(/(\d+) days?/, "$1d")
    .replace(/(\d+) months?/, "$1mo")
    .replace(/(\d+) years?/, "$1y");

  return (
    <span className="shrink-0 rounded-md bg-neutral-100 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-neutral-500">
      {shortened}
    </span>
  );
}

// ── Row skeleton ──────────────────────────────────────────────────────────

function RowSkeleton() {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="h-9 w-9 shrink-0 animate-pulse rounded-full bg-neutral-100" />
      <div className="flex-1 space-y-1.5">
        <div className="h-3 w-28 animate-pulse rounded bg-neutral-100" />
        <div className="h-2.5 w-48 animate-pulse rounded bg-neutral-100" />
      </div>
    </div>
  );
}

// ── Conversation row ──────────────────────────────────────────────────────

interface ConvRowProps {
  conv: ConversationWithLastMessage;
  onClick: () => void;
}

function ConvRow({ conv, onClick }: ConvRowProps) {
  const displayName = conv.contact_name ?? conv.contact_phone ?? conv.whatsapp_chat_id;

  return (
    <button
      onClick={onClick}
      className="group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-neutral-50"
    >
      {/* Avatar */}
      <AvatarCircle name={displayName} />

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-semibold text-neutral-900 group-hover:text-neutral-700">
            {displayName}
          </p>
          {conv.has_pending_reply && (
            <span
              className="h-2 w-2 shrink-0 rounded-full bg-rose-500"
              title="Awaiting reply"
            />
          )}
        </div>
        <p className="truncate text-xs text-neutral-400">
          {conv.last_message_body ?? "No messages yet"}
        </p>
      </div>

      {/* Right-side meta */}
      <div className="flex shrink-0 flex-col items-end gap-1">
        <RelativeTime iso={conv.last_message_at} />
        {conv.bot_paused && (
          <Badge variant="warning" className="text-[9px]">
            {conv.bot_paused_until
              ? `Bot paused · resumes ${formatDistanceToNow(new Date(conv.bot_paused_until), { addSuffix: true })}`
              : "Bot paused"}
          </Badge>
        )}
      </div>
    </button>
  );
}

// ── Main export ───────────────────────────────────────────────────────────

export function ConversationsSection() {
  const { data: conversations, isLoading } = useConversationsWithLastMessage();

  const [selectedConv, setSelectedConv] = useState<ConversationWithLastMessage | null>(null);

  const handleRowClick = useCallback((conv: ConversationWithLastMessage) => {
    setSelectedConv(conv);
  }, []);

  const handleDrawerClose = useCallback(() => {
    setSelectedConv(null);
  }, []);

  // Cast the selected conversation to the ConversationRow shape expected by ConversationDrawer
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

  return (
    <>
      <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-neutral-100 px-4 py-3">
          <div className="flex items-center gap-2">
            <MessageSquare size={15} className="text-neutral-400" />
            <h2 className="text-sm font-bold text-neutral-800">Recent Conversations</h2>
          </div>
          {conversations && conversations.length > 0 && (
            <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-neutral-100 px-1.5 text-xs font-bold tabular-nums text-neutral-600">
              {conversations.length}
            </span>
          )}
        </div>

        {/* Body — scrollable */}
        <div className="max-h-[400px] overflow-y-auto">
          {isLoading ? (
            <div className="divide-y divide-neutral-50 px-1 py-1">
              {Array.from({ length: 5 }).map((_, i) => (
                <RowSkeleton key={i} />
              ))}
            </div>
          ) : !conversations || conversations.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-neutral-400">
              <MessageSquare size={28} strokeWidth={1.5} />
              <p className="text-center text-sm">
                No conversations yet.
                <br />
                Send a WhatsApp message to your linked number to start.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-neutral-50 px-1 py-1">
              {conversations.map((conv) => (
                <ConvRow
                  key={conv.id}
                  conv={conv}
                  onClick={() => handleRowClick(conv)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Drawer — opens with conversation context; no linked PipelineRow needed */}
      <ConversationDrawer
        client={null}
        conversation={drawerConversation}
        open={selectedConv !== null}
        onClose={handleDrawerClose}
        contactName={selectedConv?.contact_name}
        contactPhone={selectedConv?.contact_phone}
      />
    </>
  );
}
