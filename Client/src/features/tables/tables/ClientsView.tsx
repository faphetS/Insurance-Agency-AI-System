import { memo, useMemo } from "react";
import { ShieldCheck, ShieldAlert, Mail, Phone } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { clients } from "@/lib/mockData";
import type { Client, ClientStatus, InquiryType } from "@/types/domain";

const STATUS_VARIANT: Record<ClientStatus, "success" | "info" | "default"> = {
  active: "success",
  new: "info",
  completed: "default",
};

const INQUIRY_LABELS: Record<InquiryType, string> = {
  life_insurance: "Life",
  health_insurance: "Health",
  pension: "Pension",
  property: "Property",
  vehicle: "Vehicle",
  other: "Other",
};

const INITIALS_COLORS = [
  "bg-amber-100 text-amber-700",
  "bg-sky-100 text-sky-700",
  "bg-emerald-100 text-emerald-700",
  "bg-violet-100 text-violet-700",
  "bg-rose-100 text-rose-700",
];

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

interface ClientCardProps {
  client: Client;
  colorIndex: number;
  onClick: () => void;
}

const ClientCard = memo(function ClientCard({
  client,
  colorIndex,
  onClick,
}: ClientCardProps) {
  const colorClass = INITIALS_COLORS[colorIndex % INITIALS_COLORS.length];

  return (
    <Card onClick={onClick}>
      <div className="flex items-start gap-3">
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[13px] font-bold ${colorClass}`}
        >
          {getInitials(client.full_name)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-[14px] font-semibold text-stone-900">
              {client.full_name}
            </span>
            <Badge variant={STATUS_VARIANT[client.status]}>
              {client.status}
            </Badge>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <Badge variant="default">
              {INQUIRY_LABELS[client.inquiry_type]}
            </Badge>
            {client.id_validated ? (
              <span className="flex items-center gap-1 text-[11px] font-medium text-emerald-600">
                <ShieldCheck size={11} />
                ID verified
              </span>
            ) : (
              <span className="flex items-center gap-1 text-[11px] font-medium text-amber-600">
                <ShieldAlert size={11} />
                ID pending
              </span>
            )}
          </div>
          <div className="mt-2.5 flex flex-col gap-1">
            <span className="flex items-center gap-1.5 font-mono text-[11px] text-stone-500">
              <Phone size={10} className="shrink-0" />
              {client.phone}
            </span>
            {client.email !== undefined && (
              <span className="flex items-center gap-1.5 font-mono text-[11px] text-stone-500">
                <Mail size={10} className="shrink-0" />
                {client.email}
              </span>
            )}
          </div>
          <div className="mt-2.5 flex items-center justify-between">
            <span className="text-[11px] text-stone-400">
              {client.assigned_to}
            </span>
            <span className="font-mono text-[10px] text-stone-300">
              {client.id}
            </span>
          </div>
        </div>
      </div>
    </Card>
  );
});

interface ClientsViewProps {
  onRowClick: (row: Record<string, unknown>) => void;
  searchQuery: string;
}

export const ClientsView = memo(function ClientsView({
  onRowClick,
  searchQuery,
}: ClientsViewProps) {
  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return clients;
    const q = searchQuery.toLowerCase();
    return clients.filter(
      (c) =>
        c.full_name.toLowerCase().includes(q) ||
        c.email?.toLowerCase().includes(q) ||
        c.phone.includes(q),
    );
  }, [searchQuery]);

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {filtered.map((client, idx) => (
        <ClientCard
          key={client.id}
          client={client}
          colorIndex={idx}
          onClick={() =>
            onRowClick(client as unknown as Record<string, unknown>)
          }
        />
      ))}
      {filtered.length === 0 && (
        <div className="col-span-full py-12 text-center text-sm text-stone-400">
          No clients match &ldquo;{searchQuery}&rdquo;
        </div>
      )}
    </div>
  );
});
