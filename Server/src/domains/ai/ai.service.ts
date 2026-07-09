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
 * primary ID number plus the printed full name. Lenient: any readable
 * government-issued identity document passes; the ספח (appendix) is welcome
 * but its absence must NOT cause invalid. Supports Israeli ת"ז (8–9 digits)
 * and foreign IDs/passports that may be alphanumeric with dashes.
 */
export async function validateIdPhoto(imageUrl: string): Promise<{
  valid: boolean;
  reason: string;
  idNumber: string | null;
  fullName: string | null;
}> {
  const prompt =
    'Does this image plausibly show a government-issued identity document ' +
    '(passport, driver\'s license, national ID card, Israeli ת"ז, etc.)? ' +
    'Be LENIENT: if it plausibly shows any readable government ID, mark it valid. ' +
    'Do NOT judge authenticity or check expiration dates. ' +
    'The ספח (appendix page) is welcome but its ABSENCE must NOT make the document invalid. ' +
    'Also extract the document\'s primary ID/document number exactly as printed — ' +
    'for an Israeli ID that is the 8–9 digit ת"ז number; for a foreign ID it may include letters and dashes. ' +
    'Omit surrounding spaces. Set idNumber to null only if no ID number is readable. ' +
    'Also extract the full name of the document holder exactly as printed; ' +
    'if the name appears in both Hebrew and Latin scripts, prefer the Hebrew name. ' +
    'Set fullName to null if no name is readable. ' +
    'Respond ONLY with JSON: ' +
    '{"valid": true, "reason": "<short explanation IN HEBREW>", "idNumber": "<document number or null>", "fullName": "<name or null>"} ' +
    'or {"valid": false, "reason": "<short explanation IN HEBREW>", "idNumber": null, "fullName": null}. ' +
    'The "reason" value MUST be in Hebrew with gender-neutral phrasing (use infinitives like לשלוח, impersonal forms like נדרש, avoid אתה/את). ' +
    '"idNumber" must be the exact character sequence of the ID number (letters, digits, dashes — no surrounding spaces), or null if not found/readable.';

  const raw = await analyzeImage(imageUrl, prompt);
  try {
    const cleaned = raw.replace(/```json\n?|\n?```/g, "").trim();
    const parsed = JSON.parse(cleaned) as {
      valid?: boolean;
      reason?: string;
      idNumber?: string | null;
      fullName?: string | null;
    };
    const idNumber = typeof parsed.idNumber === "string" ? normalizeIdNumber(parsed.idNumber) : null;
    let fullName: string | null = null;
    if (typeof parsed.fullName === "string") {
      const cleanedName = parsed.fullName.replace(/\s+/g, " ").trim();
      fullName = cleanedName.length >= 2 ? cleanedName : null;
    }
    return {
      valid: parsed.valid === true,
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
      idNumber,
      fullName,
    };
  } catch {
    return { valid: false, reason: "שגיאה בעיבוד תשובת המודל", idNumber: null, fullName: null };
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
