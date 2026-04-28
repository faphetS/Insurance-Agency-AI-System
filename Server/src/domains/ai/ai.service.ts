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
