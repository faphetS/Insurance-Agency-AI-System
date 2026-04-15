import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useEffect } from "react";
import { toast } from "sonner";
import { Bot, Loader2, Save } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { formatDistanceToNow } from "date-fns";

// ── Schema ────────────────────────────────────────────────────────────────────

const schema = z.object({
  system_prompt: z.string().min(1, "System prompt is required"),
  model_name: z.string().min(1, "Model name is required"),
  enabled: z.boolean(),
  auto_reply: z.boolean(),
});

type FormValues = z.infer<typeof schema>;

interface BotSettings {
  id: number;
  system_prompt: string;
  model_name: string;
  enabled: boolean;
  auto_reply: boolean;
  updated_at: string;
}

// ── Data hooks ────────────────────────────────────────────────────────────────

function useBotSettings() {
  return useQuery<BotSettings>({
    queryKey: ["bot_settings"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("bot_settings")
        .select("*")
        .eq("id", 1)
        .single();
      if (error) throw error;
      return data as BotSettings;
    },
  });
}

function useSaveBotSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (values: FormValues) => {
      const { error } = await supabase
        .from("bot_settings")
        .update({ ...values, updated_at: new Date().toISOString() })
        .eq("id", 1);
      if (error) throw error;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["bot_settings"] });
      toast.success("Bot settings saved");
    },
    onError: () => {
      toast.error("Failed to save settings");
    },
  });
}

// ── Toggle component ──────────────────────────────────────────────────────────

function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <p className="text-sm font-medium" style={{ color: "#e2e8f0" }}>
          {label}
        </p>
        <p className="mt-0.5 text-xs" style={{ color: "#475569" }}>
          {description}
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className="relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors duration-200"
        style={{
          backgroundColor: checked ? "#6366f1" : "rgba(255,255,255,0.08)",
          border: "1px solid rgba(255,255,255,0.1)",
          boxSizing: "border-box",
        }}
      >
        <span
          className="absolute top-1/2 h-5 w-5 -translate-y-1/2 rounded-full shadow-sm transition-all duration-200"
          style={{
            backgroundColor: "#fff",
            left: checked ? "calc(100% - 22px)" : "2px",
          }}
        />
      </button>
    </div>
  );
}

// ── Main tab ──────────────────────────────────────────────────────────────────

const KNOWN_MODELS = [
  "gemma-4-26b-a4b-it",
  "gemma-4-31b-it",
  "gemma-4-e4b-it",
  "gemma-4-e2b-it",
];

export function BotTab() {
  const { data, isLoading, isError } = useBotSettings();
  const save = useSaveBotSettings();

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors, isDirty },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      system_prompt: "",
      model_name: "gemma-4-26b-a4b-it",
      enabled: false,
      auto_reply: false,
    },
  });

  useEffect(() => {
    if (data) {
      reset({
        system_prompt: data.system_prompt,
        model_name: data.model_name,
        enabled: data.enabled,
        auto_reply: data.auto_reply,
      });
    }
  }, [data, reset]);

  const onSubmit = (values: FormValues) => save.mutate(values);

  const enabled = watch("enabled");
  const autoReply = watch("auto_reply");

  const hairline = "1px solid rgba(255,255,255,0.07)";
  const panelBg = "#0f172a";

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-5 w-5 animate-spin" style={{ color: "#6366f1" }} />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex items-center justify-center py-24">
        <p className="text-sm" style={{ color: "#f43f5e" }}>
          Failed to load bot settings.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-5 py-8">
      {/* Header */}
      <div className="mb-6 flex items-center gap-3">
        <div
          className="flex h-9 w-9 items-center justify-center rounded-lg"
          style={{ backgroundColor: "rgba(99,102,241,0.12)", border: hairline }}
        >
          <Bot className="h-4 w-4" style={{ color: "#6366f1" }} />
        </div>
        <div>
          <h2 className="text-sm font-semibold" style={{ color: "#e2e8f0" }}>
            AI Bot Configuration
          </h2>
          {data?.updated_at && (
            <p className="mt-0.5 text-xs tabular-nums" style={{ color: "#334155" }}>
              Last updated{" "}
              {formatDistanceToNow(new Date(data.updated_at), { addSuffix: true })}
            </p>
          )}
        </div>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        {/* Toggles panel */}
        <div
          className="rounded-xl p-5 space-y-5"
          style={{ backgroundColor: panelBg, border: hairline }}
        >
          <Toggle
            checked={enabled}
            onChange={(v) => setValue("enabled", v, { shouldDirty: true })}
            label="Bot enabled"
            description="Master switch — when off, the bot will not process any inbound messages."
          />
          <div style={{ borderTop: hairline }} />
          <Toggle
            checked={autoReply}
            onChange={(v) => setValue("auto_reply", v, { shouldDirty: true })}
            label="Auto-reply"
            description="Automatically send AI-generated replies to new inbound messages."
          />
        </div>

        {/* System prompt */}
        <div
          className="rounded-xl p-5"
          style={{ backgroundColor: panelBg, border: hairline }}
        >
          <label
            className="mb-2 block text-xs font-semibold uppercase tracking-widest"
            style={{ color: "#475569" }}
          >
            System Prompt
          </label>
          <textarea
            {...register("system_prompt")}
            rows={10}
            className="w-full resize-y rounded-lg px-3 py-2.5 text-sm leading-relaxed outline-none transition-colors"
            style={{
              backgroundColor: "rgba(255,255,255,0.04)",
              border: errors.system_prompt
                ? "1px solid #f43f5e"
                : hairline,
              color: "#cbd5e1",
              fontFamily: "'DM Mono', 'Fira Code', monospace",
            }}
            onFocus={(e) => {
              e.currentTarget.style.border = "1px solid rgba(99,102,241,0.5)";
            }}
            onBlur={(e) => {
              e.currentTarget.style.border = errors.system_prompt
                ? "1px solid #f43f5e"
                : hairline;
            }}
            placeholder="You are a friendly helpful assistant..."
          />
          {errors.system_prompt && (
            <p className="mt-1 text-xs" style={{ color: "#f43f5e" }}>
              {errors.system_prompt.message}
            </p>
          )}
          <p className="mt-2 text-xs" style={{ color: "#334155" }}>
            Edits take effect immediately — the orchestrator reads this on every inbound
            message.
          </p>
        </div>

        {/* Model name */}
        <div
          className="rounded-xl p-5"
          style={{ backgroundColor: panelBg, border: hairline }}
        >
          <label
            className="mb-2 block text-xs font-semibold uppercase tracking-widest"
            style={{ color: "#475569" }}
          >
            Model
          </label>
          <input
            {...register("model_name")}
            type="text"
            className="w-full rounded-lg px-3 py-2.5 text-sm outline-none transition-colors"
            style={{
              backgroundColor: "rgba(255,255,255,0.04)",
              border: errors.model_name ? "1px solid #f43f5e" : hairline,
              color: "#cbd5e1",
              fontFamily: "'DM Mono', 'Fira Code', monospace",
            }}
            onFocus={(e) => {
              e.currentTarget.style.border = "1px solid rgba(99,102,241,0.5)";
            }}
            onBlur={(e) => {
              e.currentTarget.style.border = errors.model_name
                ? "1px solid #f43f5e"
                : hairline;
            }}
            placeholder="gemma-4-26b-a4b-it"
          />
          {errors.model_name && (
            <p className="mt-1 text-xs" style={{ color: "#f43f5e" }}>
              {errors.model_name.message}
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {KNOWN_MODELS.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setValue("model_name", m, { shouldDirty: true })}
                className="rounded px-2 py-0.5 text-xs transition-colors"
                style={{
                  backgroundColor: "rgba(255,255,255,0.05)",
                  border: hairline,
                  color: "#64748b",
                  fontFamily: "'DM Mono', 'Fira Code', monospace",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = "#94a3b8";
                  e.currentTarget.style.backgroundColor = "rgba(99,102,241,0.1)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = "#64748b";
                  e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.05)";
                }}
              >
                {m}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs" style={{ color: "#334155" }}>
            Click a model name to fill it in, or type a custom model identifier.
          </p>
        </div>

        {/* Save */}
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={!isDirty || save.isPending}
            className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-40"
            style={{
              backgroundColor: "#6366f1",
              color: "#fff",
            }}
            onMouseEnter={(e) => {
              if (!save.isPending && isDirty) {
                e.currentTarget.style.backgroundColor = "#818cf8";
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = "#6366f1";
            }}
          >
            {save.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            Save changes
          </button>
        </div>
      </form>
    </div>
  );
}
