import OpenAI from "openai";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { supabaseAdmin } from "../../config/supabase.js";
import { notifyOwnerOps } from "../operations/owner-notify.js";
import { opExcludedChatIds } from "../whatsapp/whatsapp.util.js";
import { COMMITMENT_COMPOSITION_SYSTEM_PROMPT } from "./commitments.prompts.js";
import type { Commitment } from "./commitments.types.js";

const FALLBACK_MODEL = "google/gemini-2.5-flash";
const STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000;

const openai = new OpenAI({
  apiKey: env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

export async function sendSelfMessage(text: string): Promise<boolean> {
  return notifyOwnerOps(text);
}

function buildFallbackMorningMessage(commitments: Commitment[]): string {
  const lines = ["בוקר טוב! התזכורות להיום:"];
  for (const c of commitments) {
    const timeLabel = c.due_time ? ` (${c.due_time.slice(0, 5)})` : "";
    const dateLabel = c.due_date ? ` ב-${c.due_date}` : "";
    lines.push(`• ${c.commitment_text}${dateLabel}${timeLabel} — ${c.contact_name}`);
  }
  return lines.join("\n");
}

export async function composeMorningMessage(commitments: Commitment[]): Promise<string> {
  const model = env.COMMITMENT_AI_MODEL ?? FALLBACK_MODEL;

  const listText = commitments
    .map((c) => {
      const dateLabel = c.due_date ? ` ב-${c.due_date}` : "";
      const timeLabel = c.due_time ? ` בשעה ${c.due_time.slice(0, 5)}` : "";
      return `- ${c.commitment_text}${dateLabel}${timeLabel} (מהשיחה עם ${c.contact_name})`;
    })
    .join("\n");

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: COMMITMENT_COMPOSITION_SYSTEM_PROMPT },
    { role: "user", content: listText },
  ];

  try {
    let raw: string;
    try {
      const resp = await openai.chat.completions.create({ model, messages }, { timeout: 20_000 });
      raw = resp.choices[0]?.message?.content ?? "";
    } catch (err) {
      if (model !== FALLBACK_MODEL) {
        logger.warn({ model, err }, "commitments: composition primary model failed — retrying with fallback");
        const resp = await openai.chat.completions.create(
          { model: FALLBACK_MODEL, messages },
          { timeout: 20_000 },
        );
        raw = resp.choices[0]?.message?.content ?? "";
      } else {
        throw err;
      }
    }
    return raw.trim() || buildFallbackMorningMessage(commitments);
  } catch (err) {
    logger.warn({ err }, "commitments: LLM composition failed — using template fallback");
    return buildFallbackMorningMessage(commitments);
  }
}

export async function markCommitmentsSent(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await supabaseAdmin
    .from("commitments")
    .update({ status: "sent", sent_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .in("id", ids);
}

async function markCommitmentsCancelled(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await supabaseAdmin
    .from("commitments")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .in("id", ids);
}

export async function buildMorningCommitmentSection(): Promise<{ text: string | null; ids: string[] }> {
  const now = new Date();
  const { data, error } = await supabaseAdmin
    .from("commitments")
    .select("*")
    .eq("status", "pending")
    .in("kind", ["date_only", "floating"])
    .lte("fire_at", now.toISOString());

  if (error) {
    logger.warn({ error }, "commitments: buildMorningCommitmentSection query failed");
    return { text: null, ids: [] };
  }

  const excluded = opExcludedChatIds();
  const pending = ((data ?? []) as Commitment[]).filter((c) => !excluded.has(c.chat_id));
  if (pending.length === 0) return { text: null, ids: [] };

  const text = await composeMorningMessage(pending);
  return { text, ids: pending.map((c) => c.id) };
}

export async function fireMorningBatch(): Promise<void> {
  const { text, ids } = await buildMorningCommitmentSection();
  if (!text) return;
  const ok = await sendSelfMessage(text);
  if (ok) {
    await markCommitmentsSent(ids);
    logger.info({ count: ids.length }, "commitments: morning batch sent");
  }
}

export async function fireTimedReminders(): Promise<void> {
  const now = new Date();
  const staleThreshold = new Date(now.getTime() - STALE_THRESHOLD_MS);

  // Cancel stale timed commitments (fired more than 2h ago)
  const { data: staleData } = await supabaseAdmin
    .from("commitments")
    .select("id, fire_at")
    .eq("status", "pending")
    .eq("kind", "timed")
    .lt("fire_at", staleThreshold.toISOString());

  if (staleData && staleData.length > 0) {
    const staleIds = (staleData as Commitment[]).map((c) => c.id);
    await markCommitmentsCancelled(staleIds);
    logger.info({ count: staleIds.length }, "commitments: cancelled stale timed reminders");
  }

  // Fire due timed reminders (fire_at in (staleThreshold, now])
  const { data: dueData, error } = await supabaseAdmin
    .from("commitments")
    .select("*")
    .eq("status", "pending")
    .eq("kind", "timed")
    .gte("fire_at", staleThreshold.toISOString())
    .lte("fire_at", now.toISOString());

  if (error) {
    logger.warn({ error }, "commitments: fireTimedReminders query failed");
    return;
  }

  const excluded = opExcludedChatIds();
  const due = ((dueData ?? []) as Commitment[]).filter((c) => !excluded.has(c.chat_id));
  if (due.length === 0) return;

  // Group by fire_at minute (round to minute)
  const byMinute = new Map<string, Commitment[]>();
  for (const c of due) {
    // fire_at comes back from the shim as a Date (pg timestamptz) — normalise before slicing
    const minuteKey = new Date(c.fire_at).toISOString().slice(0, 16); // "YYYY-MM-DDTHH:MM"
    const group = byMinute.get(minuteKey) ?? [];
    group.push(c);
    byMinute.set(minuteKey, group);
  }

  for (const [minuteKey, group] of byMinute) {
    const lines = group.map((c) => {
      const timeLabel = c.due_time ? ` בשעה ${c.due_time.slice(0, 5)}` : "";
      return `• ${c.commitment_text}${timeLabel} — ${c.contact_name}`;
    });

    // Timed reminders fire ~1h before by design; each line shows the meeting time,
    // so a simple header avoids fragile relative-time math across timezones.
    const text = `⏰ תזכורת:\n${lines.join("\n")}`;
    const ok = await sendSelfMessage(text);
    if (ok) {
      await markCommitmentsSent(group.map((c) => c.id));
      logger.info({ count: group.length, fireAt: minuteKey }, "commitments: timed reminder sent");
    }
  }
}
