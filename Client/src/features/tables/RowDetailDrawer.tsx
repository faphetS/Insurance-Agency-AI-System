import { memo, useCallback } from "react";
import { Drawer } from "@/components/ui/Drawer";
import type { TableKey } from "./tableRegistry";
import { clientById, meetingById, taskById } from "./tableRegistry";

interface FkChipProps {
  fieldKey: string;
  value: string;
  onNavigate: (tableKey: TableKey, rowId: string) => void;
}

const FK_MAP: Record<string, TableKey> = {
  client_id: "clients",
  meeting_id: "meetings",
  parent_task_id: "tasks",
};

const getFkLabel = (fieldKey: string, value: string): string => {
  if (fieldKey === "client_id") {
    const c = clientById.get(value);
    return c ? c.full_name : value;
  }
  if (fieldKey === "meeting_id") {
    const m = meetingById.get(value);
    return m ? `Meeting ${m.id}` : value;
  }
  if (fieldKey === "parent_task_id") {
    const t = taskById.get(value);
    return t ? `Task ${t.id}` : value;
  }
  return value;
};

const FkChip = memo(function FkChip({ fieldKey, value, onNavigate }: FkChipProps) {
  const tableKey = FK_MAP[fieldKey];
  const label = getFkLabel(fieldKey, value);
  const handleClick = useCallback(() => {
    onNavigate(tableKey, value);
  }, [tableKey, value, onNavigate]);

  return (
    <button
      onClick={handleClick}
      className="inline-flex items-center gap-1.5 rounded-md border border-orange-200 bg-orange-50 px-2.5 py-1 font-mono text-[11px] font-medium text-orange-700 transition-colors hover:border-orange-300 hover:bg-orange-100"
    >
      <span className="text-[9px] font-semibold uppercase tracking-wider text-orange-400">
        {tableKey.slice(0, 3)}
      </span>
      {label}
    </button>
  );
});

const formatValue = (value: unknown): string => {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  return JSON.stringify(value);
};

interface RowDetailDrawerProps {
  open: boolean;
  onClose: () => void;
  row: Record<string, unknown> | null;
  tableKey: TableKey;
  onNavigate: (tableKey: TableKey, rowId: string) => void;
}

export const RowDetailDrawer = memo(function RowDetailDrawer({
  open,
  onClose,
  row,
  tableKey,
  onNavigate,
}: RowDetailDrawerProps) {
  const title = row
    ? (row["full_name"] as string | undefined) ??
      (row["label"] as string | undefined) ??
      (row["description"] as string | undefined) ??
      String(row["id"] ?? "Row Detail")
    : "Row Detail";

  const subtitle = `${tableKey} · ${String(row?.["id"] ?? "")}`;

  return (
    <Drawer open={open} onClose={onClose} title={title} subtitle={subtitle}>
      {row ? (
        <div className="flex flex-col gap-0">
          {Object.entries(row).map(([key, value], idx) => {
            const isFk = key in FK_MAP;
            const isLong =
              typeof value === "string" && value.length > 60;

            return (
              <div
                key={key}
                className={`flex flex-col gap-1.5 py-3 ${
                  idx < Object.keys(row).length - 1
                    ? "border-b border-stone-100"
                    : ""
                }`}
              >
                <span
                  className="font-mono text-[10px] font-semibold uppercase tracking-wider text-stone-400"
                >
                  {key}
                </span>
                {isFk && typeof value === "string" ? (
                  <FkChip
                    fieldKey={key}
                    value={value}
                    onNavigate={onNavigate}
                  />
                ) : isLong ? (
                  <p className="rounded-md bg-stone-50 p-2.5 font-mono text-[11px] leading-relaxed text-stone-700">
                    {formatValue(value)}
                  </p>
                ) : (
                  <span
                    className="font-mono text-[12px] text-stone-800"
                    style={{
                      color:
                        value === null || value === undefined
                          ? "#a8a29e"
                          : undefined,
                    }}
                  >
                    {formatValue(value)}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      ) : null}
    </Drawer>
  );
});
