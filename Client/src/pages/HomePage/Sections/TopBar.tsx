import { LogOut } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "@/stores/auth.store";
import { useWhatsappState, useBotSettings } from "@/features/pipeline/hooks";

// ── Status Pill ───────────────────────────────────────────────────────────

interface PillProps {
  dot: "green" | "amber" | "red";
  label: string;
}

function StatusPill({ dot, label }: PillProps) {
  const dotClass =
    dot === "green"
      ? "bg-emerald-400"
      : dot === "amber"
        ? "bg-amber-400"
        : "bg-rose-500";

  return (
    <span
      className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold tracking-wide"
      style={{ borderColor: "rgba(255,255,255,0.1)", backgroundColor: "rgba(255,255,255,0.05)", color: "#94a3b8" }}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} />
      {label}
    </span>
  );
}

// ── Main Component ────────────────────────────────────────────────────────

export function TopBar() {
  const navigate = useNavigate();
  const signOut = useAuthStore((s) => s.signOut);
  const user = useAuthStore((s) => s.user);
  const { data: waState } = useWhatsappState();
  const { data: botSettings } = useBotSettings();

  const waConnected = waState?.stateInstance === "authorized";
  const botOn = botSettings?.enabled === true;

  const handleSignOut = async () => {
    await signOut();
    navigate("/login", { replace: true });
  };

  return (
    <header
      className="sticky top-0 z-30 flex items-center justify-between px-5 py-3"
      style={{
        backgroundColor: "#020617",
        borderBottom: "1px solid rgba(255,255,255,0.07)",
      }}
    >
      {/* Logo + wordmark */}
      <div className="flex items-center gap-3">
        <div
          className="flex h-8 w-8 items-center justify-center rounded-lg"
          style={{ background: "linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)" }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="1" y="1" width="6" height="6" rx="1.5" fill="white" />
            <rect x="9" y="1" width="6" height="6" rx="1.5" fill="white" fillOpacity="0.55" />
            <rect x="1" y="9" width="6" height="6" rx="1.5" fill="white" fillOpacity="0.55" />
            <rect x="9" y="9" width="6" height="6" rx="1.5" fill="white" fillOpacity="0.25" />
          </svg>
        </div>
        <div>
          <p className="text-sm font-bold leading-tight text-slate-100">Command Center</p>
          <p className="text-[10px] uppercase tracking-widest" style={{ color: "#475569" }}>
            Insurance AI
          </p>
        </div>
      </div>

      {/* Centre: live status pills */}
      <div className="hidden items-center gap-2 sm:flex">
        <StatusPill dot={waConnected ? "green" : "red"} label={waConnected ? "WhatsApp ON" : "WhatsApp OFF"} />
        <StatusPill dot={botOn ? "green" : "amber"} label={botOn ? "Bot Active" : "Bot Paused"} />
      </div>

      {/* Right: email + sign out */}
      <div className="flex items-center gap-3">
        {user?.email && (
          <span
            className="hidden font-mono text-[10px] uppercase tracking-widest md:block"
            style={{ color: "#475569" }}
          >
            {user.email}
          </span>
        )}
        <button
          onClick={() => void handleSignOut()}
          title="Sign out"
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors"
          style={{
            backgroundColor: "rgba(255,255,255,0.06)",
            border: "1px solid rgba(255,255,255,0.1)",
            color: "#94a3b8",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.color = "#e2e8f0";
            (e.currentTarget as HTMLButtonElement).style.backgroundColor = "rgba(255,255,255,0.1)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.color = "#94a3b8";
            (e.currentTarget as HTMLButtonElement).style.backgroundColor = "rgba(255,255,255,0.06)";
          }}
        >
          <LogOut size={13} aria-hidden="true" />
          <span className="hidden sm:inline">Sign out</span>
        </button>
      </div>
    </header>
  );
}
