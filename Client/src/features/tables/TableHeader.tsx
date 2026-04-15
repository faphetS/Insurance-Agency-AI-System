import { memo } from "react";
import { Database } from "lucide-react";
import { TABLE_REGISTRY, TOTAL_ROWS } from "./tableRegistry";

export const TableHeader = memo(function TableHeader() {
  const tableCount = TABLE_REGISTRY.length;

  return (
    <header className="border-b border-stone-200 bg-white px-6 py-5">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-orange-500 shadow-sm">
          <Database size={16} className="text-white" />
        </div>
        <div>
          <h1 className="text-[15px] font-bold leading-tight tracking-tight text-stone-900">
            Insurance Agency
          </h1>
          <p className="mt-0.5 text-[11px] font-medium uppercase tracking-wide text-stone-400">
            {tableCount} tables · {TOTAL_ROWS} rows
          </p>
        </div>
      </div>
    </header>
  );
});
