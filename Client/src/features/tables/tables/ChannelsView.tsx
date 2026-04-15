import { memo } from "react";
import { MessageCircle, Mail, CalendarDays, Landmark } from "lucide-react";
import { channels } from "@/lib/mockData";
import type { ChannelKind } from "@/types/domain";

const KIND_CONFIG: Record<
  ChannelKind,
  { icon: typeof MessageCircle; color: string; bg: string }
> = {
  whatsapp: {
    icon: MessageCircle,
    color: "text-emerald-600",
    bg: "bg-emerald-50",
  },
  email: { icon: Mail, color: "text-sky-600", bg: "bg-sky-50" },
  calendar: {
    icon: CalendarDays,
    color: "text-violet-600",
    bg: "bg-violet-50",
  },
  bafi: { icon: Landmark, color: "text-amber-600", bg: "bg-amber-50" },
};

function formatScanned(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface ChannelCardProps {
  channel: (typeof channels)[number];
  onClick: () => void;
}

const ChannelCard = memo(function ChannelCard({
  channel,
  onClick,
}: ChannelCardProps) {
  const { icon: Icon, color, bg } = KIND_CONFIG[channel.kind];
  const hasUnread = channel.unread_count > 0;

  return (
    <button
      onClick={onClick}
      className="group flex w-full items-center gap-4 rounded-xl border border-stone-200 bg-white px-5 py-4 text-left shadow-sm transition-all hover:border-orange-200 hover:shadow-md"
    >
      {/* Kind icon */}
      <div
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${bg}`}
      >
        <Icon size={18} className={color} />
      </div>
      {/* Info */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <span className="truncate text-[13px] font-semibold text-stone-900">
            {channel.label}
          </span>
          {/* Unread count — prominent */}
          {hasUnread ? (
            <span className="flex h-6 min-w-6 items-center justify-center rounded-full bg-orange-500 px-1.5 font-mono text-[11px] font-bold text-white shadow-sm">
              {channel.unread_count}
            </span>
          ) : (
            <span className="flex h-6 min-w-6 items-center justify-center rounded-full bg-stone-100 font-mono text-[11px] font-bold text-stone-400">
              0
            </span>
          )}
        </div>
        <span className="mt-0.5 block font-mono text-[11px] text-stone-400">
          {channel.identifier}
        </span>
        <span className="mt-1 block text-[10px] text-stone-300">
          Last scanned {formatScanned(channel.last_scanned_at)}
        </span>
      </div>
    </button>
  );
});

interface ChannelsViewProps {
  onRowClick: (row: Record<string, unknown>) => void;
  searchQuery: string;
}

export const ChannelsView = memo(function ChannelsView({
  onRowClick,
  searchQuery: _searchQuery,
}: ChannelsViewProps) {
  return (
    <div className="flex flex-col gap-2.5">
      {channels.map((channel) => (
        <ChannelCard
          key={channel.id}
          channel={channel}
          onClick={() =>
            onRowClick(channel as unknown as Record<string, unknown>)
          }
        />
      ))}
    </div>
  );
});
