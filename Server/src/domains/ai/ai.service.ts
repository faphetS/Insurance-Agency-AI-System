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

/**
 * Ask the LLM whether a user's message is a valid response to an intake
 * question, or if it's off-topic / conversational. Returns the extracted
 * value on success, or null if the message doesn't answer the question.
 */
export async function classifyIntakeResponse(
  userMessage: string,
  slotName: string,
  slotQuestion: string,
  validationHint: string,
): Promise<{ valid: true; extracted: string } | { valid: false }> {
  const resolvedModel = env.AI_MODEL;

  const systemPrompt = `You are a strict intake form validator for an insurance agency WhatsApp bot.
The bot just asked the customer: "${slotQuestion}"
The expected answer type is: ${validationHint}

The customer replied: "${userMessage}"

Decide if the customer's reply is a valid answer to the question.
- If it IS a valid answer, respond ONLY with JSON: {"valid":true,"extracted":"<the extracted value>"}
- If it is NOT a valid answer (greeting, question, off-topic, gibberish, etc.), respond ONLY with JSON: {"valid":false}

Examples for a "full name" question:
- "John Doe" → {"valid":true,"extracted":"John Doe"}
- "who are you" → {"valid":false}
- "hey" → {"valid":false}
- "María García" → {"valid":true,"extracted":"María García"}

Examples for an "email" question:
- "test@gmail.com" → {"valid":true,"extracted":"test@gmail.com"}
- "skip" → {"valid":false}
- "I don't have one" → {"valid":false}
- "what is this for" → {"valid":false}

Examples for an "insurance type" question:
- "health" → {"valid":true,"extracted":"health"}
- "I need car insurance" → {"valid":true,"extracted":"vehicle"}
- "what types do you have" → {"valid":false}
- "life insurance" → {"valid":true,"extracted":"life"}

Respond ONLY with the JSON object, nothing else.`;

  try {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];

    let raw: string;
    try {
      const response = await openai.chat.completions.create(
        { model: resolvedModel, messages },
        { timeout: 15_000 },
      );
      raw = response.choices[0]?.message?.content ?? "";
    } catch (err) {
      if (resolvedModel !== FALLBACK_MODEL) {
        logger.warn({ model: resolvedModel, err }, "Primary model failed — retrying with fallback");
        const response = await openai.chat.completions.create(
          { model: FALLBACK_MODEL, messages },
          { timeout: 15_000 },
        );
        raw = response.choices[0]?.message?.content ?? "";
      } else {
        throw err;
      }
    }

    const cleaned = raw.replace(/```json\n?|\n?```/g, "").trim();
    const parsed = JSON.parse(cleaned) as { valid: boolean; extracted?: string };

    if (parsed.valid && parsed.extracted) {
      return { valid: true, extracted: parsed.extracted };
    }
    return { valid: false };
  } catch (err) {
    logger.warn({ err, slotName, userMessage }, "classifyIntakeResponse failed — rejecting to re-prompt");
    return { valid: false };
  }
}

/**
 * Classify whether an intake case is 'simple' or 'complex' based on the
 * inquiry type and any gathered details. Never throws — defaults to 'simple'.
 */
export async function classifyComplexity(
  inquiryType: string,
  details: Record<string, string | null | undefined>,
): Promise<"simple" | "complex"> {
  const resolvedModel = env.AI_MODEL;

  const detailLines = Object.entries(details)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

  const systemPrompt = `You are a case-complexity screener for an insurance agency.
Given the inquiry type and client details, decide whether this is a 'simple' or 'complex' case.

Consider a case COMPLEX if any of the following apply:
- Inquiry type involves health, life, or pension insurance (these often require medical underwriting)
- Client has indicated multiple insurance types
- POA (power of attorney) was provided (suggests the client is acting on behalf of another)
- Multiple products or cross-insurance checks are likely needed

Consider a case SIMPLE if it is a straightforward single-product inquiry (vehicle, home/property, travel).

Inquiry type: ${inquiryType}
Client details:
${detailLines || "(none)"}

Respond ONLY with JSON: {"complexity": "simple"} or {"complexity": "complex"}`;

  try {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: "Classify this case." },
    ];

    let raw: string;
    try {
      const response = await openai.chat.completions.create(
        { model: resolvedModel, messages },
        { timeout: 15_000 },
      );
      raw = response.choices[0]?.message?.content ?? "";
    } catch (err) {
      if (resolvedModel !== FALLBACK_MODEL) {
        logger.warn({ model: resolvedModel, err }, "classifyComplexity: primary model failed — retrying with fallback");
        const response = await openai.chat.completions.create(
          { model: FALLBACK_MODEL, messages },
          { timeout: 15_000 },
        );
        raw = response.choices[0]?.message?.content ?? "";
      } else {
        throw err;
      }
    }

    const cleaned = raw.replace(/```json\n?|\n?```/g, "").trim();
    const parsed = JSON.parse(cleaned) as { complexity?: string };
    if (parsed.complexity === "complex") return "complex";
    return "simple";
  } catch (err) {
    logger.warn({ err, inquiryType }, "classifyComplexity: failed — defaulting to simple");
    return "simple";
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
 * Single vision pass that both validates the ID photo AND extracts the
 * document's primary ID number. Supports Israeli ת"ז (8–9 digits) and
 * foreign IDs/passports that may be alphanumeric with dashes.
 * Returns validity + idNumber so the caller does not need a second LLM call.
 */
export async function validateIdPhoto(imageUrl: string): Promise<{
  valid: boolean;
  reason: string;
  idNumber: string | null;
}> {
  const prompt =
    'Is this a government-issued ID document (passport, driver\'s license, national ID card, etc.)? ' +
    'Only check that the image shows an ID document and is readable. ' +
    'Do NOT judge authenticity or check expiration dates. ' +
    'Also extract the document\'s primary ID/document number exactly as printed — ' +
    'for an Israeli ID that is the 8–9 digit ת"ז number; for a foreign ID it may include letters and dashes. ' +
    'Omit surrounding spaces. Return null only if no ID number is readable. ' +
    'Respond ONLY with JSON: ' +
    '{"valid": true, "reason": "<short explanation IN HEBREW>", "idNumber": "<document number or null>"} ' +
    'or {"valid": false, "reason": "<short explanation IN HEBREW>", "idNumber": null}. ' +
    'The "reason" value MUST be in Hebrew with gender-neutral phrasing (use infinitives like לשלוח, impersonal forms like נדרש, avoid אתה/את). ' +
    '"idNumber" must be the exact character sequence of the ID number (letters, digits, dashes — no surrounding spaces), or null if not found/readable.';

  const raw = await analyzeImage(imageUrl, prompt);
  try {
    const cleaned = raw.replace(/```json\n?|\n?```/g, "").trim();
    const parsed = JSON.parse(cleaned) as { valid?: boolean; reason?: string; idNumber?: string | null };
    const idNumber = typeof parsed.idNumber === "string" ? normalizeIdNumber(parsed.idNumber) : null;
    return {
      valid: parsed.valid === true,
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
      idNumber,
    };
  } catch {
    return { valid: false, reason: "שגיאה בעיבוד תשובת המודל", idNumber: null };
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
