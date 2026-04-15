import {
  Users,
  CalendarDays,
  CheckSquare,
  Zap,
  Radio,
} from "lucide-react";
import type { ComponentType } from "react";
import type {
  Client,
  Meeting,
  Task,
  AutomationRule,
  Channel,
} from "@/types/domain";
import {
  clients,
  meetings,
  tasks,
  automationRules,
  channels,
} from "@/lib/mockData";

export type TableKey =
  | "clients"
  | "meetings"
  | "tasks"
  | "automationRules"
  | "channels";

export interface TableRegistryEntry {
  key: TableKey;
  label: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  data: readonly unknown[];
  rowCount: number;
}

export const TABLE_REGISTRY: readonly TableRegistryEntry[] = [
  {
    key: "clients",
    label: "Clients",
    icon: Users,
    data: clients as unknown[],
    rowCount: clients.length,
  },
  {
    key: "meetings",
    label: "Meetings",
    icon: CalendarDays,
    data: meetings as unknown[],
    rowCount: meetings.length,
  },
  {
    key: "tasks",
    label: "Tasks",
    icon: CheckSquare,
    data: tasks as unknown[],
    rowCount: tasks.length,
  },
  {
    key: "automationRules",
    label: "Automation Rules",
    icon: Zap,
    data: automationRules as unknown[],
    rowCount: automationRules.length,
  },
  {
    key: "channels",
    label: "Channels",
    icon: Radio,
    data: channels as unknown[],
    rowCount: channels.length,
  },
] as const;

export const TOTAL_ROWS = TABLE_REGISTRY.reduce(
  (sum, t) => sum + t.rowCount,
  0,
);

// Typed data accessors
export const typedData = {
  clients,
  meetings,
  tasks,
  automationRules,
  channels,
} satisfies {
  clients: Client[];
  meetings: Meeting[];
  tasks: Task[];
  automationRules: AutomationRule[];
  channels: Channel[];
};

// Index maps for O(1) FK lookups (js-index-maps rule)
export const clientById = new Map<string, Client>(
  clients.map((c) => [c.id, c]),
);
export const meetingById = new Map<string, Meeting>(
  meetings.map((m) => [m.id, m]),
);
export const taskById = new Map<string, Task>(tasks.map((t) => [t.id, t]));
