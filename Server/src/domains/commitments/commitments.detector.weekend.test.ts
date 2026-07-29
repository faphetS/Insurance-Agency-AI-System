import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock functions
// ---------------------------------------------------------------------------
const { mockCreate, mockPoolQuery } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockPoolQuery: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks — declared before project imports
// ---------------------------------------------------------------------------
vi.mock("openai", () => {
  function OpenAIMock(this: Record<string, unknown>) {
    this["chat"] = { completions: { create: mockCreate } };
  }
  return { default: OpenAIMock };
});

vi.mock("../../config/env.js", () => ({
  env: {
    NODE_ENV: "test",
    OPENROUTER_API_KEY: "test-key",
    COMMITMENT_AI_MODEL: "google/gemini-3.1-flash-lite",
  },
}));

vi.mock("../../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../lib/db.js", () => ({
  pool: { query: mockPoolQuery },
}));

// ---------------------------------------------------------------------------
// Subject import (after mocks)
// ---------------------------------------------------------------------------
import { detectCommitments } from "./commitments.detector.js";
import type { ChatTranscript } from "./commitments.types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTranscript(): ChatTranscript {
  const ts = Math.floor(Date.now() / 1000);
  return {
    chatId: "972501111111@c.us",
    contactName: "יוסי",
    latestTs: ts,
    lines: [{ ts, fromDidi: false, text: "hi" }],
  };
}

function mockLlmResponse(commitments: unknown[]): void {
  mockCreate.mockResolvedValue({
    choices: [{ message: { content: JSON.stringify({ commitments }) } }],
  });
}

// ---------------------------------------------------------------------------
// F1 (write-side) — weekend fire_at dropped at detection
// ---------------------------------------------------------------------------

describe("detectCommitments — weekend fire_at dropped at insertion (F1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPoolQuery.mockResolvedValue({ rows: [] });
  });

  it("skips insertion when the derived date_only fire_at lands on Saturday", async () => {
    // 2026-08-01 is a Saturday.
    mockLlmResponse([{ who: "Didi", what: "לשלוח מסמך", date: "2026-08-01", time: null }]);

    await detectCommitments([makeTranscript()]);

    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it("inserts normally when the derived date_only fire_at lands on a weekday", async () => {
    // 2026-07-28 is a Tuesday.
    mockLlmResponse([{ who: "Didi", what: "לשלוח מסמך", date: "2026-07-28", time: null }]);

    await detectCommitments([makeTranscript()]);

    expect(mockPoolQuery).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// F3 — early-morning appointment (clamp lands at/after the meeting) skipped
// ---------------------------------------------------------------------------

describe("detectCommitments — early-morning appointment skipped (F3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPoolQuery.mockResolvedValue({ rows: [] });
  });

  it("skips insertion for an 08:00 appointment (clamped fire_at 09:00 is at/after the meeting)", async () => {
    // 2026-07-28 is a Tuesday.
    mockLlmResponse([{ who: "Didi", what: "פגישה", date: "2026-07-28", time: "08:00" }]);

    await detectCommitments([makeTranscript()]);

    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it("inserts normally for a mid-day timed appointment", async () => {
    mockLlmResponse([{ who: "Didi", what: "פגישה", date: "2026-07-28", time: "15:00" }]);

    await detectCommitments([makeTranscript()]);

    expect(mockPoolQuery).toHaveBeenCalledOnce();
  });
});
