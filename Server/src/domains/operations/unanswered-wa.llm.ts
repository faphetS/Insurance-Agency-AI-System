import OpenAI from "openai";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { opCreds, getChatHistoryWith } from "../whatsapp/whatsapp.service.js";
import { israelLineLabel } from "../commitments/commitments.detector.js";

const MODEL = "google/gemini-2.5-flash";

const openai = new OpenAI({
  apiKey: env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

const SYSTEM_PROMPT = `You are triaging Didi's (an Israeli insurance agent) personal WhatsApp chats. The transcript below is the tail end of a 1:1 conversation; the trailing message(s) from the other side ("Lead") have sat unanswered by Didi for over an hour.

Decide whether the trailing Lead message actually requires a personal response from Didi.

Conversation closers and acknowledgements do NOT require a response — examples: "תודה", "תודה רבה", "אוקיי", "בסדר", "סבבה", "ok", "thanks", "thank you", a thumbs-up/pray emoji or an emoji-only reply, "good night".

Questions, requests, new information Didi would need to act on, or anything left hanging DO require a response.

The conversation may be in Hebrew, English, or mixed — read it in whatever language it's written.

Each line is prefixed with "[DD/MM HH:MM]" — the time it was sent, Asia/Jerusalem timezone — use it as context for recency and time-of-day.

Reply with strict JSON only, no markdown fences: {"needs_reply": true} or {"needs_reply": false}`;

function buildTranscript(chatId: string, history: { type: "incoming" | "outgoing"; textMessage?: string; timestamp: number }[]): string {
  const sorted = [...history].sort((a, b) => a.timestamp - b.timestamp);
  const lines = sorted
    .filter((m) => m.textMessage && m.textMessage.trim())
    .map((m) => `[${israelLineLabel(new Date(m.timestamp * 1000))}] ${m.type === "outgoing" ? "Didi" : "Lead"}: ${m.textMessage}`);
  return lines.length > 0 ? lines.join("\n") : `(no text messages found for ${chatId})`;
}

export async function needsReplyFromDidi(chatId: string): Promise<boolean> {
  try {
    const creds = opCreds();
    if (!creds) {
      logger.info({ chatId }, "unanswered-wa: op creds unset — failing open on LLM reply-need check");
      return true;
    }

    const history = await getChatHistoryWith(creds, chatId, 4);
    const transcript = buildTranscript(chatId, history);

    const resp = await openai.chat.completions.create(
      {
        model: MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: transcript },
        ],
        response_format: { type: "json_object" },
      },
      { timeout: 30_000 },
    );

    const raw = resp.choices[0]?.message?.content ?? "{}";
    const cleaned = raw.replace(/```json\n?|\n?```/g, "").trim();
    const parsed = JSON.parse(cleaned) as { needs_reply?: unknown };

    if (typeof parsed.needs_reply !== "boolean") return true;
    return parsed.needs_reply;
  } catch (err) {
    logger.warn({ err, chatId }, "unanswered-wa: LLM reply-need check failed — failing open (treat as needs reply)");
    return true;
  }
}
