import { useSearchParams } from "react-router-dom";
import { useMemo } from "react";
import { useRealtimePipeline } from "@/features/pipeline/hooks";
import { usePipeline, useConversations } from "@/features/pipeline/hooks";
import { TopBar } from "./Sections/TopBar";
import { TabsNav } from "./Sections/TabsNav";
import { OverviewTab } from "./Sections/OverviewTab";
import { PipelineKanbanSection } from "./Sections/PipelineKanbanSection";
import { ConversationsTab } from "./Sections/ConversationsTab";
import { AlertsSection } from "./Sections/AlertsSection";
import type { DashTab } from "./Sections/TabsNav";

// ── Alert count derivation (for badge on nav) ─────────────────────────────

function useAlertCount() {
  const { data: pipeline } = usePipeline();
  const { data: conversations } = useConversations();

  return useMemo(() => {
    if (!pipeline) return 0;
    const now = Date.now();

    const convMap = new Map<string, { last_message_at: string; status: string }>();
    (conversations ?? []).forEach((c) => {
      if (c.client_id) convMap.set(c.client_id, c);
    });

    let count = 0;
    pipeline.forEach((client) => {
      if (!client.id) return;
      const conv = convMap.get(client.id);

      if (conv && conv.status === "open") {
        const minutes = (now - new Date(conv.last_message_at).getTime()) / 60_000;
        if (minutes > 30) count++;
      }
      if (client.time_in_stage_hours != null && client.time_in_stage_hours > 168) count++;
      if (client.last_service_date) {
        const due = new Date(client.last_service_date);
        due.setMonth(due.getMonth() + 24);
        const days = (due.getTime() - now) / 86_400_000;
        if (days >= 0 && days <= 30) count++;
      }
    });
    return count;
  }, [pipeline, conversations]);
}

// ── Main component ────────────────────────────────────────────────────────

export default function HomePage() {
  // Enable real-time subscriptions for the whole dashboard
  useRealtimePipeline();

  const [params] = useSearchParams();
  const activeTab = (params.get("tab") ?? "overview") as DashTab;
  const alertCount = useAlertCount();

  return (
    <div className="min-h-screen" style={{ backgroundColor: "#020617" }}>
      <TopBar />
      <TabsNav alertCount={alertCount} />

      <main>
        {activeTab === "overview" && <OverviewTab />}

        {activeTab === "pipeline" && (
          <div className="mx-auto max-w-screen-2xl px-5 py-6">
            <p
              className="mb-4 text-xs font-bold uppercase tracking-widest"
              style={{ color: "#475569" }}
            >
              Client Pipeline
            </p>
            <PipelineKanbanSection />
          </div>
        )}

        {activeTab === "conversations" && <ConversationsTab />}

        {activeTab === "alerts" && (
          <div className="mx-auto max-w-screen-2xl px-5 py-6">
            <AlertsSection />
          </div>
        )}
      </main>
    </div>
  );
}
