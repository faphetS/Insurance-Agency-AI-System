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

describe("buildTranscript (via needsReplyFromDidi's user message)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOpCreds.mockReturnValue(CREDS);
    mockCreate.mockResolvedValue(makeCompletion(JSON.stringify({ needs_reply: true })));
  });

  function transcriptSentToLlm(): string {
    const call = mockCreate.mock.calls[0] as [{ messages: { role: string; content: string }[] }];
    const userMessage = call[0].messages.find((m) => m.role === "user");
    return userMessage?.content ?? "";
  }

  it("renders media placeholders for voice, image, and document messages", async () => {
    mockGetChatHistoryWith.mockResolvedValue([
      { type: "incoming", typeMessage: "audioMessage", timestamp: 1000 },
      { type: "incoming", typeMessage: "imageMessage", timestamp: 1001 },
      { type: "incoming", typeMessage: "documentMessage", timestamp: 1002 },
    ]);

    await needsReplyFromDidi("972501111111@c.us");

    const transcript = transcriptSentToLlm();
    expect(transcript).toContain("[voice message]");
    expect(transcript).toContain("[image]");
    expect(transcript).toContain("[document]");
  });

  it("skips reaction messages entirely", async () => {
    mockGetChatHistoryWith.mockResolvedValue([
      { type: "incoming", textMessage: "היי דידי", timestamp: 1000 },
      { type: "outgoing", typeMessage: "reactionMessage", timestamp: 1001 },
    ]);

    await needsReplyFromDidi("972501111111@c.us");

    const transcript = transcriptSentToLlm();
    expect(transcript).toContain("היי דידי");
    expect(transcript).not.toContain("reactionMessage");
    expect(transcript.split("\n")).toHaveLength(1);
  });

  it("prefers text content over a media placeholder when both are present", async () => {
    mockGetChatHistoryWith.mockResolvedValue([
      { type: "incoming", typeMessage: "imageMessage", textMessage: "תראה את זה", timestamp: 1000 },
    ]);

    await needsReplyFromDidi("972501111111@c.us");

    const transcript = transcriptSentToLlm();
    expect(transcript).toContain("תראה את זה");
    expect(transcript).not.toContain("[image]");
  });

  it("falls back to a generic placeholder for an unrecognized typeMessage", async () => {
    mockGetChatHistoryWith.mockResolvedValue([{ type: "incoming", typeMessage: "locationMessage", timestamp: 1000 }]);

    await needsReplyFromDidi("972501111111@c.us");

    const transcript = transcriptSentToLlm();
    expect(transcript).toContain("[message]");
  });
});
