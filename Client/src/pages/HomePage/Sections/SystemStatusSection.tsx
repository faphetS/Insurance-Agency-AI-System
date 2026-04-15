import { useState } from "react";
import { Wifi, WifiOff, Bot, MessageSquare, AlertCircle, X, RefreshCw, Save } from "lucide-react";
import { useBotSettings, useUpdateBotSettings, useWhatsappState, useQrCode, useConversations } from "@/features/pipeline/hooks";

// ── WhatsApp QR Modal ─────────────────────────────────────────────────────

function QrModal({ onClose }: { onClose: () => void }) {
  const { data, isLoading, error } = useQrCode(true);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="relative w-full max-w-sm rounded-2xl bg-white p-8 shadow-2xl">
        <button
          onClick={onClose}
          className="absolute right-4 top-4 rounded-lg p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
        >
          <X size={18} />
        </button>
        <h3 className="mb-1 text-lg font-bold text-neutral-900">Connect WhatsApp</h3>
        <p className="mb-6 text-sm text-neutral-500">Scan this QR code with WhatsApp on your phone.</p>
        <div className="flex items-center justify-center rounded-xl border-2 border-dashed border-neutral-200 bg-neutral-50 p-4" style={{ minHeight: 240 }}>
          {isLoading ? (
            <div className="flex flex-col items-center gap-3 text-neutral-400">
              <RefreshCw size={28} className="animate-spin" />
              <span className="text-sm">Loading QR…</span>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center gap-2 text-rose-500">
              <AlertCircle size={28} />
              <span className="text-sm">Could not load QR code</span>
            </div>
          ) : data?.qrCode ? (
            <img
              src={`data:image/png;base64,${data.qrCode}`}
              alt="WhatsApp QR Code"
              className="h-48 w-48 rounded-lg"
            />
          ) : (
            <span className="text-sm text-neutral-400">No QR code available</span>
          )}
        </div>
        <p className="mt-4 text-center text-xs text-neutral-400">QR code refreshes automatically every 60s</p>
      </div>
    </div>
  );
}

// ── Today's Stats helper ──────────────────────────────────────────────────

function useTodayStats() {
  const { data: conversations } = useConversations();
  // We can't load all messages here — use conversations as proxy
  // Count conversations updated today
  const today = new Date().toDateString();
  const todayConvs = (conversations ?? []).filter(
    (c) => new Date(c.last_message_at).toDateString() === today,
  );
  const pending = todayConvs.filter((c) => c.status === "open" && !c.bot_paused).length;
  return { todayConvs: todayConvs.length, pending };
}

// ── Bot Settings Card ─────────────────────────────────────────────────────

function BotSettingsCard() {
  const { data: settings, isLoading } = useBotSettings();
  const { mutate: save, isPending } = useUpdateBotSettings();
  const [prompt, setPrompt] = useState<string>("");
  const [promptDirty, setPromptDirty] = useState(false);

  const currentPrompt = promptDirty ? prompt : (settings?.system_prompt ?? "");

  if (isLoading) {
    return (
      <div className="flex h-full flex-col gap-3 rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
        <div className="h-5 w-28 animate-pulse rounded bg-neutral-100" />
        <div className="h-3 w-48 animate-pulse rounded bg-neutral-100" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
      <div className="flex items-center gap-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-100">
          <Bot size={16} className="text-violet-600" />
        </div>
        <div>
          <p className="text-sm font-semibold text-neutral-900">AI Bot</p>
          <p className="text-xs text-neutral-400">{settings?.model_name ?? "Gemma"}</p>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <label className="flex items-center justify-between">
          <span className="text-xs font-medium text-neutral-600">Bot enabled</span>
          <button
            onClick={() => settings && save({ enabled: !settings.enabled })}
            className={`relative h-5 w-9 rounded-full transition-colors ${settings?.enabled ? "bg-violet-500" : "bg-neutral-200"}`}
          >
            <span
              className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${settings?.enabled ? "translate-x-4" : "translate-x-0.5"}`}
            />
          </button>
        </label>
        <label className="flex items-center justify-between">
          <span className="text-xs font-medium text-neutral-600">Auto reply</span>
          <button
            onClick={() => settings && save({ auto_reply: !settings.auto_reply })}
            className={`relative h-5 w-9 rounded-full transition-colors ${settings?.auto_reply ? "bg-violet-500" : "bg-neutral-200"}`}
          >
            <span
              className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${settings?.auto_reply ? "translate-x-4" : "translate-x-0.5"}`}
            />
          </button>
        </label>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-neutral-600">System prompt</span>
        <textarea
          rows={3}
          value={currentPrompt}
          onChange={(e) => {
            setPrompt(e.target.value);
            setPromptDirty(true);
          }}
          className="w-full resize-none rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-700 outline-none focus:border-violet-400 focus:bg-white"
          placeholder="System prompt…"
        />
        {promptDirty && (
          <button
            onClick={() => {
              save({ system_prompt: prompt });
              setPromptDirty(false);
            }}
            disabled={isPending}
            className="flex items-center gap-1.5 self-end rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-700 disabled:opacity-60"
          >
            <Save size={12} />
            {isPending ? "Saving…" : "Save"}
          </button>
        )}
      </div>
    </div>
  );
}

// ── Today Card ────────────────────────────────────────────────────────────

function TodayCard() {
  const { todayConvs, pending } = useTodayStats();
  const hasPending = pending > 0;

  return (
    <div
      className={`flex flex-col gap-4 rounded-2xl border bg-white p-5 shadow-sm ${hasPending ? "border-rose-300" : "border-neutral-200"}`}
    >
      <div className="flex items-center gap-2">
        <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${hasPending ? "bg-rose-100" : "bg-emerald-100"}`}>
          <MessageSquare size={16} className={hasPending ? "text-rose-600" : "text-emerald-600"} />
        </div>
        <div>
          <p className="text-sm font-semibold text-neutral-900">Today</p>
          <p className="text-xs text-neutral-400">{new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}</p>
        </div>
        {hasPending && (
          <span className="ml-auto flex h-6 min-w-6 items-center justify-center rounded-full bg-rose-500 px-1.5 text-xs font-bold tabular-nums text-white">
            {pending}
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl bg-neutral-50 p-3 text-center">
          <p className="text-2xl font-bold tabular-nums text-neutral-900">{todayConvs}</p>
          <p className="mt-0.5 text-xs text-neutral-500">Active chats</p>
        </div>
        <div className={`rounded-xl p-3 text-center ${hasPending ? "bg-rose-50" : "bg-neutral-50"}`}>
          <p className={`text-2xl font-bold tabular-nums ${hasPending ? "text-rose-600" : "text-neutral-900"}`}>{pending}</p>
          <p className="mt-0.5 text-xs text-neutral-500">Pending reply</p>
        </div>
      </div>

      {hasPending && (
        <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">
          {pending} conversation{pending > 1 ? "s" : ""} waiting for a human reply
        </p>
      )}
    </div>
  );
}

// ── WhatsApp Status Card ──────────────────────────────────────────────────

function WhatsAppCard() {
  const { data, isLoading, error } = useWhatsappState();
  const [showQr, setShowQr] = useState(false);

  const isConnected = data?.stateInstance === "authorized";

  return (
    <>
      <div className="flex flex-col gap-4 rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-2">
          <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${isConnected ? "bg-emerald-100" : "bg-rose-100"}`}>
            {isConnected ? (
              <Wifi size={16} className="text-emerald-600" />
            ) : (
              <WifiOff size={16} className="text-rose-500" />
            )}
          </div>
          <div className="flex-1">
            <p className="text-sm font-semibold text-neutral-900">WhatsApp</p>
            <p className="text-xs text-neutral-400">Instance status</p>
          </div>
          <span className="flex items-center gap-1.5 text-xs font-medium">
            <span className={`h-2 w-2 rounded-full ${isConnected ? "bg-emerald-500" : "bg-rose-400"} ${!isLoading && !error && !isConnected ? "animate-pulse" : ""}`} />
            {isLoading ? "Checking…" : error ? "Unavailable" : isConnected ? "Connected" : data?.stateInstance ?? "Disconnected"}
          </span>
        </div>

        {!isLoading && !error && (
          <div className="flex flex-col gap-2">
            {isConnected ? (
              <div className="rounded-xl bg-emerald-50 px-3 py-2.5 text-xs text-emerald-700">
                WhatsApp is active and receiving messages.
              </div>
            ) : (
              <>
                <p className="text-xs text-neutral-500">Your WhatsApp instance is not connected. Scan the QR code to link it.</p>
                <button
                  onClick={() => setShowQr(true)}
                  className="w-full rounded-xl bg-neutral-900 py-2 text-sm font-semibold text-white hover:bg-neutral-700"
                >
                  Scan QR Code
                </button>
              </>
            )}
          </div>
        )}

        {error && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
            WhatsApp API is not reachable — check server connection.
          </p>
        )}
      </div>

      {showQr && <QrModal onClose={() => setShowQr(false)} />}
    </>
  );
}

// ── Main Export ───────────────────────────────────────────────────────────

export function SystemStatusSection() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <WhatsAppCard />
      <BotSettingsCard />
      <TodayCard />
    </div>
  );
}
