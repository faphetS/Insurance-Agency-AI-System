import OpenAI from "openai";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { supabaseAdmin } from "../../config/supabase.js";
import { COMMITMENT_EXTRACTION_SYSTEM_PROMPT } from "./commitments.prompts.js";
import { deriveKind, computeFireAt } from "./commitments.fireat.js";
import type { ChatTranscript, DetectedCommitment } from "./commitments.types.js";

const FALLBACK_MODEL = "google/gemini-2.5-flash";

const openai = new OpenAI({
  apiKey: env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

function djb2(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
  }
  return hash >>> 0;
}

function buildTranscriptString(transcript: ChatTranscript): { text: string; conversationDate: string } {
  const firstTs = transcript.lines[0]?.ts ?? Math.floor(Date.now() / 1000);
  const conversationDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(
    new Date(firstTs * 1000),
  );

  const lines = transcript.lines.map((l) => {
    const label = l.fromDidi ? "Didi" : transcript.contactName;
    const time = new Date(l.ts * 1000).toISOString().slice(11, 16);
    return `[${time}] ${label}: ${l.text}`;
  });

  return { text: lines.join("\n"), conversationDate };
}

async function callLlm(prompt: string, conversationDate: string): Promise<DetectedCommitment[]> {
  const model = env.COMMITMENT_AI_MODEL ?? FALLBACK_MODEL;

  const userContent = `Conversation date (Asia/Jerusalem): ${conversationDate}\n\n${prompt}`;

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
      const { text: transcriptText, conversationDate } = buildTranscriptString(transcript);
      let detected: DetectedCommitment[] = [];

      try {
        detected = await callLlm(transcriptText, conversationDate);
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

        // Stable synthetic key when no real message ID available
        const sourceKey = `${transcript.chatId}:${djb2(d.what)}`;

        const row = {
          chat_id: transcript.chatId,
          contact_name: transcript.contactName,
          direction: d.direction,
          source_message_id: sourceKey,
          source_text: transcriptText.slice(0, 500),
          commitment_text: d.what,
          counterparty: d.who,
          due_date: d.date,
          due_time: d.time,
          kind,
          fire_at: fireAt.toISOString(),
          status: "pending",
          updated_at: new Date().toISOString(),
        };

        const { error } = await supabaseAdmin
          .from("commitments")
          .upsert(row, { onConflict: "source_message_id", ignoreDuplicates: true });

        if (error) {
          logger.warn({ error, chatId: transcript.chatId }, "commitments: upsert failed");
        }
      }
    } catch (err) {
      logger.warn({ err, chatId: transcript.chatId }, "commitments: error processing chat — continuing");
    }
  }
}
