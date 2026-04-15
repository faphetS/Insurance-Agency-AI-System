import { useState, useMemo } from "react";
import { TrendingUp, Users, CheckCircle, Target } from "lucide-react";
import { usePipeline } from "@/features/pipeline/hooks";

type Range = "7d" | "30d";

export function FunnelStatsSection() {
  const [range, setRange] = useState<Range>("7d");
  const { data: pipeline, isLoading } = usePipeline();

  const stats = useMemo(() => {
    if (!pipeline) return { total: 0, active: 0, completed: 0, rate: 0 };

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - (range === "7d" ? 7 : 30));

    const inRange = pipeline.filter(
      (c) => c.created_at && new Date(c.created_at) >= cutoff,
    );

    const total = inRange.length;
    const completed = inRange.filter((c) => c.derived_stage === "completed" || c.pipeline_stage === "completed").length;
    const active = inRange.filter(
      (c) =>
        (c.derived_stage ?? c.pipeline_stage) !== "completed" &&
        (c.status === "active" || c.status == null || c.status === "open"),
    ).length;
    const rate = total > 0 ? Math.round((completed / total) * 100) : 0;

    return { total, active, completed, rate };
  }, [pipeline, range]);

  const tiles = [
    {
      label: `New leads (${range})`,
      value: stats.total,
      icon: TrendingUp,
      color: "text-sky-600",
      bg: "bg-sky-50",
    },
    {
      label: "Active clients",
      value: stats.active,
      icon: Users,
      color: "text-violet-600",
      bg: "bg-violet-50",
    },
    {
      label: "Completed",
      value: stats.completed,
      icon: CheckCircle,
      color: "text-emerald-600",
      bg: "bg-emerald-50",
    },
    {
      label: "Conversion rate",
      value: `${stats.rate}%`,
      icon: Target,
      color: "text-orange-600",
      bg: "bg-orange-50",
    },
  ];

  return (
    <div className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
      <div className="mb-5 flex items-center justify-between">
        <h2 className="text-base font-bold text-neutral-900">Funnel Overview</h2>
        <div className="flex rounded-lg bg-neutral-100 p-1">
          {(["7d", "30d"] as Range[]).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`rounded-md px-3 py-1 text-xs font-semibold transition-colors ${
                range === r ? "bg-white text-neutral-900 shadow-sm" : "text-neutral-500 hover:text-neutral-700"
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {tiles.map((tile) => (
          <div key={tile.label} className="rounded-xl border border-neutral-100 bg-neutral-50 p-4">
            <div className={`mb-3 flex h-9 w-9 items-center justify-center rounded-xl ${tile.bg}`}>
              <tile.icon size={18} className={tile.color} />
            </div>
            {isLoading ? (
              <div className="h-8 w-16 animate-pulse rounded-lg bg-neutral-200" />
            ) : (
              <p className="text-3xl font-bold tabular-nums text-neutral-900">{tile.value}</p>
            )}
            <p className="mt-1 text-xs text-neutral-500">{tile.label}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
