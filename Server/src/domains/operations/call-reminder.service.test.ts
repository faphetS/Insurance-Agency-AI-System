import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock functions
// ---------------------------------------------------------------------------
const {
  mockFromImpl,
  mockGetMissedDeclinedSince,
  mockPruneCallsOlderThan,
  mockOpCreds,
  mockSendMessageWith,
} = vi.hoisted(() => ({
  mockFromImpl: vi.fn(),
  mockGetMissedDeclinedSince: vi.fn(),
  mockPruneCallsOlderThan: vi.fn(),
  mockOpCreds: vi.fn(),
  mockSendMessageWith: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock("../../config/env.js", () => ({
  env: {
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://test",
    DATABASE_POOL_MAX: 5,
  },
}));

vi.mock("../../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../config/supabase.js", () => ({
  supabaseAdmin: { from: mockFromImpl },
}));

vi.mock("./call-events.service.js", () => ({
  getMissedDeclinedSince: mockGetMissedDeclinedSince,
  pruneCallsOlderThan: mockPruneCallsOlderThan,
}));

vi.mock("../whatsapp/whatsapp.service.js", () => ({
  opCreds: mockOpCreds,
  sendMessageWith: mockSendMessageWith,
}));

// ---------------------------------------------------------------------------
// Subject import (after mocks)
// ---------------------------------------------------------------------------
import { sendDailyCallReminder } from "./call-reminder.service.js";

// ---------------------------------------------------------------------------
// Builder shim
// ---------------------------------------------------------------------------
type Builder = Record<string, unknown>;

function makeBuilder(result: unknown): Builder {
  const terminal = vi.fn().mockResolvedValue(result);
  const builder: Builder = {};
  const chainMethods = [
    "select", "eq", "neq", "is", "in", "gte", "lte",
    "order", "insert", "upsert", "update", "limit",
  ];
  for (const m of chainMethods) {
    builder[m] = vi.fn().mockReturnValue(builder);
  }
  builder["maybeSingle"] = terminal;
  builder["single"] = terminal;
  builder["then"] = (onFulfilled: (v: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled);
  return builder;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const CREDS = { idInstance: "7103519997", token: "tok", baseUrl: "https://green.api" };
const SELF_CHAT = "97250999@c.us";

describe("sendDailyCallReminder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPruneCallsOlderThan.mockResolvedValue(undefined);
    mockSendMessageWith.mockResolvedValue({ idMessage: "sent-id" });
  });

  it("does NOT call sendMessageWith when there are no missed/declined rows", async () => {
    mockGetMissedDeclinedSince.mockResolvedValue([]);

    await sendDailyCallReminder();

    expect(mockSendMessageWith).not.toHaveBeenCalled();
    expect(mockFromImpl).not.toHaveBeenCalled();
  });

  it("sends a message to selfChatId when rows exist", async () => {
    mockGetMissedDeclinedSince.mockResolvedValue([
      { counterpart_phone: "972501234567@c.us", called_at: "2026-06-25T09:30:00Z" },
      { counterpart_phone: "972509876543@c.us", called_at: "2026-06-25T14:00:00Z" },
    ]);
    mockOpCreds.mockReturnValue(CREDS);

    const settingBuilder = makeBuilder({ data: { value: SELF_CHAT }, error: null });
    mockFromImpl.mockReturnValue(settingBuilder);

    await sendDailyCallReminder();

    expect(mockSendMessageWith).toHaveBeenCalledOnce();
    const [calledCreds, calledChatId, calledText] = mockSendMessageWith.mock.calls[0] as [typeof CREDS, string, string];
    expect(calledCreds).toEqual(CREDS);
    expect(calledChatId).toBe(SELF_CHAT);
    expect(calledText).toContain("972501234567");
    expect(calledText).toContain("972509876543");
    // Time formatted HH:mm in Jerusalem — 09:30 UTC = 12:30 IDT (UTC+3 summer)
    expect(calledText).toMatch(/\d{2}:\d{2}/);
  });

  it("strips @c.us from phone numbers in the message body", async () => {
    mockGetMissedDeclinedSince.mockResolvedValue([
      { counterpart_phone: "972501111111@c.us", called_at: "2026-06-25T10:00:00Z" },
    ]);
    mockOpCreds.mockReturnValue(CREDS);

    const settingBuilder = makeBuilder({ data: { value: SELF_CHAT }, error: null });
    mockFromImpl.mockReturnValue(settingBuilder);

    await sendDailyCallReminder();

    const [, , text] = mockSendMessageWith.mock.calls[0] as [unknown, unknown, string];
    expect(text).toContain("972501111111");
    expect(text).not.toContain("@c.us");
  });

  it("returns early (no send) when op_self_chat_id is missing", async () => {
    mockGetMissedDeclinedSince.mockResolvedValue([
      { counterpart_phone: "972501234567@c.us", called_at: "2026-06-25T09:30:00Z" },
    ]);

    const settingBuilder = makeBuilder({ data: null, error: null });
    mockFromImpl.mockReturnValue(settingBuilder);

    await sendDailyCallReminder();

    expect(mockSendMessageWith).not.toHaveBeenCalled();
  });

  it("returns early (no send) when opCreds returns null", async () => {
    mockGetMissedDeclinedSince.mockResolvedValue([
      { counterpart_phone: "972501234567@c.us", called_at: "2026-06-25T09:30:00Z" },
    ]);
    mockOpCreds.mockReturnValue(null);

    const settingBuilder = makeBuilder({ data: { value: SELF_CHAT }, error: null });
    mockFromImpl.mockReturnValue(settingBuilder);

    await sendDailyCallReminder();

    expect(mockSendMessageWith).not.toHaveBeenCalled();
  });

  it("prunes after sending", async () => {
    mockGetMissedDeclinedSince.mockResolvedValue([
      { counterpart_phone: "972501234567@c.us", called_at: "2026-06-25T09:30:00Z" },
    ]);
    mockOpCreds.mockReturnValue(CREDS);

    const settingBuilder = makeBuilder({ data: { value: SELF_CHAT }, error: null });
    mockFromImpl.mockReturnValue(settingBuilder);

    await sendDailyCallReminder();

    expect(mockPruneCallsOlderThan).toHaveBeenCalledOnce();
    const [pruneIso] = mockPruneCallsOlderThan.mock.calls[0] as [string];
    // Should be approximately 48h ago
    const pruneDate = new Date(pruneIso);
    const expectedApprox = Date.now() - 48 * 60 * 60 * 1000;
    expect(Math.abs(pruneDate.getTime() - expectedApprox)).toBeLessThan(5000);
  });
});
