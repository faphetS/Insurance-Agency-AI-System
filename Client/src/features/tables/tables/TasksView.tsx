import { memo, useMemo } from "react";
import { AlertCircle, CheckCircle2, Circle } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { tasks } from "@/lib/mockData";
import { clientById } from "../tableRegistry";
import type { Task, TaskStatus } from "@/types/domain";

const STATUS_CONFIG: Record<
  TaskStatus,
  { label: string; icon: typeof Circle; color: string; badgeVariant: "success" | "warning" | "default" }
> = {
  pending: {
    label: "Pending",
    icon: Circle,
    color: "text-stone-400",
    badgeVariant: "default",
  },
  done: {
    label: "Done",
    icon: CheckCircle2,
    color: "text-emerald-500",
    badgeVariant: "success",
  },
  overdue: {
    label: "Overdue",
    icon: AlertCircle,
    color: "text-rose-500",
    badgeVariant: "warning",
  },
};

const STATUS_ORDER: TaskStatus[] = ["overdue", "pending", "done"];

function formatDue(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  });
}

interface TaskCardProps {
  task: Task;
  onClick: () => void;
}

const TaskCard = memo(function TaskCard({ task, onClick }: TaskCardProps) {
  const { icon: StatusIcon, color, badgeVariant } = STATUS_CONFIG[task.status];
  const client = clientById.get(task.client_id);

  return (
    <Card onClick={onClick}>
      <div className="flex items-start gap-2.5">
        <StatusIcon size={15} className={`mt-0.5 shrink-0 ${color}`} />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] leading-snug text-stone-800">
            {task.description}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge variant={badgeVariant}>{task.status}</Badge>
            <Badge variant="default">{task.type.replace(/_/g, " ")}</Badge>
          </div>
          <div className="mt-2 flex items-center justify-between gap-2">
            <div className="flex flex-col gap-0.5">
              <span className="text-[11px] text-stone-400">
                {client?.full_name ?? task.client_id}
              </span>
              <span className="text-[11px] text-stone-400">
                {task.assigned_to}
              </span>
            </div>
            <div className="text-right">
              <span className="font-mono text-[11px] text-stone-400">
                Due {formatDue(task.due_at)}
              </span>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
});

interface KanbanColumnProps {
  status: TaskStatus;
  taskList: Task[];
  onRowClick: (row: Record<string, unknown>) => void;
}

const KanbanColumn = memo(function KanbanColumn({
  status,
  taskList,
  onRowClick,
}: KanbanColumnProps) {
  const { label, badgeVariant } = STATUS_CONFIG[status];

  return (
    <div className="flex flex-col gap-2">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[12px] font-semibold uppercase tracking-wider text-stone-500">
          {label}
        </span>
        <Badge variant={badgeVariant}>{taskList.length}</Badge>
      </div>
      {taskList.map((task) => (
        <TaskCard
          key={task.id}
          task={task}
          onClick={() => onRowClick(task as unknown as Record<string, unknown>)}
        />
      ))}
      {taskList.length === 0 && (
        <div className="rounded-lg border border-dashed border-stone-200 py-6 text-center text-[11px] text-stone-300">
          None
        </div>
      )}
    </div>
  );
});

interface TasksViewProps {
  onRowClick: (row: Record<string, unknown>) => void;
  searchQuery: string;
}

export const TasksView = memo(function TasksView({
  onRowClick,
  searchQuery,
}: TasksViewProps) {
  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return tasks;
    const q = searchQuery.toLowerCase();
    return tasks.filter(
      (t) =>
        t.description.toLowerCase().includes(q) ||
        t.assigned_to.toLowerCase().includes(q) ||
        t.type.includes(q),
    );
  }, [searchQuery]);

  const byStatus = useMemo(() => {
    const map: Record<TaskStatus, Task[]> = {
      overdue: [],
      pending: [],
      done: [],
    };
    for (const task of filtered) {
      map[task.status].push(task);
    }
    return map;
  }, [filtered]);

  return (
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
      {STATUS_ORDER.map((status) => (
        <KanbanColumn
          key={status}
          status={status}
          taskList={byStatus[status]}
          onRowClick={onRowClick}
        />
      ))}
    </div>
  );
});
