import { memo, useMemo } from "react";
import { ArrowRight, Clock } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { automationRules } from "@/lib/mockData";
import type { AutomationMode, AutomationRule } from "@/types/domain";

const MODE_VARIANT: Record<
  AutomationMode,
  "auto" | "hybrid" | "manual"
> = {
  AUTO: "auto",
  HYBRID: "hybrid",
  MANUAL: "manual",
};

interface RuleCardProps {
  rule: AutomationRule;
  onClick: () => void;
}

const RuleCard = memo(function RuleCard({ rule, onClick }: RuleCardProps) {
  return (
    <button
      onClick={onClick}
      className="group flex w-full items-stretch gap-0 overflow-hidden rounded-lg border border-stone-200 bg-white text-left shadow-sm transition-all hover:border-orange-200 hover:shadow-md"
    >
      {/* Step number */}
      <div className="flex w-10 shrink-0 items-center justify-center border-r border-stone-100 bg-stone-50">
        <span className="font-mono text-[11px] font-bold text-stone-300">
          {String(rule.id).padStart(2, "0")}
        </span>
      </div>
      {/* Content */}
      <div className="flex flex-1 flex-col gap-1.5 px-4 py-3">
        {/* Trigger → Action */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-stone-600">
            {rule.trigger}
          </span>
          <ArrowRight
            size={11}
            className="shrink-0 text-orange-400"
          />
          <span className="text-[12px] leading-snug text-stone-700">
            {rule.action}
          </span>
        </div>
        {/* Timing + mode */}
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1 text-[10px] text-stone-400">
            <Clock size={9} />
            {rule.timing}
          </span>
          <Badge variant={MODE_VARIANT[rule.mode]}>{rule.mode}</Badge>
        </div>
      </div>
    </button>
  );
});

interface AutomationRulesViewProps {
  onRowClick: (row: Record<string, unknown>) => void;
  searchQuery: string;
}

export const AutomationRulesView = memo(function AutomationRulesView({
  onRowClick,
  searchQuery,
}: AutomationRulesViewProps) {
  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return automationRules;
    const q = searchQuery.toLowerCase();
    return automationRules.filter(
      (r) =>
        r.trigger.toLowerCase().includes(q) ||
        r.action.toLowerCase().includes(q) ||
        r.mode.toLowerCase().includes(q),
    );
  }, [searchQuery]);

  return (
    <div className="flex flex-col gap-2">
      {filtered.map((rule) => (
        <RuleCard
          key={rule.id}
          rule={rule}
          onClick={() =>
            onRowClick(rule as unknown as Record<string, unknown>)
          }
        />
      ))}
      {filtered.length === 0 && (
        <div className="py-12 text-center text-sm text-stone-400">
          No automation rules match &ldquo;{searchQuery}&rdquo;
        </div>
      )}
    </div>
  );
});
