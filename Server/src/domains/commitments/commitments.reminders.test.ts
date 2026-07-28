import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock functions
// ---------------------------------------------------------------------------
const { mockFromImpl, mockNotifyOwnerOps, mockCreate } = vi.hoisted(() => ({
  mockFromImpl: vi.fn(),
  mockNotifyOwnerOps: vi.fn(),
  mockCreate: vi.fn(),
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
    OP_EXCLUDED_PHONES: [] as string[],
  },
}));

vi.mock("../../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../config/supabase.js", () => ({
  supabaseAdmin: { from: mockFromImpl },
}));

vi.mock("../operations/owner-notify.js", () => ({
  notifyOwnerOps: mockNotifyOwnerOps,
}));

// ---------------------------------------------------------------------------
// Subject import (after mocks)
// ---------------------------------------------------------------------------
import { buildMorningCommitmentSection, fireTimedReminders } from "./commitments.reminders.js";
import type { Commitment } from "./commitments.types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCommitmentsBuilder(result: unknown) {
  const b: Record<string, unknown> = {};
  const chainMethods = ["select", "eq", "in", "lte", "gte", "lt"];
  for (const m of chainMethods) b[m] = vi.fn().mockReturnValue(b);
  b["then"] = (resolve: (v: unknown) => void) => Promise.resolve(result).then(resolve);
  return b;
}

const EXCLUDED = { chat_id: "972508946380@c.us", id: "c-excluded" };
const INCLUDED = { chat_id: "972501111111@c.us", id: "c-included" };

function makeCommitment(overrides: Partial<Commitment>): Commitment {
  return {
    id: "id",
    chat_id: "chat",
    contact_name: "Contact",
    direction: "incoming",
    source_message_id: "msg",
    source_text: "text",
    commitment_text: "commitment",
    counterparty: "Counterparty",
    due_date: null,
    due_time: null,
    kind: "floating",
    fire_at: new Date().toISOString(),
    status: "pending",
    sent_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("buildMorningCommitmentSection — OP_EXCLUDED_PHONES", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { env } = await import("../../config/env.js");
    (env as Record<string, unknown>)["OP_EXCLUDED_PHONES"] = [];
  });

  it("drops commitments whose chat_id is in OP_EXCLUDED_PHONES before composing", async () => {
    const { env } = await import("../../config/env.js");
    (env as Record<string, unknown>)["OP_EXCLUDED_PHONES"] = ["0508946380"];

    const rows = [
      makeCommitment({ ...EXCLUDED, kind: "floating" }),
      makeCommitment({ ...INCLUDED, kind: "floating" }),
    ];
    mockFromImpl.mockReturnValue(makeCommitmentsBuilder({ data: rows, error: null }));

    try {
      const { ids } = await buildMorningCommitmentSection();
      expect(ids).toEqual(["c-included"]);
    } finally {
      (env as Record<string, unknown>)["OP_EXCLUDED_PHONES"] = [];
    }
  });

  it("returns null text when every pending commitment is excluded", async () => {
    const { env } = await import("../../config/env.js");
    (env as Record<string, unknown>)["OP_EXCLUDED_PHONES"] = ["0508946380"];

    mockFromImpl.mockReturnValue(makeCommitmentsBuilder({ data: [makeCommitment(EXCLUDED)], error: null }));

    try {
      const { text, ids } = await buildMorningCommitmentSection();
      expect(text).toBeNull();
      expect(ids).toEqual([]);
    } finally {
      (env as Record<string, unknown>)["OP_EXCLUDED_PHONES"] = [];
    }
  });
});

describe("fireTimedReminders — OP_EXCLUDED_PHONES", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockNotifyOwnerOps.mockResolvedValue(true);
    const { env } = await import("../../config/env.js");
    (env as Record<string, unknown>)["OP_EXCLUDED_PHONES"] = [];
  });

  it("never sends a timed reminder for an excluded chat", async () => {
    const { env } = await import("../../config/env.js");
    (env as Record<string, unknown>)["OP_EXCLUDED_PHONES"] = ["0508946380"];

    // First call (stale cancel) -> empty; second call (due) -> excluded row only
    let call = 0;
    mockFromImpl.mockImplementation(() => {
      call++;
      if (call === 1) return makeCommitmentsBuilder({ data: [], error: null });
      return makeCommitmentsBuilder({
        data: [makeCommitment({ ...EXCLUDED, kind: "timed", fire_at: new Date().toISOString() })],
        error: null,
      });
    });

    try {
      await fireTimedReminders();
      expect(mockNotifyOwnerOps).not.toHaveBeenCalled();
    } finally {
      (env as Record<string, unknown>)["OP_EXCLUDED_PHONES"] = [];
    }
  });
});
