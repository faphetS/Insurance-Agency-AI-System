import { useNavigate } from "react-router-dom";
import { LogOut } from "lucide-react";
import { useRealtimePipeline } from "@/features/pipeline/hooks";
import { useAuthStore } from "@/stores/auth.store";
import { SystemStatusSection } from "./Sections/SystemStatusSection";
import { ConversationsSection } from "./Sections/ConversationsSection";
import { PipelineKanbanSection } from "./Sections/PipelineKanbanSection";
import { FunnelStatsSection } from "./Sections/FunnelStatsSection";
import { AlertsSection } from "./Sections/AlertsSection";

export default function HomePage() {
  // Enable real-time subscriptions for the whole dashboard
  useRealtimePipeline();

  const navigate = useNavigate();
  const signOut = useAuthStore((s) => s.signOut);
  const user = useAuthStore((s) => s.user);

  const handleSignOut = async () => {
    await signOut();
    navigate("/login", { replace: true });
  };

  return (
    <div className="min-h-screen bg-neutral-50">
      {/* Sticky top bar */}
      <header className="sticky top-0 z-30 border-b border-neutral-200 bg-white/90 backdrop-blur-sm">
        <div className="mx-auto flex max-w-screen-2xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-neutral-900">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <rect x="2" y="2" width="6" height="6" rx="1.5" fill="white" />
                <rect x="10" y="2" width="6" height="6" rx="1.5" fill="white" opacity="0.6" />
                <rect x="2" y="10" width="6" height="6" rx="1.5" fill="white" opacity="0.6" />
                <rect x="10" y="10" width="6" height="6" rx="1.5" fill="white" opacity="0.3" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-bold leading-tight text-neutral-900">Pipeline Dashboard</p>
              <p className="text-[11px] leading-tight text-neutral-400">Insurance Agency AI</p>
            </div>
          </div>

          {/* Right side: system status + sign out */}
          <div className="flex items-center gap-4">
            {/* Compact system status inside header */}
            <div className="hidden sm:block">
              <SystemStatusSection />
            </div>

            {/* Sign out */}
            <div className="flex items-center gap-2.5">
              {user?.email && (
                <span className="hidden font-mono text-[10px] uppercase tracking-widest text-neutral-400 md:block">
                  {user.email}
                </span>
              )}
              <button
                onClick={handleSignOut}
                title="Sign out"
                className="flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 font-sans text-xs font-medium text-neutral-600 transition hover:border-neutral-300 hover:bg-neutral-50 hover:text-neutral-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-neutral-900"
              >
                <LogOut size={13} aria-hidden="true" />
                <span className="hidden sm:inline">Sign out</span>
              </button>
            </div>
          </div>
        </div>

        {/* Mobile system status row */}
        <div className="border-t border-neutral-100 px-4 py-3 sm:hidden">
          <SystemStatusSection />
        </div>
      </header>

      {/* Main content */}
      <main className="mx-auto max-w-screen-2xl px-4 py-6 md:px-6">
        {/* Recent Conversations — primary "what's happening now" panel */}
        <section className="mb-6">
          <ConversationsSection />
        </section>

        {/* Kanban — full width, own horizontal scroll */}
        <section className="mb-6">
          <h2 className="mb-3 text-xs font-bold uppercase tracking-widest text-neutral-400">Client Pipeline</h2>
          <PipelineKanbanSection />
        </section>

        {/* Bottom grid: Funnel Stats + Alerts */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <FunnelStatsSection />
          <AlertsSection />
        </div>
      </main>
    </div>
  );
}
