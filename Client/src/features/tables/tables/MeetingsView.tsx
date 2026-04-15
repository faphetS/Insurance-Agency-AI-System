import { memo, useMemo } from "react";
import { Video, Phone, Users, CheckCircle2, Clock } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { meetings } from "@/lib/mockData";
import { clientById } from "../tableRegistry";
import type { Meeting, MeetingStatus, MeetingType, SummaryStatus } from "@/types/domain";

const TYPE_ICON: Record<MeetingType, typeof Video> = {
  zoom: Video,
  phone: Phone,
  in_person: Users,
};

const STATUS_VARIANT: Record<MeetingStatus, "success" | "info" | "warning"> = {
  done: "success",
  scheduled: "info",
  cancelled: "warning",
};

const SUMMARY_VARIANT: Record<SummaryStatus, "success" | "warning" | "info"> =
  {
    approved: "success",
    sent: "info",
    draft: "warning",
  };

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface MeetingRowProps {
  meeting: Meeting;
  index: number;
  onClick: () => void;
}

const MeetingRow = memo(function MeetingRow({
  meeting,
  index,
  onClick,
}: MeetingRowProps) {
  const TypeIcon = TYPE_ICON[meeting.type];
  const client = clientById.get(meeting.client_id);
  const isLast = index === meetings.length - 1;

  return (
    <div className="relative flex gap-4">
      {/* Timeline line */}
      {!isLast && (
        <div className="absolute left-[19px] top-8 h-full w-px bg-stone-200" />
      )}
      {/* Timeline dot */}
      <div
        className={`relative z-10 mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2 ${
          meeting.status === "done"
            ? "border-emerald-300 bg-emerald-50 text-emerald-600"
            : "border-orange-200 bg-orange-50 text-orange-500"
        }`}
      >
        <TypeIcon size={14} />
      </div>
      {/* Card */}
      <div className="mb-4 flex-1">
        <Card onClick={onClick}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-semibold text-stone-900">
                  {client?.full_name ?? meeting.client_id}
                </span>
                <Badge variant={STATUS_VARIANT[meeting.status]}>
                  {meeting.status}
                </Badge>
              </div>
              <div className="mt-1 flex items-center gap-3">
                <span className="flex items-center gap-1 font-mono text-[11px] text-stone-500">
                  <Clock size={10} />
                  {formatDate(meeting.scheduled_at)} · {formatTime(meeting.scheduled_at)}
                </span>
                <span className="font-mono text-[10px] text-stone-300">
                  {meeting.id}
                </span>
              </div>
              {meeting.summary_final !== undefined && (
                <p className="mt-2 line-clamp-2 text-[11px] leading-relaxed text-stone-500">
                  {meeting.summary_final}
                </p>
              )}
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1.5">
              <Badge variant={SUMMARY_VARIANT[meeting.summary_status]}>
                {meeting.summary_status}
              </Badge>
              {meeting.client_confirmed && (
                <span className="flex items-center gap-1 text-[10px] font-medium text-emerald-600">
                  <CheckCircle2 size={10} />
                  Confirmed
                </span>
              )}
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
});

interface MeetingsViewProps {
  onRowClick: (row: Record<string, unknown>) => void;
  searchQuery: string;
}

export const MeetingsView = memo(function MeetingsView({
  onRowClick,
  searchQuery,
}: MeetingsViewProps) {
  const sorted = useMemo(
    () =>
      [...meetings].sort(
        (a, b) =>
          new Date(b.scheduled_at).getTime() -
          new Date(a.scheduled_at).getTime(),
      ),
    [],
  );

  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return sorted;
    const q = searchQuery.toLowerCase();
    return sorted.filter((m) => {
      const client = clientById.get(m.client_id);
      return (
        m.id.toLowerCase().includes(q) ||
        m.type.includes(q) ||
        client?.full_name.toLowerCase().includes(q)
      );
    });
  }, [sorted, searchQuery]);

  return (
    <div className="flex flex-col">
      {filtered.map((meeting, idx) => (
        <MeetingRow
          key={meeting.id}
          meeting={meeting}
          index={idx}
          onClick={() =>
            onRowClick(meeting as unknown as Record<string, unknown>)
          }
        />
      ))}
      {filtered.length === 0 && (
        <div className="py-12 text-center text-sm text-stone-400">
          No meetings match &ldquo;{searchQuery}&rdquo;
        </div>
      )}
    </div>
  );
});
