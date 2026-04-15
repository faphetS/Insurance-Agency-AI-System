import { useSearchParams } from "react-router-dom";

export type DashTab = "overview" | "pipeline" | "conversations" | "alerts";

const TABS: { key: DashTab; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "pipeline", label: "Pipeline" },
  { key: "conversations", label: "Conversations" },
  { key: "alerts", label: "Alerts" },
];

interface TabsNavProps {
  alertCount?: number;
}

export function TabsNav({ alertCount = 0 }: TabsNavProps) {
  const [params, setParams] = useSearchParams();
  const active = (params.get("tab") ?? "overview") as DashTab;

  const setTab = (tab: DashTab) => {
    setParams({ tab }, { replace: true });
  };

  return (
    <nav
      className="flex items-center gap-1 px-5 py-2"
      style={{ borderBottom: "1px solid rgba(255,255,255,0.07)" }}
    >
      {TABS.map(({ key, label }) => {
        const isActive = key === active;
        return (
          <button
            key={key}
            onClick={() => setTab(key)}
            className="relative flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold transition-all"
            style={
              isActive
                ? {
                    backgroundColor: "#6366f1",
                    color: "#ffffff",
                  }
                : {
                    backgroundColor: "transparent",
                    color: "#64748b",
                  }
            }
            onMouseEnter={(e) => {
              if (!isActive) {
                (e.currentTarget as HTMLButtonElement).style.color = "#94a3b8";
                (e.currentTarget as HTMLButtonElement).style.backgroundColor = "rgba(255,255,255,0.05)";
              }
            }}
            onMouseLeave={(e) => {
              if (!isActive) {
                (e.currentTarget as HTMLButtonElement).style.color = "#64748b";
                (e.currentTarget as HTMLButtonElement).style.backgroundColor = "transparent";
              }
            }}
          >
            {label}
            {key === "alerts" && alertCount > 0 && (
              <span
                className="flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold tabular-nums"
                style={{ backgroundColor: isActive ? "rgba(255,255,255,0.25)" : "#f43f5e", color: "#fff" }}
              >
                {alertCount}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
