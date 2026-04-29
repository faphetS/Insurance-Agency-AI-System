import { useState, useMemo, useCallback } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AlertCircle, ChevronDown, ChevronRight, ListChecks } from "lucide-react";
import { usePipeline, useUpdateClientStage, useConversations } from "@/features/pipeline/hooks";
import { ConversationDrawer } from "./ConversationDrawer";
import type { PipelineRow, PipelineStage, ConversationRow } from "@/features/pipeline/types";
import {
  PIPELINE_STAGES,
  STAGE_LABELS,
  STAGE_COLORS,
  STAGE_STRIPE,
} from "@/features/pipeline/types";

// ── Intake slot maps ──────────────────────────────────────────────────────

type IntakeSlot = "full_name" | "email" | "inquiry_type" | "id_photo" | "poa" | "done";

const SLOT_INDEX: Record<IntakeSlot, number> = {
  full_name: 1,
  email: 2,
  inquiry_type: 3,
  id_photo: 4,
  poa: 5,
  done: 0,
};

const SLOT_LABEL: Record<IntakeSlot, string> = {
  full_name: "name",
  email: "email",
  inquiry_type: "inquiry",
  id_photo: "ID photo",
  poa: "POA doc",
  done: "",
};

// ── Intake chip ───────────────────────────────────────────────────────────

function IntakeChip({ client }: { client: PipelineRow }) {
  const row = client as any;
  const state: string | null = row.intake_state ?? null;
  const slot: IntakeSlot | null = row.intake_current_slot ?? null;

  if (state !== "collecting" || !slot || slot === "done") return null;

  const n = SLOT_INDEX[slot];
  const label = SLOT_LABEL[slot];

  return (
    <span
      className="mt-1.5 inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-300"
      style={{
        background: "rgba(99,102,241,0.12)",
        borderColor: "rgba(99,102,241,0.3)",
      }}
    >
      <ListChecks size={10} className="shrink-0" />
      INTAKE {n}/5 · {label}
    </span>
  );
}

// ── Time-in-stage chip ────────────────────────────────────────────────────

function TimeChip({ hours }: { hours: number | null }) {
  if (hours === null) return null;
  const display =
    hours < 1 ? `<1h`
    : hours < 24 ? `${Math.round(hours)}h`
    : `${Math.round(hours / 24)}d`;
  return (
    <span
      className="rounded-md px-1.5 py-0.5 text-[10px] font-semibold tabular-nums"
      style={{ backgroundColor: "rgba(255,255,255,0.07)", color: "#64748b" }}
    >
      {display}
    </span>
  );
}

// ── Avatar initial ────────────────────────────────────────────────────────

const AVATAR_COLORS = [
  "bg-sky-100 text-sky-700",
  "bg-violet-100 text-violet-700",
  "bg-amber-100 text-amber-700",
  "bg-emerald-100 text-emerald-700",
  "bg-rose-100 text-rose-700",
  "bg-teal-100 text-teal-700",
];

function AvatarChip({ name }: { name: string | null }) {
  if (!name) return null;
  const initial = name.charAt(0).toUpperCase();
  const colorClass = AVATAR_COLORS[name.charCodeAt(0) % AVATAR_COLORS.length];
  return (
    <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold ${colorClass}`}>
      {initial}
    </span>
  );
}

// ── Client Card ───────────────────────────────────────────────────────────

interface ClientCardProps {
  client: PipelineRow;
  stage: PipelineStage;
  overlay?: boolean;
  onClick: () => void;
}

function ClientCard({ client, stage, overlay = false, onClick }: ClientCardProps) {
  const stripeColor = STAGE_STRIPE[stage];

  return (
    <div
      onClick={onClick}
      className={`group cursor-pointer rounded-xl border-l-[3px] px-3 py-3 shadow-sm transition-all ${stripeColor} ${overlay ? "rotate-1 shadow-xl ring-2 ring-slate-400/20" : ""}`}
      style={{
        backgroundColor: "#1e293b",
        borderTopColor: "rgba(255,255,255,0.07)",
        borderRightColor: "rgba(255,255,255,0.07)",
        borderBottomColor: "rgba(255,255,255,0.07)",
        borderTopWidth: 1,
        borderRightWidth: 1,
        borderBottomWidth: 1,
        borderLeftWidth: 3,
        borderStyle: "solid",
      }}
    >
      <div className="mb-1.5 flex items-start justify-between gap-2">
        <p className="text-sm font-semibold leading-tight" style={{ color: "#e2e8f0" }}>
          {client.full_name ?? "Unknown"}
        </p>
        {client.sla_breached && (
          <AlertCircle size={14} className="mt-0.5 shrink-0 text-rose-500" />
        )}
      </div>
      <p className="mb-2 truncate text-xs" style={{ color: "#475569" }}>{client.inquiry_type ?? ""}</p>
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col items-start">
          <TimeChip hours={client.time_in_stage_hours} />
          <IntakeChip client={client} />
        </div>
        <div className="flex items-center gap-1.5">
          {client.open_tasks_count != null && client.open_tasks_count > 0 && (
            <span className="rounded-md bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-amber-700">
              {client.open_tasks_count} task{client.open_tasks_count > 1 ? "s" : ""}
            </span>
          )}
          <AvatarChip name={client.assigned_to} />
        </div>
      </div>
    </div>
  );
}

// ── Sortable Card (dnd-kit wrapper) ───────────────────────────────────────

function SortableClientCard({
  client,
  stage,
  onClick,
}: {
  client: PipelineRow;
  stage: PipelineStage;
  onClick: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: client.id ?? "",
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <ClientCard client={client} stage={stage} onClick={onClick} />
    </div>
  );
}

// ── Kanban Column ─────────────────────────────────────────────────────────

interface KanbanColumnProps {
  stage: PipelineStage;
  clients: PipelineRow[];
  onCardClick: (client: PipelineRow) => void;
  isCollapsed?: boolean;
  onToggle?: () => void;
  isMobile?: boolean;
}

function KanbanColumn({ stage, clients, onCardClick, isCollapsed, onToggle, isMobile }: KanbanColumnProps) {
  const borderColor = STAGE_COLORS[stage];
  const ids = clients.map((c) => c.id ?? "");

  if (isMobile) {
    return (
      <div
        className="rounded-2xl shadow-sm"
        style={{ backgroundColor: "#0f172a", border: "1px solid rgba(255,255,255,0.07)" }}
      >
        <button
          onClick={onToggle}
          className="flex w-full items-center gap-3 px-4 py-3"
        >
          <div className={`h-3 w-1.5 rounded-full border-l-4 ${borderColor.replace("border-t-", "border-l-")}`} />
          <span className="flex-1 text-left text-sm font-semibold" style={{ color: "#e2e8f0" }}>
            {STAGE_LABELS[stage]}
          </span>
          <span
            className="flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-bold tabular-nums"
            style={{ backgroundColor: "rgba(255,255,255,0.07)", color: "#94a3b8" }}
          >
            {clients.length}
          </span>
          {isCollapsed ? <ChevronRight size={14} className="text-neutral-400" /> : <ChevronDown size={14} className="text-neutral-400" />}
        </button>
        {!isCollapsed && clients.length > 0 && (
          <div className="flex flex-col gap-2 px-3 pb-3">
            <SortableContext items={ids} strategy={verticalListSortingStrategy}>
              {clients.map((c) => (
                <SortableClientCard key={c.id} client={c} stage={stage} onClick={() => onCardClick(c)} />
              ))}
            </SortableContext>
          </div>
        )}
        {!isCollapsed && clients.length === 0 && (
          <p className="px-4 pb-3 text-xs" style={{ color: "#334155" }}>No clients</p>
        )}
      </div>
    );
  }

  return (
    <div
      className={`flex w-56 shrink-0 flex-col rounded-2xl border-t-4 ${borderColor}`}
      style={{
        backgroundColor: "#0f172a",
        borderLeftColor: "rgba(255,255,255,0.07)",
        borderRightColor: "rgba(255,255,255,0.07)",
        borderBottomColor: "rgba(255,255,255,0.07)",
        borderLeftWidth: 1,
        borderRightWidth: 1,
        borderBottomWidth: 1,
        borderTopWidth: 4,
        borderStyle: "solid",
      }}
    >
      {/* Column header */}
      <div className="flex items-center justify-between px-3 py-3">
        <span className="text-xs font-bold uppercase tracking-wide" style={{ color: "#475569" }}>
          {STAGE_LABELS[stage]}
        </span>
        <div className="flex items-center gap-1.5">
          {stage === "new_lead" && (() => {
            const inIntake = clients.filter((c) => (c as any).intake_state === "collecting").length;
            return inIntake > 0 ? (
              <span className="text-[10px] tabular-nums text-slate-500">({inIntake} in intake)</span>
            ) : null;
          })()}
          <span
            className="flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-bold tabular-nums"
            style={{ backgroundColor: "rgba(255,255,255,0.07)", color: "#94a3b8" }}
          >
            {clients.length}
          </span>
        </div>
      </div>

      {/* Cards */}
      <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-2 pb-3">
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {clients.length === 0 ? (
            <p className="py-4 text-center text-xs" style={{ color: "#334155" }}>Empty</p>
          ) : (
            clients.map((c) => (
              <SortableClientCard key={c.id} client={c} stage={stage} onClick={() => onCardClick(c)} />
            ))
          )}
        </SortableContext>
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────

export function PipelineKanbanSection() {
  const { data: pipeline, isLoading, error } = usePipeline();
  const { data: conversations } = useConversations();
  const { mutate: moveStage } = useUpdateClientStage();

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [selectedClient, setSelectedClient] = useState<PipelineRow | null>(null);
  const [collapsedStages, setCollapsedStages] = useState<Set<PipelineStage>>(new Set());

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  // Build a map: clientId → conversation
  const convMap = useMemo(() => {
    const m = new Map<string, ConversationRow>();
    (conversations ?? []).forEach((c) => {
      if (c.client_id) m.set(c.client_id, c);
    });
    return m;
  }, [conversations]);

  // Group by stage
  const stageMap = useMemo(() => {
    const map = new Map<PipelineStage, PipelineRow[]>();
    PIPELINE_STAGES.forEach((s) => map.set(s, []));
    (pipeline ?? []).forEach((client) => {
      const stage = (client.derived_stage ?? client.pipeline_stage ?? "new_lead") as PipelineStage;
      const key = PIPELINE_STAGES.includes(stage) ? stage : "new_lead";
      map.get(key)!.push(client);
    });
    return map;
  }, [pipeline]);

  const draggingClient = useMemo(
    () => (draggingId ? (pipeline ?? []).find((c) => c.id === draggingId) ?? null : null),
    [draggingId, pipeline],
  );

  const handleDragStart = useCallback((e: DragStartEvent) => {
    setDraggingId(e.active.id as string);
  }, []);

  const handleDragEnd = useCallback(
    (e: DragEndEvent) => {
      setDraggingId(null);
      const { active, over } = e;
      if (!over || active.id === over.id) return;

      // Determine target stage from over.id (could be a column id = stage string)
      const targetStage = over.id as PipelineStage;
      if (!PIPELINE_STAGES.includes(targetStage)) return;

      const clientId = active.id as string;
      moveStage({ clientId, stage: targetStage });
    },
    [moveStage],
  );

  const toggleStage = useCallback((stage: PipelineStage) => {
    setCollapsedStages((prev) => {
      const next = new Set(prev);
      if (next.has(stage)) next.delete(stage);
      else next.add(stage);
      return next;
    });
  }, []);

  const selectedConversation = selectedClient?.id ? (convMap.get(selectedClient.id) ?? null) : null;

  if (error) {
    return (
      <div
        className="flex items-center justify-center rounded-2xl py-12"
        style={{
          backgroundColor: "rgba(244,63,94,0.1)",
          border: "1px solid rgba(244,63,94,0.2)",
        }}
      >
        <p className="text-sm" style={{ color: "#fb7185" }}>Failed to load pipeline. Check Supabase connection.</p>
      </div>
    );
  }

  return (
    <>
      {/* Desktop kanban — horizontal scroll */}
      <div className="hidden md:block">
        <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
          <div className="flex gap-3 overflow-x-auto pb-4" style={{ minHeight: 480 }}>
            {isLoading
              ? Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="h-80 w-56 shrink-0 animate-pulse rounded-2xl bg-slate-800" />
                ))
              : PIPELINE_STAGES.map((stage) => (
                  <KanbanColumn
                    key={stage}
                    stage={stage}
                    clients={stageMap.get(stage) ?? []}
                    onCardClick={setSelectedClient}
                  />
                ))}
          </div>

          <DragOverlay>
            {draggingClient ? (
              <ClientCard
                client={draggingClient}
                stage={(draggingClient.derived_stage ?? draggingClient.pipeline_stage ?? "new_lead") as PipelineStage}
                overlay
                onClick={() => {}}
              />
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>

      {/* Mobile accordion */}
      <div className="flex flex-col gap-2 md:hidden">
        {PIPELINE_STAGES.map((stage) => (
          <KanbanColumn
            key={stage}
            stage={stage}
            clients={stageMap.get(stage) ?? []}
            onCardClick={setSelectedClient}
            isMobile
            isCollapsed={collapsedStages.has(stage)}
            onToggle={() => toggleStage(stage)}
          />
        ))}
      </div>

      {/* Drawer */}
      <ConversationDrawer
        client={selectedClient}
        conversation={selectedConversation}
        open={selectedClient !== null}
        onClose={() => setSelectedClient(null)}
      />
    </>
  );
}
