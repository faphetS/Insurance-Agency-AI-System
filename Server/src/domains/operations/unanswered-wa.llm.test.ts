import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be hoisted before any imports that trigger module eval
// ---------------------------------------------------------------------------

const { mockCreate, mockOpCreds, mockGetChatHistoryWith } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockOpCreds: vi.fn(),
  mockGetChatHistoryWith: vi.fn(),
}));

vi.mock("../../config/env.js", () => ({
  env: { OPENROUTER_API_KEY: "test-key" },
}));

vi.mock("../../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("openai", () => {
  function OpenAIMock(this: Record<string, unknown>) {
    this["chat"] = { completions: { create: mockCreate } };
  }
  return { default: OpenAIMock };
});

vi.mock("../whatsapp/whatsapp.service.js", () => ({
  opCreds: mockOpCreds,
  getChatHistoryWith: mockGetChatHistoryWith,
}));

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

import { needsReplyFromDidi } from "./unanswered-wa.llm.js";

const CREDS = { idInstance: "op-id", token: "op-token", baseUrl: "https://test.api.greenapi.com" };

function makeCompletion(content: string) {
  return { choices: [{ message: { content } }] };
}

describe("needsReplyFromDidi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOpCreds.mockReturnValue(CREDS);
    mockGetChatHistoryWith.mockResolvedValue([
      { type: "incoming", textMessage: "היי דידי, אפשר לשאול משהו?", timestamp: 1000 },
      { type: "outgoing", textMessage: "כן בטח", timestamp: 900 },
    ]);
  });

  it("fails open (true) when opCreds() is unset", async () => {
    mockOpCreds.mockReturnValue(null);

    const result = await needsReplyFromDidi("972501111111@c.us");

    expect(result).toBe(true);
    expect(mockGetChatHistoryWith).not.toHaveBeenCalled();
  });

  it("returns false when the LLM judges the trailing message a closer", async () => {
    mockCreate.mockResolvedValue(makeCompletion(JSON.stringify({ needs_reply: false })));

    const result = await needsReplyFromDidi("972501111111@c.us");

    expect(result).toBe(false);
    expect(mockGetChatHistoryWith).toHaveBeenCalledWith(CREDS, "972501111111@c.us", 4);
  });

  it("returns true when the LLM judges the trailing message needs a reply", async () => {
    mockCreate.mockResolvedValue(makeCompletion(JSON.stringify({ needs_reply: true })));

    const result = await needsReplyFromDidi("972501111111@c.us");

    expect(result).toBe(true);
  });

  it("fails open (true) when the history fetch throws", async () => {
    mockGetChatHistoryWith.mockRejectedValue(new Error("network down"));

    const result = await needsReplyFromDidi("972501111111@c.us");

    expect(result).toBe(true);
  });

  it("fails open (true) when the LLM call throws", async () => {
    mockCreate.mockRejectedValue(new Error("timeout"));

    const result = await needsReplyFromDidi("972501111111@c.us");

    expect(result).toBe(true);
  });

  it("fails open (true) when the LLM response isn't valid JSON", async () => {
    mockCreate.mockResolvedValue(makeCompletion("not json"));

    const result = await needsReplyFromDidi("972501111111@c.us");

    expect(result).toBe(true);
  });

  it("fails open (true) when needs_reply isn't a boolean", async () => {
    mockCreate.mockResolvedValue(makeCompletion(JSON.stringify({ needs_reply: "yes" })));

    const result = await needsReplyFromDidi("972501111111@c.us");

    expect(result).toBe(true);
  });
});
