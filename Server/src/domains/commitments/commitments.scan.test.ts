import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock functions
// ---------------------------------------------------------------------------
const { mockFromImpl, mockOpCreds, mockLastIncoming, mockLastOutgoing } = vi.hoisted(() => ({
  mockFromImpl: vi.fn(),
  mockOpCreds: vi.fn(),
  mockLastIncoming: vi.fn(),
  mockLastOutgoing: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks — declared before project imports
// ---------------------------------------------------------------------------
vi.mock("../../config/env.js", () => ({
  env: {
    NODE_ENV: "test",
    OP_EXCLUDED_PHONES: [] as string[],
  },
}));

vi.mock("../../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../config/supabase.js", () => ({
  supabaseAdmin: { from: mockFromImpl },
}));

vi.mock("../whatsapp/whatsapp.service.js", () => ({
  opCreds: mockOpCreds,
  lastIncomingMessagesWith: mockLastIncoming,
  lastOutgoingMessagesWith: mockLastOutgoing,
}));

// ---------------------------------------------------------------------------
// Subject import (after mocks)
// ---------------------------------------------------------------------------
import { scanRecentChats } from "./commitments.scan.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEmptySettingsBuilder() {
  const b: Record<string, unknown> = {};
  const chainMethods = ["select", "eq"];
  for (const m of chainMethods) b[m] = vi.fn().mockReturnValue(b);
  b["maybeSingle"] = vi.fn().mockResolvedValue({ data: null, error: null });
  return b;
}

describe("scanRecentChats — OP_EXCLUDED_PHONES", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockFromImpl.mockImplementation(() => makeEmptySettingsBuilder());
    mockOpCreds.mockReturnValue({ idInstance: "op-id", token: "op-token", baseUrl: "https://test.api.greenapi.com" });
    const { env } = await import("../../config/env.js");
    (env as Record<string, unknown>)["OP_EXCLUDED_PHONES"] = [];
  });

  it("excludes messages from a chat listed in OP_EXCLUDED_PHONES", async () => {
    const { env } = await import("../../config/env.js");
    (env as Record<string, unknown>)["OP_EXCLUDED_PHONES"] = ["0508946380"];

    const now = Math.floor(Date.now() / 1000);
    mockLastIncoming.mockResolvedValue([
      {
        chatId: "972508946380@c.us",
        type: "incoming",
        textMessage: "hi",
        timestamp: now,
        senderName: "Personal",
      },
      {
        chatId: "972501111111@c.us",
        type: "incoming",
        textMessage: "hello",
        timestamp: now,
        senderName: "Client",
      },
    ]);
    mockLastOutgoing.mockResolvedValue([]);

    const transcripts = await scanRecentChats();

    expect(transcripts.map((t) => t.chatId)).toEqual(["972501111111@c.us"]);
  });
});

describe("scanRecentChats — Israel weekend skip", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockFromImpl.mockImplementation(() => makeEmptySettingsBuilder());
    mockOpCreds.mockReturnValue({ idInstance: "op-id", token: "op-token", baseUrl: "https://test.api.greenapi.com" });
    mockLastOutgoing.mockResolvedValue([]);
    const { env } = await import("../../config/env.js");
    (env as Record<string, unknown>)["OP_EXCLUDED_PHONES"] = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips a Saturday-timestamped message", async () => {
    // "now" = Sunday 2026-08-02 10:00 Israel = 07:00 UTC; 24h cutoff reaches into Saturday.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-02T07:00:00Z"));

    // 2026-08-01 is a Saturday. 12:00 Israel = 09:00 UTC — within the 24h cutoff.
    const saturdayTs = Math.floor(new Date("2026-08-01T09:00:00Z").getTime() / 1000);

    mockLastIncoming.mockResolvedValue([
      {
        chatId: "972501111111@c.us",
        type: "incoming",
        textMessage: "weekend message",
        timestamp: saturdayTs,
        senderName: "Weekend",
      },
    ]);

    const transcripts = await scanRecentChats();

    expect(transcripts.map((t) => t.chatId)).not.toContain("972501111111@c.us");
  });

  it("keeps a Wednesday-20:00 message", async () => {
    // "now" = Thursday 2026-07-30 09:00 Israel = 06:00 UTC; 24h cutoff reaches into Wednesday evening.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T06:00:00Z"));

    // 2026-07-29 is a Wednesday. 20:00 Israel = 17:00 UTC — within the 24h cutoff.
    const wednesdayEveningTs = Math.floor(new Date("2026-07-29T17:00:00Z").getTime() / 1000);

    mockLastIncoming.mockResolvedValue([
      {
        chatId: "972502222222@c.us",
        type: "incoming",
        textMessage: "weekday evening message",
        timestamp: wednesdayEveningTs,
        senderName: "Weekday",
      },
    ]);

    const transcripts = await scanRecentChats();

    expect(transcripts.map((t) => t.chatId)).toContain("972502222222@c.us");
  });
});

describe("scanRecentChats — F5: Didi's weekend outgoing kept, client's weekend incoming dropped", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockFromImpl.mockImplementation(() => makeEmptySettingsBuilder());
    mockOpCreds.mockReturnValue({ idInstance: "op-id", token: "op-token", baseUrl: "https://test.api.greenapi.com" });
    const { env } = await import("../../config/env.js");
    (env as Record<string, unknown>)["OP_EXCLUDED_PHONES"] = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps Didi's Friday-evening outgoing message but drops a client's Friday-evening incoming message", async () => {
    // "now" = Saturday 2026-08-01 10:00 Israel = 07:00 UTC; 24h cutoff reaches into Friday evening.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T07:00:00Z"));

    // 2026-07-31 is a Friday. 20:00 Israel = 17:00 UTC — within the 24h cutoff.
    const fridayEveningTs = Math.floor(new Date("2026-07-31T17:00:00Z").getTime() / 1000);

    mockLastIncoming.mockResolvedValue([
      {
        chatId: "972502222222@c.us",
        type: "incoming",
        textMessage: "client friday message",
        timestamp: fridayEveningTs,
        senderName: "Client",
      },
    ]);
    mockLastOutgoing.mockResolvedValue([
      {
        chatId: "972503333333@c.us",
        type: "outgoing",
        textMessage: "didi friday reply",
        timestamp: fridayEveningTs,
        senderName: "Didi",
      },
    ]);

    const transcripts = await scanRecentChats();
    const chatIds = transcripts.map((t) => t.chatId);

    expect(chatIds).toContain("972503333333@c.us");
    expect(chatIds).not.toContain("972502222222@c.us");
  });
});

describe("scanRecentChats — Sunday 72h lookback widening", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockFromImpl.mockImplementation(() => makeEmptySettingsBuilder());
    mockOpCreds.mockReturnValue({ idInstance: "op-id", token: "op-token", baseUrl: "https://test.api.greenapi.com" });
    mockLastOutgoing.mockResolvedValue([]);
    const { env } = await import("../../config/env.js");
    (env as Record<string, unknown>)["OP_EXCLUDED_PHONES"] = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("on Sunday, widens the lookback to 72h/4320min and includes a Thursday-14:00 message", async () => {
    // "now" = Sunday 2026-08-02 10:00 Israel = 07:00 UTC; Friday's scan no longer runs,
    // so Sunday must reach back through Thursday to avoid losing Thursday's chats.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-02T07:00:00Z"));

    // 2026-07-30 is a Thursday. 14:00 Israel = 11:00 UTC — within the widened 72h cutoff,
    // but outside the normal 24h cutoff.
    const thursdayTs = Math.floor(new Date("2026-07-30T11:00:00Z").getTime() / 1000);

    mockLastIncoming.mockResolvedValue([
      {
        chatId: "972503333333@c.us",
        type: "incoming",
        textMessage: "thursday message",
        timestamp: thursdayTs,
        senderName: "Thursday",
      },
    ]);

    const transcripts = await scanRecentChats();

    expect(transcripts.map((t) => t.chatId)).toContain("972503333333@c.us");
    expect(mockLastIncoming).toHaveBeenCalledWith(expect.anything(), 4320);
    expect(mockLastOutgoing).toHaveBeenCalledWith(expect.anything(), 4320);
  });

  it("on Monday, keeps the normal 24h/1440min lookback (Thursday message excluded)", async () => {
    // "now" = Monday 2026-08-03 10:00 Israel = 07:00 UTC; normal 24h cutoff.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T07:00:00Z"));

    const thursdayTs = Math.floor(new Date("2026-07-30T11:00:00Z").getTime() / 1000);

    mockLastIncoming.mockResolvedValue([
      {
        chatId: "972503333333@c.us",
        type: "incoming",
        textMessage: "thursday message",
        timestamp: thursdayTs,
        senderName: "Thursday",
      },
    ]);

    const transcripts = await scanRecentChats();

    expect(transcripts.map((t) => t.chatId)).not.toContain("972503333333@c.us");
    expect(mockLastIncoming).toHaveBeenCalledWith(expect.anything(), 1440);
    expect(mockLastOutgoing).toHaveBeenCalledWith(expect.anything(), 1440);
  });
});
