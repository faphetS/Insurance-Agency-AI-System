import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock functions
// ---------------------------------------------------------------------------
const {
  mockGetUnresolvedMissedSince,
  mockPruneCallsOlderThan,
  mockNotifyOwnerOps,
} = vi.hoisted(() => ({
  mockGetUnresolvedMissedSince: vi.fn(),
  mockPruneCallsOlderThan: vi.fn(),
  mockNotifyOwnerOps: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock("../../config/env.js", () => ({
  env: {
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://test",
    DATABASE_POOL_MAX: 5,
    OP_EXCLUDED_PHONES: [] as string[],
  },
}));

vi.mock("../../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("./call-events.service.js", () => ({
  getUnresolvedMissedSince: mockGetUnresolvedMissedSince,
  pruneCallsOlderThan: mockPruneCallsOlderThan,
}));

vi.mock("./owner-notify.js", () => ({
  notifyOwnerOps: mockNotifyOwnerOps,
}));

// ---------------------------------------------------------------------------
// Subject import (after mocks)
// ---------------------------------------------------------------------------
import { sendDailyCallReminder, buildCallReminderSection } from "./call-reminder.service.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sendDailyCallReminder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPruneCallsOlderThan.mockResolvedValue(undefined);
    mockNotifyOwnerOps.mockResolvedValue(true);
  });

  it("does NOT call notifyOwner when there are no missed/declined rows", async () => {
    mockGetUnresolvedMissedSince.mockResolvedValue([]);

    await sendDailyCallReminder();

    expect(mockNotifyOwnerOps).not.toHaveBeenCalled();
  });

  it("calls notifyOwner with a message containing the phone numbers when rows exist", async () => {
    mockGetUnresolvedMissedSince.mockResolvedValue([
      { counterpart_phone: "972501234567@c.us", called_at: "2026-06-25T09:30:00Z" },
      { counterpart_phone: "972509876543@c.us", called_at: "2026-06-25T14:00:00Z" },
    ]);

    await sendDailyCallReminder();

    expect(mockNotifyOwnerOps).toHaveBeenCalledOnce();
    const [text] = mockNotifyOwnerOps.mock.calls[0] as [string];
    expect(text).toContain("972501234567");
    expect(text).toContain("972509876543");
    expect(text).toMatch(/\d{2}:\d{2}/);
  });

  it("strips @c.us from phone numbers in the message body", async () => {
    mockGetUnresolvedMissedSince.mockResolvedValue([
      { counterpart_phone: "972501111111@c.us", called_at: "2026-06-25T10:00:00Z" },
    ]);

    await sendDailyCallReminder();

    const [text] = mockNotifyOwnerOps.mock.calls[0] as [string];
    expect(text).toContain("972501111111");
    expect(text).not.toContain("@c.us");
  });

  it("does NOT prune when notifyOwner returns false", async () => {
    mockGetUnresolvedMissedSince.mockResolvedValue([
      { counterpart_phone: "972501234567@c.us", called_at: "2026-06-25T09:30:00Z" },
    ]);
    mockNotifyOwnerOps.mockResolvedValue(false);

    await sendDailyCallReminder();

    expect(mockPruneCallsOlderThan).not.toHaveBeenCalled();
  });

  it("prunes after a successful send", async () => {
    mockGetUnresolvedMissedSince.mockResolvedValue([
      { counterpart_phone: "972501234567@c.us", called_at: "2026-06-25T09:30:00Z" },
    ]);

    await sendDailyCallReminder();

    expect(mockPruneCallsOlderThan).toHaveBeenCalledOnce();
    const [pruneIso] = mockPruneCallsOlderThan.mock.calls[0] as [string];
    const pruneDate = new Date(pruneIso);
    const expectedApprox = Date.now() - 48 * 60 * 60 * 1000;
    expect(Math.abs(pruneDate.getTime() - expectedApprox)).toBeLessThan(5000);
  });
});

describe("buildCallReminderSection — OP_EXCLUDED_PHONES", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("drops rows whose phone is in OP_EXCLUDED_PHONES", async () => {
    const { env } = await import("../../config/env.js");
    (env as Record<string, unknown>)["OP_EXCLUDED_PHONES"] = ["0508946380"];
    mockGetUnresolvedMissedSince.mockResolvedValue([
      { counterpart_phone: "972508946380@c.us", called_at: "2026-06-25T09:30:00Z" },
      { counterpart_phone: "972501234567@c.us", called_at: "2026-06-25T14:00:00Z" },
    ]);

    try {
      const text = await buildCallReminderSection();
      expect(text).not.toBeNull();
      expect(text).not.toContain("972508946380");
      expect(text).toContain("972501234567");
    } finally {
      (env as Record<string, unknown>)["OP_EXCLUDED_PHONES"] = [];
    }
  });

  it("returns null when every unresolved row is excluded", async () => {
    const { env } = await import("../../config/env.js");
    (env as Record<string, unknown>)["OP_EXCLUDED_PHONES"] = ["0508946380"];
    mockGetUnresolvedMissedSince.mockResolvedValue([
      { counterpart_phone: "972508946380@c.us", called_at: "2026-06-25T09:30:00Z" },
    ]);

    try {
      const text = await buildCallReminderSection();
      expect(text).toBeNull();
    } finally {
      (env as Record<string, unknown>)["OP_EXCLUDED_PHONES"] = [];
    }
  });
});

// Weekend exclusion (F4) moved into the SQL predicate in getUnresolvedMissedSince
// (call-events.service.ts) so weekend rows never mask weekday rows before aggregation —
// see call-events.service.test.ts for the query-text assertion. buildCallReminderSection no
// longer filters by weekday in JS.

describe("buildCallReminderSection — Sunday-aware lookback (F4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes a 24h-ago `since` on a non-Sunday", async () => {
    // 2026-07-28 is a Tuesday. 12:00 Israel = 09:00 UTC.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T09:00:00Z"));
    mockGetUnresolvedMissedSince.mockResolvedValue([]);

    await buildCallReminderSection();

    const [sinceIso] = mockGetUnresolvedMissedSince.mock.calls[0] as [string];
    const expected = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    expect(sinceIso).toBe(expected);
  });

  it("passes a 72h-ago `since` on Israel-Sunday", async () => {
    // 2026-08-02 is a Sunday. 10:00 Israel = 07:00 UTC.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-02T07:00:00Z"));
    mockGetUnresolvedMissedSince.mockResolvedValue([]);

    await buildCallReminderSection();

    const [sinceIso] = mockGetUnresolvedMissedSince.mock.calls[0] as [string];
    const expected = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    expect(sinceIso).toBe(expected);
  });
});
