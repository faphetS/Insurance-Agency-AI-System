import OpenAI from "openai";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { pool } from "../../lib/db.js";
import { COMMITMENT_EXTRACTION_SYSTEM_PROMPT } from "./commitments.prompts.js";
import { deriveKind, computeFireAt } from "./commitments.fireat.js";
import { isOpWeekday } from "../operations/op-hours.js";
import type { ChatTranscript, DetectedCommitment } from "./commitments.types.js";

const FALLBACK_MODEL = "google/gemini-2.5-flash";

const TZ = "Asia/Jerusalem";

const openai = new OpenAI({
  apiKey: env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

const LINE_LABEL_FORMAT = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function djb2(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
  }
  return hash >>> 0;
}

export function israelLineLabel(at: Date): string {
  const parts = LINE_LABEL_FORMAT.formatToParts(at).reduce<Record<string, string>>((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});

  // Intl reports midnight as hour "24" under hour12: false — normalize to "00"
  const hour = parts["hour"] === "24" ? "00" : parts["hour"];
  return `${parts["day"]}/${parts["month"]} ${hour}:${parts["minute"]}`;
}

export function israelNowString(d: Date): string {
  const datePart = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);
  const timeParts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .formatToParts(d)
    .reduce<Record<string, string>>((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});

  // Intl reports midnight as hour "24" under hour12: false — normalize to "00"
  const hour = timeParts["hour"] === "24" ? "00" : timeParts["hour"];
  return `${datePart} ${hour}:${timeParts["minute"]}`;
}

export function buildTranscriptString(transcript: ChatTranscript): string {
  const lines = transcript.lines.map((l) => {
    const label = l.fromDidi ? "Didi" : transcript.contactName;
    const time = israelLineLabel(new Date(l.ts * 1000));
    return `[${time}] ${label}: ${l.text}`;
  });

  return lines.join("\n");
}

async function callLlm(transcriptText: string): Promise<DetectedCommitment[]> {
  const model = env.COMMITMENT_AI_MODEL ?? FALLBACK_MODEL;

  const userContent = `Current time (Asia/Jerusalem): ${israelNowString(new Date())}
Each transcript line is prefixed [DD/MM HH:MM] — the moment it was sent, Asia/Jerusalem timezone, always within the 24 hours before the current time.

${transcriptText}`;

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: COMMITMENT_EXTRACTION_SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ];

  const requestParams: OpenAI.ChatCompletionCreateParamsNonStreaming = {
    model,
    messages,
    response_format: { type: "json_object" },
  };

  let raw: string;
  try {
    const resp = await openai.chat.completions.create(requestParams, { timeout: 30_000 });
    raw = resp.choices[0]?.message?.content ?? "{}";
  } catch (err) {
    if (model !== FALLBACK_MODEL) {
      logger.warn({ model, err }, "commitments: primary model failed — retrying with fallback");
      const resp = await openai.chat.completions.create(
        { ...requestParams, model: FALLBACK_MODEL },
        { timeout: 30_000 },
      );
      raw = resp.choices[0]?.message?.content ?? "{}";
    } else {
      throw err;
    }
  }

  const cleaned = raw.replace(/```json\n?|\n?```/g, "").trim();
  const parsed = JSON.parse(cleaned) as { commitments?: unknown[] };
  if (!Array.isArray(parsed.commitments)) return [];

  return parsed.commitments
    .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
    .map((c) => ({
      direction: c["who"] === "Didi" ? "outgoing" : "incoming",
      who: typeof c["who"] === "string" ? c["who"] : "",
      what: typeof c["what"] === "string" ? c["what"] : "",
      date: typeof c["date"] === "string" && c["date"] !== "null" ? c["date"] : null,
      time: typeof c["time"] === "string" && c["time"] !== "null" ? c["time"] : null,
    }));
}

export async function detectCommitments(transcripts: ChatTranscript[]): Promise<void> {
  for (const transcript of transcripts) {
    try {
      const transcriptText = buildTranscriptString(transcript);
      let detected: DetectedCommitment[] = [];

      try {
        detected = await callLlm(transcriptText);
      } catch (err) {
        logger.warn(
          { err, chatId: transcript.chatId },
          "commitments: LLM extraction failed for chat — skipping",
        );
        continue;
      }

      for (const d of detected) {
        if (!d.what.trim()) continue;

        const kind = deriveKind(d.date, d.time);

        // Use the latest message timestamp as the message reference for floating
        const messageTs = transcript.latestTs || Math.floor(Date.now() / 1000);
        const fireAt = computeFireAt(kind, d.date, d.time, messageTs);

        if (fireAt === null) {
          logger.info(
            { chatId: transcript.chatId, what: d.what },
            "commitments: early-morning appointment after clamp — skipping insert",
          );
          continue;
        }

        if (!isOpWeekday(fireAt)) {
          logger.info(
            { chatId: transcript.chatId, what: d.what, fireAt: fireAt.toISOString() },
            "commitments: weekend fire_at — skipping insert",
          );
          continue;
        }

        // Stable synthetic key when no real message ID available
        const sourceKey = `${transcript.chatId}:${djb2(d.what)}`;

        // Raw insert with ON CONFLICT matching the PARTIAL unique index on
        // source_message_id (WHERE source_message_id IS NOT NULL) — the shim's
        // upsert emits a bare ON CONFLICT (col) which Postgres can't infer to a
        // partial index (error 42P10). Dedup is per chat+commitment via sourceKey.
        try {
          await pool.query(
            `INSERT INTO public.commitments
               (chat_id, contact_name, direction, source_message_id, source_text,
                commitment_text, counterparty, due_date, due_time, kind, fire_at, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending')
             ON CONFLICT (source_message_id) WHERE source_message_id IS NOT NULL DO NOTHING`,
            [
              transcript.chatId,
              transcript.contactName,
              d.direction,
              sourceKey,
              transcriptText.slice(0, 500),
              d.what,
              d.who,
              d.date,
              d.time,
              kind,
              fireAt.toISOString(),
            ],
          );
        } catch (err) {
          logger.warn({ err, chatId: transcript.chatId }, "commitments: insert failed");
        }
      }
    } catch (err) {
      logger.warn({ err, chatId: transcript.chatId }, "commitments: error processing chat — continuing");
    }
  }
}
