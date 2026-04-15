import { memo } from "react";
import { TABLE_REGISTRY, type TableKey } from "./tableRegistry";

interface TableNavProps {
  activeKey: TableKey;
  onSelect: (key: TableKey) => void;
}

export const TableNav = memo(function TableNav({
  activeKey,
  onSelect,
}: TableNavProps) {
  return (
    <nav className="flex flex-col gap-0.5 py-3">
      {TABLE_REGISTRY.map(({ key, label, icon: Icon, rowCount }) => {
        const isActive = key === activeKey;
        return (
          <button
            key={key}
            onClick={() => onSelect(key)}
            className={`group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-all duration-150 ${
              isActive
                ? "bg-orange-50 text-orange-700"
                : "text-stone-500 hover:bg-stone-100 hover:text-stone-800"
            }`}
          >
            <Icon
              size={16}
              className={`shrink-0 transition-colors ${
                isActive ? "text-orange-500" : "text-stone-400 group-hover:text-stone-600"
              }`}
            />
            <span className="flex-1 text-[13px] font-medium tracking-tight">
              {label}
            </span>
            <span
              className={`rounded-md px-1.5 py-0.5 font-mono text-[10px] font-semibold ${
                isActive
                  ? "bg-orange-100 text-orange-600"
                  : "bg-stone-100 text-stone-400"
              }`}
            >
              {rowCount}
            </span>
          </button>
        );
      })}
    </nav>
  );
});
