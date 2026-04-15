import { memo, useCallback, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { TableHeader } from "./TableHeader";
import { TableNav } from "./TableNav";
import { RowDetailDrawer } from "./RowDetailDrawer";
import { ClientsView } from "./tables/ClientsView";
import { MeetingsView } from "./tables/MeetingsView";
import { TasksView } from "./tables/TasksView";
import { AutomationRulesView } from "./tables/AutomationRulesView";
import { ChannelsView } from "./tables/ChannelsView";
import { TABLE_REGISTRY, type TableKey } from "./tableRegistry";
import type { ComponentType } from "react";

// Hoist view-to-key map outside component (rendering-hoist-jsx, rerender-no-inline-components)
const VIEW_MAP: Record<
  TableKey,
  ComponentType<{
    onRowClick: (row: Record<string, unknown>) => void;
    searchQuery: string;
  }>
> = {
  clients: ClientsView,
  meetings: MeetingsView,
  tasks: TasksView,
  automationRules: AutomationRulesView,
  channels: ChannelsView,
};

interface DrawerState {
  open: boolean;
  tableKey: TableKey;
  row: Record<string, unknown> | null;
}

const INITIAL_DRAWER: DrawerState = {
  open: false,
  tableKey: "clients",
  row: null,
};

export const TableBrowser = memo(function TableBrowser() {
  const [activeKey, setActiveKey] = useState<TableKey>("clients");
  const [searchQuery, setSearchQuery] = useState("");
  const [drawer, setDrawer] = useState<DrawerState>(INITIAL_DRAWER);

  const handleRowClick = useCallback(
    (row: Record<string, unknown>) => {
      setDrawer({ open: true, tableKey: activeKey, row });
    },
    [activeKey],
  );

  const handleTableSelect = useCallback((key: TableKey) => {
    setActiveKey(key);
    setSearchQuery("");
  }, []);

  const handleDrawerClose = useCallback(() => {
    setDrawer((prev) => ({ ...prev, open: false }));
  }, []);

  // FK navigation: switch table and open the target row's drawer
  const handleFkNavigate = useCallback(
    (tableKey: TableKey, rowId: string) => {
      const entry = TABLE_REGISTRY.find((t) => t.key === tableKey);
      if (!entry) return;
      const row = (entry.data as Array<Record<string, unknown>>).find(
        (r) => r["id"] === rowId,
      );
      if (!row) return;
      setActiveKey(tableKey);
      setSearchQuery("");
      setDrawer({ open: true, tableKey, row });
    },
    [],
  );

  // drawer.tableKey tracks which table the currently-displayed row belongs to
  const drawerTableKey = drawer.tableKey;

  const ActiveView = VIEW_MAP[activeKey];
  const activeLabel = useMemo(
    () => TABLE_REGISTRY.find((t) => t.key === activeKey)?.label ?? "",
    [activeKey],
  );

  return (
    <>
      <div className="flex h-screen overflow-hidden bg-stone-50">
        {/* Sidebar */}
        <aside className="flex w-56 shrink-0 flex-col border-r border-stone-200 bg-white">
          <TableHeader />
          <div className="flex-1 overflow-y-auto px-2">
            <TableNav activeKey={activeKey} onSelect={handleTableSelect} />
          </div>
          {/* Sidebar footer */}
          <div className="border-t border-stone-100 px-4 py-3">
            <span className="font-mono text-[10px] text-stone-300">
              mock · read-only
            </span>
          </div>
        </aside>

        {/* Main panel */}
        <main className="flex min-w-0 flex-1 flex-col">
          {/* Panel header */}
          <div className="flex items-center justify-between gap-4 border-b border-stone-200 bg-white px-6 py-4">
            <h2 className="text-[16px] font-bold tracking-tight text-stone-900">
              {activeLabel}
            </h2>
            {/* Search input */}
            <div className="relative w-56">
              <Search
                size={13}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-stone-400"
              />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={`Search ${activeLabel.toLowerCase()}…`}
                className="w-full rounded-lg border border-stone-200 bg-stone-50 py-2 pl-8 pr-3 font-mono text-[12px] text-stone-700 placeholder-stone-300 outline-none transition focus:border-orange-300 focus:bg-white focus:ring-2 focus:ring-orange-100"
              />
            </div>
          </div>

          {/* Table view scroll area */}
          <div className="flex-1 overflow-y-auto px-6 py-5">
            <ActiveView
              onRowClick={handleRowClick}
              searchQuery={searchQuery}
            />
          </div>
        </main>
      </div>

      {/* Row detail drawer */}
      <RowDetailDrawer
        open={drawer.open}
        onClose={handleDrawerClose}
        row={drawer.row}
        tableKey={drawerTableKey}
        onNavigate={handleFkNavigate}
      />
    </>
  );
});
