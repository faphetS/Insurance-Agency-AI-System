import OpenAI from "openai";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { AppError } from "../../lib/errors.js";

const openai = new OpenAI({ apiKey: env.OPENROUTER_API_KEY, baseURL: "https://openrouter.ai/api/v1" });
const FALLBACK_MODEL = "google/gemini-2.5-flash";

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

export interface EmailMilestoneResult {
  milestone: "forms_sent" | "receipt_confirmed" | "policy_issued" | "deposit_made" | "none";
  clientName: string | null;
  idNumber: string | null;
  policyNumber: string | null;
  evidence: string | null;
  needsAction: boolean;
  actionSummary: string | null;
}

const EMAIL_MILESTONE_NULL: EmailMilestoneResult = {
  milestone: "none",
  clientName: null,
  idNumber: null,
  policyNumber: null,
  evidence: null,
  needsAction: false,
  actionSummary: null,
};

/**
 * Classifies an email as one of four post-meeting insurance milestones (Hebrew
 * agency↔insurer correspondence) or "none". Never throws.
 */
export async function classifyEmailMilestone(input: {
  subject: string;
  bodyText: string;
  direction: string;
}): Promise<EmailMilestoneResult> {
  const resolvedModel = env.AI_MODEL;

  const systemPrompt = `You are an insurance milestone classifier for an Israeli insurance agency.
The agency handles the full lifecycle for clients: after an initial meeting the agency sends forms to the insurer, the insurer acknowledges receipt, issues a policy, and eventually makes the first deposit.
You will receive the subject, body, and direction ("sent" = agency sent this email; "received" = agency received from insurer; "other" = unknown) of a single email.

Terminology note: PENSION/PROVIDENT products (קרן פנסיה / קופת גמל / קרן השתלמות) use ENROLLMENT terms — הצטרפות, עמית, מספר חשבון; LIFE & ELEMENTARY INSURANCE use POLICY terms — פוליסה, הצעת ביטוח, מספר פוליסה. Recognize both. These follow the Israeli Capital Market Authority standardized language (חוזר הצטרפות / מבנה אחיד).

Classify the email into exactly ONE of these milestones (or "none"):

1. "forms_sent"
   - The agency SENT enrollment/application forms (or an insurance proposal) to the insurer.
   - Direction is almost always "sent".
   - Hebrew signals: בקשת הצטרפות, טופס הצטרפות, טופס הצטרפות לקרן פנסיה (נספח א'), טופס הצטרפות לקופת גמל (נספח ב'), טופס הצטרפות לקרן השתלמות, הצעת ביטוח, הגשת טפסים, מצורפים טפסים, מצ"ב, ייפוי כוח, מסמכים מצורפים.

2. "receipt_confirmed"
   - The insurer/managing-company CONFIRMED it received/registered the request — the preliminary stage ("אישור ראשוני").
   - Direction is almost always "received".
   - Hebrew signals: אישור ראשוני, בקשת ההצטרפות מאושרת, קיבלנו, התקבלו, אישור קבלה, נקלט / נקלטה (במערכת), מספר בקשה, מסמכים נקלטו, הבקשה בטיפול.
   - NOTE: in real Israeli flows this stage often BLURS with issuance. If the email ALSO shows a final approval or a newly assigned policy/account number (milestone 3 signals), classify it as "policy_issued", not this.

3. "policy_issued"
   - The insurer ISSUED the policy / opened the pension fund — the final approval ("היזון חוזר מסכם").
   - Direction is almost always "received".
   - Hebrew signals — pension/provident: היזון חוזר מסכם, אישור על צירוף הלקוח, אישור החברה המנהלת לצירוף העמית, אישור הצטרפות, הצטרפות אושרה, מספר חשבון. Insurance: הופקה / הפקת פוליסה, פוליסה הופקה, מספר פוליסה, פוליסה חדשה, הסכם ביטוח.
   - A newly assigned account number (מספר חשבון) or policy number (מספר פוליסה) is a strong issuance signal.

4. "deposit_made"
   - The first premium/deposit was collected or confirmed.
   - Direction is almost always "received".
   - Hebrew signals (treat as a synonym cluster): הפקדה ראשונה, תשלום ראשון, קבלת תשלום, נגבתה, גבייה, פרמיה ראשונה, חיוב ראשון, ₪ + סכום.

5. "none"
   - Anything unrelated to these four milestones — marketing, general correspondence, internal admin, meeting scheduling, or a portal/clearinghouse status notice with no milestone content.

Additionally, extract (if present in the email):
- clientName: the full name of the insured client (Hebrew or transliterated)
- idNumber: Israeli ID number (תעודת זהות) — 9 digits
- policyNumber: policy or fund number (מספר פוליסה / מספר קרן)
- evidence: a short verbatim quote (≤120 chars) from the email body that is the strongest proof of your classification — null if milestone is "none"

Actionability (independent of milestone classification — a non-milestone email can still need action):
- needsAction: true when the email is an insurer/insurance email about a client that REQUIRES the agent to DO something — for example: חסר טופס, נדרשת השלמה, נדחתה הבקשה, ממתין לתשובתך, נדרש חתימה, or any explicit deadline. false for informational emails, automated confirmations, status notices, marketing, or non-insurance correspondence.
- actionSummary: a short Hebrew phrase (≤80 chars) describing what the agent needs to do — null when needsAction is false.

Respond ONLY with valid JSON, no markdown, no commentary:
{"milestone":"<value>","clientName":<string|null>,"idNumber":<string|null>,"policyNumber":<string|null>,"evidence":<string|null>,"needsAction":<bool>,"actionSummary":<string|null>}`;

  try {
    const userMessage = `Direction: ${input.direction}\nSubject: ${input.subject}\n\n${input.bodyText.slice(0, 3000)}`;

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];

    let raw: string;
    try {
      const response = await openai.chat.completions.create(
        { model: resolvedModel, messages },
        { timeout: 20_000 },
      );
      raw = response.choices[0]?.message?.content ?? "";
    } catch (err) {
      if (resolvedModel !== FALLBACK_MODEL) {
        logger.warn({ model: resolvedModel, err }, "classifyEmailMilestone: primary model failed — retrying with fallback");
        const response = await openai.chat.completions.create(
          { model: FALLBACK_MODEL, messages },
          { timeout: 20_000 },
        );
        raw = response.choices[0]?.message?.content ?? "";
      } else {
        throw err;
      }
    }

    const cleaned = raw.replace(/```json\n?|\n?```/g, "").trim();
    const parsed = JSON.parse(cleaned) as Partial<EmailMilestoneResult> & { needsAction?: unknown; actionSummary?: unknown };

    const validMilestones = ["forms_sent", "receipt_confirmed", "policy_issued", "deposit_made", "none"] as const;
    const milestone = validMilestones.includes(parsed.milestone as (typeof validMilestones)[number])
      ? (parsed.milestone as EmailMilestoneResult["milestone"])
      : "none";

    return {
      milestone,
      clientName: parsed.clientName ?? null,
      idNumber: parsed.idNumber ?? null,
      policyNumber: parsed.policyNumber ?? null,
      evidence: parsed.evidence ?? null,
      needsAction: parsed.needsAction === true,
      actionSummary: typeof parsed.actionSummary === "string" ? parsed.actionSummary.slice(0, 80) : null,
    };
  } catch (err) {
    logger.warn({ err, subject: input.subject }, "classifyEmailMilestone: failed — returning none");
    return EMAIL_MILESTONE_NULL;
  }
}

const ID_NUMBER_RE = /^\d{8,9}$/;

/**
 * Single vision pass that both validates the ID photo AND extracts the
 * Israeli national ID number (תעודת זהות). Returns validity + idNumber so
 * the caller does not need a second LLM call.
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
    'Also extract the 9-digit Israeli national ID number (תעודת זהות / ת"ז) if visible — it is a sequence of exactly 8 or 9 digits. ' +
    'Respond ONLY with JSON: ' +
    '{"valid": true, "reason": "<short explanation IN HEBREW>", "idNumber": "<9-digit number or null>"} ' +
    'or {"valid": false, "reason": "<short explanation IN HEBREW>", "idNumber": null}. ' +
    'The "reason" value MUST be in Hebrew with gender-neutral phrasing (use infinitives like לשלוח, impersonal forms like נדרש, avoid אתה/את). ' +
    '"idNumber" must be the raw digit string only, no spaces or dashes, or null if not found/readable.';

  const raw = await analyzeImage(imageUrl, prompt);
  try {
    const cleaned = raw.replace(/```json\n?|\n?```/g, "").trim();
    const parsed = JSON.parse(cleaned) as { valid?: boolean; reason?: string; idNumber?: string | null };
    const rawId = typeof parsed.idNumber === "string" ? parsed.idNumber.replace(/\D/g, "") : null;
    const idNumber = rawId && ID_NUMBER_RE.test(rawId) ? rawId : null;
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
    logger.error({ err }, "OpenRouter chat completion failed");
    throw new AppError(502, "AI model failed to analyze image", "AI_ERROR");
  }
}
