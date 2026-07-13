import OpenAI from "openai";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { AppError } from "../../lib/errors.js";

const openai = new OpenAI({ apiKey: env.OPENROUTER_API_KEY, baseURL: "https://openrouter.ai/api/v1" });
const FALLBACK_MODEL = env.AI_FALLBACK_MODEL;

export function isHebrew(text: string): boolean {
  if (!text || !text.trim()) return false;
  const hebrew = (text.match(/[ְ-׿]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  return hebrew > 0 && hebrew >= latin;
}

export async function ensureHebrew(text: string): Promise<string> {
  if (isHebrew(text)) return text;
  const systemPrompt =
    "Translate the following meeting summary to natural Hebrew. " +
    "Preserve the structure, line breaks, and bullet points exactly. " +
    "Output ONLY the Hebrew translation with no preamble, explanation, or additional text.";
  return generateReply([{ role: "user", text }], systemPrompt, "google/gemini-2.5-flash");
}

export interface ChatTurn {
  role: "user" | "model";
  text: string;
}

export async function generateReply(
  history: ChatTurn[],
  systemPrompt: string,
  model?: string,
): Promise<string> {
  const resolvedModel = model || env.AI_MODEL;

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...history.map((t) => ({
      role: (t.role === "model" ? "assistant" : "user") as "assistant" | "user",
      content: t.text,
    })),
  ];

  try {
    const response = await openai.chat.completions.create(
      { model: resolvedModel, messages },
      { timeout: 30_000 },
    );
    const text = response.choices[0]?.message?.content ?? "";
    logger.debug({ model: resolvedModel, chars: text.length }, "AI reply generated");
    return text;
  } catch (err) {
    if (resolvedModel !== FALLBACK_MODEL) {
      logger.warn({ model: resolvedModel, err }, "Primary model failed — retrying with fallback");
      const response = await openai.chat.completions.create(
        { model: FALLBACK_MODEL, messages },
        { timeout: 30_000 },
      );
      const text = response.choices[0]?.message?.content ?? "";
      logger.debug({ model: FALLBACK_MODEL, chars: text.length }, "AI reply generated (fallback)");
      return text;
    }
    logger.error({ err }, "OpenRouter chat completion failed");
    throw new AppError(502, "AI model failed to generate a reply", "AI_ERROR");
  }
}

const ID_PLAUSIBLE_RE = /^[A-Z0-9-]{5,30}$/;

function normalizeIdNumber(raw: string): string | null {
  const normalized = raw.trim().toUpperCase().replace(/\s+/g, "");
  if (!ID_PLAUSIBLE_RE.test(normalized)) return null;
  const digitCount = (normalized.match(/\d/g) ?? []).length;
  if (digitCount < 2) return null;
  return normalized;
}

/**
 * Single vision pass that validates the ID photo AND extracts the document's
 * primary ID number plus the printed full name. Strict: the photo must show
 * BOTH the Israeli תעודת זהות AND its ספח (appendix) — the model reports each
 * part as its own boolean (hasIdCard, hasAppendix), which are logged by the
 * caller for rollout diagnostics; valid is DERIVED in code as
 * hasIdCard && hasAppendix.
 */
export async function validateIdPhoto(imageUrl: string): Promise<{
  valid: boolean;
  hasIdCard: boolean;
  hasAppendix: boolean;
  idNumber: string | null;
  fullName: string | null;
}> {
  const prompt =
    'Look at this image of an Israeli identity document. ' +
    'Report two things: ' +
    '(1) hasIdCard — is the תעודת זהות itself visible? i.e. the biometric smart ID card, ' +
    'or the main identity page of the ID booklet (holder\'s photo, name, ID number). ' +
    '(2) hasAppendix — is its ספח visible? i.e. the appendix/attachment page headed "ספח לתעודת זהות" ' +
    'that lists the holder\'s personal and family details. ' +
    'Judge only whether each part is visible — do NOT judge authenticity or expiration. ' +
    'Be tolerant of slight blur, glare or angle as long as a part stays identifiable; ' +
    'if a part is not present at all, its flag is false. ' +
    'Also extract the holder\'s 8–9 digit ת"ז number exactly as printed (appears on both the card and the ספח); ' +
    'omit spaces; idNumber=null if unreadable. ' +
    'Extract the holder\'s full name exactly as printed; prefer the Hebrew form if both Hebrew and Latin appear; ' +
    'fullName=null if unreadable. ' +
    'Respond ONLY with JSON: ' +
    '{"hasIdCard": true|false, "hasAppendix": true|false, "idNumber": "<number or null>", "fullName": "<name or null>"}. ' +
    'idNumber must be the exact digit sequence with no surrounding spaces, or null.';

  const raw = await analyzeImage(imageUrl, prompt);
  try {
    const cleaned = raw.replace(/```json\n?|\n?```/g, "").trim();
    const parsed = JSON.parse(cleaned) as {
      hasIdCard?: boolean;
      hasAppendix?: boolean;
      idNumber?: string | null;
      fullName?: string | null;
    };
    const hasIdCard = parsed.hasIdCard === true;
    const hasAppendix = parsed.hasAppendix === true;
    const idNumber = typeof parsed.idNumber === "string" ? normalizeIdNumber(parsed.idNumber) : null;
    let fullName: string | null = null;
    if (typeof parsed.fullName === "string") {
      const cleanedName = parsed.fullName.replace(/\s+/g, " ").trim();
      fullName = cleanedName.length >= 2 ? cleanedName : null;
    }
    return {
      valid: hasIdCard && hasAppendix,
      hasIdCard,
      hasAppendix,
      idNumber,
      fullName,
    };
  } catch {
    return { valid: false, hasIdCard: false, hasAppendix: false, idNumber: null, fullName: null };
  }
}

export async function analyzeImage(
  imageUrl: string,
  prompt: string,
  model?: string,
): Promise<string> {
  const resolvedModel = model || env.AI_MODEL;

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    {
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: imageUrl } },
      ],
    },
  ];

  try {
    const response = await openai.chat.completions.create(
      { model: resolvedModel, messages },
      { timeout: 30_000 },
    );
    const text = response.choices[0]?.message?.content ?? "";
    logger.debug({ model: resolvedModel, chars: text.length }, "AI image analysis complete");
    return text;
  } catch (err) {
    if (resolvedModel !== FALLBACK_MODEL) {
      logger.warn({ model: resolvedModel, err }, "Image analysis primary model failed — retrying with fallback");
      const response = await openai.chat.completions.create(
        { model: FALLBACK_MODEL, messages },
        { timeout: 30_000 },
      );
      const text = response.choices[0]?.message?.content ?? "";
      logger.debug({ model: FALLBACK_MODEL, chars: text.length }, "AI image analysis complete (fallback)");
      return text;
    }
    logger.error({ err }, "OpenRouter chat completion failed");
    throw new AppError(502, "AI model failed to analyze image", "AI_ERROR");
  }
}
