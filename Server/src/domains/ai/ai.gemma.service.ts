import { GoogleGenAI } from "@google/genai";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { AppError } from "../../lib/errors.js";

const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

export interface ChatTurn {
  role: "user" | "model";
  text: string;
}

export async function generateReply(
  history: ChatTurn[],
  systemPrompt: string,
): Promise<string> {
  const contents = history.map((t) => ({
    role: t.role,
    parts: [{ text: t.text }],
  }));

  try {
    const response = await ai.models.generateContent({
      model: env.GEMMA_MODEL,
      contents,
      config: { systemInstruction: systemPrompt },
    });

    const text = response.text ?? "";
    logger.debug({ model: env.GEMMA_MODEL, chars: text.length }, "Gemma reply generated");
    return text;
  } catch (err) {
    logger.error({ err }, "Gemma generateContent failed");
    throw new AppError(502, "AI model failed to generate a reply", "AI_ERROR");
  }
}
