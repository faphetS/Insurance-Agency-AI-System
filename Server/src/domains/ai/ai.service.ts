import OpenAI from "openai";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { AppError } from "../../lib/errors.js";

const openai = new OpenAI({ apiKey: env.OPENROUTER_API_KEY, baseURL: "https://openrouter.ai/api/v1" });

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
    const response = await openai.chat.completions.create({ model: resolvedModel, messages });
    const text = response.choices[0]?.message?.content ?? "";
    logger.debug({ model: resolvedModel, chars: text.length }, "AI reply generated");
    return text;
  } catch (err) {
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
- "skip" → {"valid":true,"extracted":"skip"}
- "I don't have one" → {"valid":true,"extracted":"skip"}
- "what is this for" → {"valid":false}

Examples for an "insurance type" question:
- "health" → {"valid":true,"extracted":"health"}
- "I need car insurance" → {"valid":true,"extracted":"vehicle"}
- "what types do you have" → {"valid":false}
- "life insurance" → {"valid":true,"extracted":"life"}

Respond ONLY with the JSON object, nothing else.`;

  try {
    const response = await openai.chat.completions.create({
      model: resolvedModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
    });

    const raw = response.choices[0]?.message?.content ?? "";
    const cleaned = raw.replace(/```json\n?|\n?```/g, "").trim();
    const parsed = JSON.parse(cleaned) as { valid: boolean; extracted?: string };

    if (parsed.valid && parsed.extracted) {
      return { valid: true, extracted: parsed.extracted };
    }
    return { valid: false };
  } catch (err) {
    logger.warn({ err, slotName, userMessage }, "classifyIntakeResponse failed — falling back to accept");
    return { valid: true, extracted: userMessage };
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
    const response = await openai.chat.completions.create({ model: resolvedModel, messages });
    const text = response.choices[0]?.message?.content ?? "";
    logger.debug({ model: resolvedModel, chars: text.length }, "AI image analysis complete");
    return text;
  } catch (err) {
    logger.error({ err }, "OpenRouter chat completion failed");
    throw new AppError(502, "AI model failed to analyze image", "AI_ERROR");
  }
}
