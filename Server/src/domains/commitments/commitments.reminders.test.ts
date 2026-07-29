import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
  const chainMethods = ["select", "eq", "in", "lte", "gte", "lt", "update"];
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
    // Fixed weekday anchor (Tuesday 2026-07-28, 12:00 Israel) — real "now" would make the
    // new weekday filter in buildMorningCommitmentSection flaky on a real Fri/Sat test run.
    fire_at: "2026-07-28T09:00:00.000Z",
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

describe("buildMorningCommitmentSection — legacy weekend-fire_at rows cancelled (F1)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { env } = await import("../../config/env.js");
    (env as Record<string, unknown>)["OP_EXCLUDED_PHONES"] = [];
  });

  it("cancels a pending row whose fire_at lands on Friday and excludes it from the composed message", async () => {
    // 2026-07-31 12:00 Israel (Friday) = 09:00 UTC.
    const weekendRow = makeCommitment({
      id: "c-weekend",
      chat_id: "972502222222@c.us",
      fire_at: "2026-07-31T09:00:00.000Z",
      kind: "date_only",
    });
    const weekdayRow = makeCommitment({ ...INCLUDED, kind: "date_only" });

    const builder = makeCommitmentsBuilder({ data: [weekendRow, weekdayRow], error: null });
    mockFromImpl.mockReturnValue(builder);

    const { ids } = await buildMorningCommitmentSection();

    expect(ids).toEqual(["c-included"]);
    expect(builder["update"]).toHaveBeenCalledWith(
      expect.objectContaining({ status: "cancelled" }),
    );
    expect(builder["in"]).toHaveBeenCalledWith("id", ["c-weekend"]);
  });

  it("does not call update/cancel when there are no weekend-fire_at rows", async () => {
    const builder = makeCommitmentsBuilder({ data: [makeCommitment(INCLUDED)], error: null });
    mockFromImpl.mockReturnValue(builder);

    await buildMorningCommitmentSection();

    expect(builder["update"]).not.toHaveBeenCalled();
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

describe("fireTimedReminders — op-hours window gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNotifyOwnerOps.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("no-ops (no DB call) on a Friday", async () => {
    // 2026-07-31 is a Friday. 12:00 Israel = 09:00 UTC.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T09:00:00Z"));

    await fireTimedReminders();

    expect(mockFromImpl).not.toHaveBeenCalled();
    expect(mockNotifyOwnerOps).not.toHaveBeenCalled();
  });

  it("no-ops (no DB call) on a Tuesday evening (outside 09:00-18:00 Israel)", async () => {
    // 2026-07-28 is a Tuesday. 20:00 Israel = 17:00 UTC.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T17:00:00Z"));

    await fireTimedReminders();

    expect(mockFromImpl).not.toHaveBeenCalled();
    expect(mockNotifyOwnerOps).not.toHaveBeenCalled();
  });

  it("fires normally on a Tuesday at noon", async () => {
    // 2026-07-28 is a Tuesday. 12:00 Israel = 09:00 UTC.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T09:00:00Z"));

    let call = 0;
    mockFromImpl.mockImplementation(() => {
      call++;
      if (call === 1) return makeCommitmentsBuilder({ data: [], error: null });
      return makeCommitmentsBuilder({
        data: [makeCommitment({ ...INCLUDED, kind: "timed", fire_at: new Date().toISOString() })],
        error: null,
      });
    });

    await fireTimedReminders();

    expect(mockNotifyOwnerOps).toHaveBeenCalledOnce();
  });
});
