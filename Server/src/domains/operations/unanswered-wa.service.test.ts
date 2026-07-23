import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock functions
// ---------------------------------------------------------------------------
const {
  mockPoolQuery,
  mockFromImpl,
  mockOpCreds,
  mockSendInteractiveButtonsWith,
  mockNotifyOwnerOps,
  mockExtractButtonId,
  mockSleep,
  mockNeedsReplyFromDidi,
} = vi.hoisted(() => ({
  mockPoolQuery: vi.fn(),
  mockFromImpl: vi.fn(),
  mockOpCreds: vi.fn(),
  mockSendInteractiveButtonsWith: vi.fn(),
  mockNotifyOwnerOps: vi.fn(),
  mockExtractButtonId: vi.fn(),
  mockSleep: vi.fn(),
  mockNeedsReplyFromDidi: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks — declared before any project imports so Vitest hoists them
// ---------------------------------------------------------------------------
vi.mock("../../config/env.js", () => ({
  env: {
    NODE_ENV: "test",
    SUMMARY_RECIPIENT_PHONE: "972500000000",
    GREENAPI_OP_ID_INSTANCE: "op-id",
    GREENAPI_OP_API_TOKEN: "op-token",
    GREENAPI_OP_BASE_URL: "https://test.api.greenapi.com",
    UNANSWERED_WA_MODE: "send",
  },
}));

vi.mock("../../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../lib/db.js", () => ({
  pool: { query: mockPoolQuery },
}));

vi.mock("../../lib/sleep.js", () => ({
  sleep: mockSleep,
}));

vi.mock("../../config/supabase.js", () => ({
  supabaseAdmin: { from: mockFromImpl },
}));

vi.mock("../whatsapp/whatsapp.service.js", () => ({
  opCreds: mockOpCreds,
  sendMessageWith: vi.fn(),
  sendInteractiveButtonsWith: mockSendInteractiveButtonsWith,
  sendMessageWithTyping: vi.fn(),
}));

// Use the REAL pure helpers (toChatId, toLocalPhone, displayName), mock only extractButtonId
vi.mock("../whatsapp/whatsapp.util.js", async () => {
  const actual = await vi.importActual<typeof import("../whatsapp/whatsapp.util.js")>("../whatsapp/whatsapp.util.js");
  return {
    ...actual,
    extractButtonId: mockExtractButtonId,
  };
});

vi.mock("./owner-notify.js", () => ({
  notifyOwnerOps: mockNotifyOwnerOps,
}));

// Default to true (needs reply) so pre-existing sweep tests keep passing unchanged.
vi.mock("./unanswered-wa.llm.js", () => ({
  needsReplyFromDidi: mockNeedsReplyFromDidi,
}));

// ---------------------------------------------------------------------------
// Subject import (after mocks)
// ---------------------------------------------------------------------------
import {
  handleOpInstanceEvent,
  sweepUnanswered,
  sendCallbackReminders,
  isWithinWatchWindow,
  AUTO_REPLY_TEXT,
  AUTO_REPLY_BUTTONS,
} from "./unanswered-wa.service.js";

// ---------------------------------------------------------------------------
// Helpers — supabaseAdmin builder stub (mirrors other test files' pattern)
// ---------------------------------------------------------------------------

function makeBuilder(result: unknown) {
  const b: Record<string, unknown> = {};
  const chainMethods = ["select", "eq", "not", "in", "order", "limit"];
  for (const m of chainMethods) b[m] = vi.fn().mockReturnValue(b);
  const terminal = vi.fn().mockResolvedValue(result);
  b["maybeSingle"] = terminal;
  b["single"] = terminal;
  b["then"] = (resolve: (v: unknown) => void) => Promise.resolve(result).then(resolve);
  return b;
}

// getExcludedChatIds() always queries, in order: system_settings(self), system_settings(bot), staff(list)
function setupExclusionQueries(opts?: {
  selfChatId?: string | null;
  botChatId?: string | null;
  staffPhones?: string[];
}) {
  const selfBuilder = makeBuilder({ data: opts?.selfChatId ? { value: opts.selfChatId } : null, error: null });
  const botBuilder = makeBuilder({ data: opts?.botChatId ? { value: opts.botChatId } : null, error: null });
  const staffBuilder = makeBuilder({
    data: (opts?.staffPhones ?? []).map((p) => ({ phone: p })),
    error: null,
  });
  const builders = [selfBuilder, botBuilder, staffBuilder];
  let i = 0;
  mockFromImpl.mockImplementation(() => {
    const b = builders[i] ?? builders[builders.length - 1]!;
    i++;
    return b;
  });
}

// ---------------------------------------------------------------------------
// isWithinWatchWindow — Israel TZ window boundaries (Sun-Thu 09:00-18:00 inclusive)
// ---------------------------------------------------------------------------

describe("isWithinWatchWindow", () => {
  it("Sunday 10:00 Israel summer (UTC+3) is inside the window", () => {
    // 2026-07-05 is a Sunday. 10:00 IST = 07:00 UTC.
    expect(isWithinWatchWindow(new Date("2026-07-05T07:00:00Z"))).toBe(true);
  });

  it("Thursday 17:59 Israel summer (UTC+3) is inside the window", () => {
    // 2026-07-09 is a Thursday. 17:59 IST = 14:59 UTC.
    expect(isWithinWatchWindow(new Date("2026-07-09T14:59:00Z"))).toBe(true);
  });

  it("Friday 12:00 Israel summer (UTC+3) is outside the window (weekend)", () => {
    // 2026-07-10 is a Friday. 12:00 IST = 09:00 UTC.
    expect(isWithinWatchWindow(new Date("2026-07-10T09:00:00Z"))).toBe(false);
  });

  it("Saturday 12:00 Israel summer (UTC+3) is outside the window (weekend)", () => {
    // 2026-07-11 is a Saturday. 12:00 IST = 09:00 UTC.
    expect(isWithinWatchWindow(new Date("2026-07-11T09:00:00Z"))).toBe(false);
  });

  it("Sunday 08:59 Israel summer (UTC+3) is outside the window (before open)", () => {
    // 2026-07-05 is a Sunday. 08:59 IST = 05:59 UTC.
    expect(isWithinWatchWindow(new Date("2026-07-05T05:59:00Z"))).toBe(false);
  });

  it("Sunday 18:01 Israel summer (UTC+3) is outside the window (after close)", () => {
    // 2026-07-05 is a Sunday. 18:01 IST = 15:01 UTC.
    expect(isWithinWatchWindow(new Date("2026-07-05T15:01:00Z"))).toBe(false);
  });

  it("Sunday 10:00 Israel winter (UTC+2) is inside the window", () => {
    // 2026-01-04 is a Sunday. 10:00 IST = 08:00 UTC in standard time.
    expect(isWithinWatchWindow(new Date("2026-01-04T08:00:00Z"))).toBe(true);
  });

  it("Friday 12:00 Israel winter (UTC+2) is outside the window (weekend)", () => {
    // 2026-01-09 is a Friday. 12:00 IST = 10:00 UTC in standard time.
    expect(isWithinWatchWindow(new Date("2026-01-09T10:00:00Z"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleOpInstanceEvent — new chat, no active row
// ---------------------------------------------------------------------------

describe("handleOpInstanceEvent — new chat, no active row", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupExclusionQueries();
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("creates a watching row when the message is within the watch window", async () => {
    await handleOpInstanceEvent({
      typeWebhook: "incomingMessageReceived",
      senderData: { chatId: "972501111111@c.us", senderName: "Yossi" },
      // 2026-07-05 is a Sunday. 13:00 IST = 10:00 UTC.
      timestamp: Math.floor(new Date("2026-07-05T10:00:00Z").getTime() / 1000),
    });

    const insertCall = mockPoolQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO public.wa_unanswered"),
    );
    expect(insertCall).toBeDefined();
    expect(insertCall![1]).toEqual(["972501111111@c.us", "Yossi", "2026-07-05T10:00:00.000Z"]);
  });

  it("does nothing when the message is outside the watch window", async () => {
    await handleOpInstanceEvent({
      typeWebhook: "incomingMessageReceived",
      senderData: { chatId: "972501111111@c.us", senderName: "Yossi" },
      // 2026-07-05 is a Sunday. 20:30 IST = 17:30 UTC — after the 18:00 close.
      timestamp: Math.floor(new Date("2026-07-05T17:30:00Z").getTime() / 1000),
    });

    const insertCall = mockPoolQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO public.wa_unanswered"),
    );
    expect(insertCall).toBeUndefined();
  });

  it("with UNANSWERED_WINDOW_DISABLED set, an out-of-window message still creates a watching row", async () => {
    const { env } = await import("../../config/env.js");
    (env as Record<string, unknown>)["UNANSWERED_WINDOW_DISABLED"] = "1";

    try {
      await handleOpInstanceEvent({
        typeWebhook: "incomingMessageReceived",
        senderData: { chatId: "972501111111@c.us", senderName: "Yossi" },
        timestamp: Math.floor(new Date("2026-07-05T17:30:00Z").getTime() / 1000),
      });

      const insertCall = mockPoolQuery.mock.calls.find(([sql]) =>
        String(sql).includes("INSERT INTO public.wa_unanswered"),
      );
      expect(insertCall).toBeDefined();
    } finally {
      (env as Record<string, unknown>)["UNANSWERED_WINDOW_DISABLED"] = undefined;
    }
  });

  it("a reaction with no active row is never tracked (no watching row created)", async () => {
    await handleOpInstanceEvent({
      typeWebhook: "incomingMessageReceived",
      senderData: { chatId: "972501111111@c.us", senderName: "Yossi" },
      messageData: { typeMessage: "reactionMessage" },
      timestamp: Math.floor(new Date("2026-07-05T10:00:00Z").getTime() / 1000),
    });

    const insertCall = mockPoolQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO public.wa_unanswered"),
    );
    expect(insertCall).toBeUndefined();
  });

  it.each(["👍", "🙏", "❤️", "👍🏽", " 😂 "])(
    "a typed single-emoji message (%s) with no active row is never tracked",
    async (emoji) => {
      await handleOpInstanceEvent({
        typeWebhook: "incomingMessageReceived",
        senderData: { chatId: "972501111111@c.us", senderName: "Yossi" },
        messageData: { typeMessage: "textMessage", textMessageData: { textMessage: emoji } },
        timestamp: Math.floor(new Date("2026-07-05T10:00:00Z").getTime() / 1000),
      });

      const insertCall = mockPoolQuery.mock.calls.find(([sql]) =>
        String(sql).includes("INSERT INTO public.wa_unanswered"),
      );
      expect(insertCall).toBeUndefined();
    },
  );

  it("a text message containing more than a lone emoji still starts tracking", async () => {
    mockPoolQuery
      .mockImplementationOnce(() => Promise.resolve({ rows: [], rowCount: 0 })) // getActiveRow -> none
      .mockImplementationOnce(() => Promise.resolve({ rows: [], rowCount: 0 })); // isChatBlockedToday -> not blocked

    await handleOpInstanceEvent({
      typeWebhook: "incomingMessageReceived",
      senderData: { chatId: "972501111111@c.us", senderName: "Yossi" },
      messageData: { typeMessage: "textMessage", textMessageData: { textMessage: "תודה 👍" } },
      timestamp: Math.floor(new Date("2026-07-05T10:00:00Z").getTime() / 1000),
    });

    const insertCall = mockPoolQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO public.wa_unanswered"),
    );
    expect(insertCall).toBeDefined();
  });

  it("does not create a watching row when the chat is day-blocked", async () => {
    mockPoolQuery
      .mockImplementationOnce(() => Promise.resolve({ rows: [], rowCount: 0 })) // getActiveRow -> none
      .mockImplementationOnce(() => Promise.resolve({ rows: [{ x: 1 }], rowCount: 1 })); // isChatBlockedToday -> blocked

    await handleOpInstanceEvent({
      typeWebhook: "incomingMessageReceived",
      senderData: { chatId: "972501111111@c.us", senderName: "Yossi" },
      timestamp: Math.floor(new Date("2026-07-05T10:00:00Z").getTime() / 1000),
    });

    const insertCall = mockPoolQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO public.wa_unanswered"),
    );
    expect(insertCall).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// handleOpInstanceEvent — state transitions
// ---------------------------------------------------------------------------

describe("handleOpInstanceEvent — state transitions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupExclusionQueries();
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 1 });
  });

  it("watching + incoming message: re-anchors the silence timer to the newest message", async () => {
    mockPoolQuery.mockImplementationOnce(() =>
      Promise.resolve({ rows: [{ id: "row-1", chat_id: "972501111111@c.us", state: "watching" }] }),
    );

    await handleOpInstanceEvent({
      typeWebhook: "incomingMessageReceived",
      senderData: { chatId: "972501111111@c.us", senderName: "Yossi" },
      timestamp: Math.floor(new Date("2026-07-05T10:30:00Z").getTime() / 1000),
    });

    const reanchor = mockPoolQuery.mock.calls.find(([sql]) =>
      String(sql).includes("SET first_unanswered_at=$2"),
    );
    expect(reanchor).toBeDefined();
    expect(reanchor![1]).toEqual(["row-1", "2026-07-05T10:30:00.000Z"]);
  });

  it("watching + a reaction: does NOT re-anchor the silence timer", async () => {
    mockPoolQuery.mockImplementationOnce(() =>
      Promise.resolve({ rows: [{ id: "row-1", chat_id: "972501111111@c.us", state: "watching" }] }),
    );

    await handleOpInstanceEvent({
      typeWebhook: "incomingMessageReceived",
      senderData: { chatId: "972501111111@c.us", senderName: "Yossi" },
      messageData: { typeMessage: "reactionMessage" },
    });

    expect(mockPoolQuery).toHaveBeenCalledTimes(1); // only the active-row select
  });

  it("outgoingMessageReceived (Didi typed manually): resolves the active row for the chat WITH day-block", async () => {
    await handleOpInstanceEvent({
      typeWebhook: "outgoingMessageReceived",
      senderData: { chatId: "972501111111@c.us" },
    });

    const resolveCall = mockPoolQuery.mock.calls.find(
      ([sql]) =>
        String(sql).includes("state='resolved'") &&
        String(sql).includes("chat_id=$1") &&
        String(sql).includes("blocks_rest_of_day=true"),
    );
    expect(resolveCall).toBeDefined();
    expect(mockExtractButtonId).not.toHaveBeenCalled();
  });

  it("outgoingMessageReceived with a reactionMessage: also resolves the active row WITH day-block", async () => {
    await handleOpInstanceEvent({
      typeWebhook: "outgoingMessageReceived",
      senderData: { chatId: "972501111111@c.us" },
      messageData: { typeMessage: "reactionMessage" },
    });

    const resolveCall = mockPoolQuery.mock.calls.find(
      ([sql]) =>
        String(sql).includes("state='resolved'") &&
        String(sql).includes("chat_id=$1") &&
        String(sql).includes("blocks_rest_of_day=true"),
    );
    expect(resolveCall).toBeDefined();
  });

  it("outgoingAPIMessageReceived is ignored completely — no DB queries", async () => {
    await handleOpInstanceEvent({
      typeWebhook: "outgoingAPIMessageReceived",
      senderData: { chatId: "972501111111@c.us" },
    });

    expect(mockPoolQuery).not.toHaveBeenCalled();
    expect(mockFromImpl).not.toHaveBeenCalled();
  });

  it("ua_ok tap: resolves the chat's active row WITH day-block, WITHOUT alerting Didi", async () => {
    mockExtractButtonId.mockReturnValue("ua_ok");

    await handleOpInstanceEvent({
      typeWebhook: "incomingMessageReceived",
      senderData: { chatId: "972501111111@c.us", senderName: "Yossi" },
    });

    expect(mockNotifyOwnerOps).not.toHaveBeenCalled();
    const resolveCall = mockPoolQuery.mock.calls.find(
      ([sql]) =>
        String(sql).includes("state='resolved'") &&
        String(sql).includes("chat_id=$1") &&
        String(sql).includes("blocks_rest_of_day=true"),
    );
    expect(resolveCall).toBeDefined();
    expect(resolveCall![1]).toEqual(["972501111111@c.us"]);
  });

  it("ua_callback tap with an active row: stamps callback_requested_at + resolves WITH day-block, NO immediate owner notify", async () => {
    mockExtractButtonId.mockReturnValue("ua_callback");

    await handleOpInstanceEvent({
      typeWebhook: "incomingMessageReceived",
      senderData: { chatId: "972501111111@c.us", senderName: "Yossi" },
    });

    expect(mockNotifyOwnerOps).not.toHaveBeenCalled();
    const updateCall = mockPoolQuery.mock.calls.find(
      ([sql]) =>
        String(sql).includes("callback_requested_at=now()") &&
        String(sql).includes("state='resolved'") &&
        String(sql).includes("blocks_rest_of_day=true"),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![1]).toEqual(["972501111111@c.us"]);
    // active-row hit → no fallback stamp, no synthetic insert
    expect(
      mockPoolQuery.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO public.wa_unanswered")),
    ).toBeUndefined();
  });

  it("stale ua_callback tap (row already expired): stamps the chat's latest auto-replied row — no new watch, no second auto-reply", async () => {
    mockExtractButtonId.mockReturnValue("ua_callback");
    mockPoolQuery
      .mockImplementationOnce(() => Promise.resolve({ rows: [], rowCount: 0 })) // active-row UPDATE → none
      .mockImplementationOnce(() => Promise.resolve({ rows: [], rowCount: 1 })); // stale-row UPDATE → hit

    await handleOpInstanceEvent({
      typeWebhook: "incomingMessageReceived",
      senderData: { chatId: "972501111111@c.us", senderName: "Yossi" },
    });

    const staleCall = mockPoolQuery.mock.calls[1]!;
    expect(String(staleCall[0])).toContain("auto_replied_at IS NOT NULL");
    expect(String(staleCall[0])).toContain("callback_requested_at=now()");
    expect(
      mockPoolQuery.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO public.wa_unanswered")),
    ).toBeUndefined();
    expect(mockNotifyOwnerOps).not.toHaveBeenCalled();
  });

  it("ua_callback tap with no trace of the chat left: records a synthetic resolved row", async () => {
    mockExtractButtonId.mockReturnValue("ua_callback");
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    await handleOpInstanceEvent({
      typeWebhook: "incomingMessageReceived",
      senderData: { chatId: "972501111111@c.us", senderName: "Yossi" },
    });

    const insertCall = mockPoolQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO public.wa_unanswered"),
    );
    expect(insertCall).toBeDefined();
    expect(String(insertCall![0])).toContain("callback_requested_at");
    expect(insertCall![1]).toEqual(["972501111111@c.us", "Yossi"]);
  });

  it("stale ua_ok tap (no active row): no-op — no watching row created, no auto-reply cycle started", async () => {
    mockExtractButtonId.mockReturnValue("ua_ok");
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    await handleOpInstanceEvent({
      typeWebhook: "incomingMessageReceived",
      senderData: { chatId: "972501111111@c.us", senderName: "Yossi" },
    });

    expect(
      mockPoolQuery.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO public.wa_unanswered")),
    ).toBeUndefined();
  });

  it("pending_followup + free-text message: resolves WITH day-block, silently (no owner notify)", async () => {
    mockPoolQuery.mockImplementationOnce(() =>
      Promise.resolve({ rows: [{ id: "row-5", chat_id: "972501111111@c.us", state: "pending_followup" }] }),
    );
    mockExtractButtonId.mockReturnValue("");

    await handleOpInstanceEvent({
      typeWebhook: "incomingMessageReceived",
      senderData: { chatId: "972501111111@c.us", senderName: "Yossi" },
    });

    expect(mockNotifyOwnerOps).not.toHaveBeenCalled();
    const resolveCall = mockPoolQuery.mock.calls.find(
      ([sql]) => String(sql).includes("state='resolved'") && String(sql).includes("blocks_rest_of_day=true"),
    );
    expect(resolveCall).toBeDefined();
    expect(resolveCall![1]).toEqual(["row-5"]);
  });

  it("pending_followup + a reaction: also resolves WITH day-block, silently", async () => {
    mockPoolQuery.mockImplementationOnce(() =>
      Promise.resolve({ rows: [{ id: "row-6", chat_id: "972501111111@c.us", state: "pending_followup" }] }),
    );
    mockExtractButtonId.mockReturnValue("");

    await handleOpInstanceEvent({
      typeWebhook: "incomingMessageReceived",
      senderData: { chatId: "972501111111@c.us", senderName: "Yossi" },
      messageData: { typeMessage: "reactionMessage" },
    });

    expect(mockNotifyOwnerOps).not.toHaveBeenCalled();
    const resolveCall = mockPoolQuery.mock.calls.find(
      ([sql]) => String(sql).includes("state='resolved'") && String(sql).includes("blocks_rest_of_day=true"),
    );
    expect(resolveCall).toBeDefined();
    expect(resolveCall![1]).toEqual(["row-6"]);
  });
});

// ---------------------------------------------------------------------------
// handleOpInstanceEvent — exclusions
// ---------------------------------------------------------------------------

describe("handleOpInstanceEvent — exclusions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("group chat (@g.us) is skipped without any DB query", async () => {
    await handleOpInstanceEvent({
      typeWebhook: "incomingMessageReceived",
      senderData: { chatId: "123456-1600000000@g.us", senderName: "Group" },
    });

    expect(mockPoolQuery).not.toHaveBeenCalled();
    expect(mockFromImpl).not.toHaveBeenCalled();
  });

  it("a staff member's phone is excluded", async () => {
    setupExclusionQueries({ staffPhones: ["972501111111"] });

    await handleOpInstanceEvent({
      typeWebhook: "incomingMessageReceived",
      senderData: { chatId: "972501111111@c.us", senderName: "Staffer" },
    });

    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it("the SUMMARY_RECIPIENT_PHONE (owner) is excluded", async () => {
    setupExclusionQueries();

    await handleOpInstanceEvent({
      typeWebhook: "incomingMessageReceived",
      senderData: { chatId: "972500000000@c.us", senderName: "Didi" },
    });

    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it("the commitment_self_chat_id (system_settings) is excluded", async () => {
    setupExclusionQueries({ selfChatId: "972509999999@c.us" });

    await handleOpInstanceEvent({
      typeWebhook: "incomingMessageReceived",
      senderData: { chatId: "972509999999@c.us", senderName: "Self" },
    });

    expect(mockPoolQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// sweepUnanswered
// ---------------------------------------------------------------------------

describe("sweepUnanswered", () => {
  const CREDS = { idInstance: "op-id", token: "op-token", baseUrl: "https://test.api.greenapi.com" };

  // 2026-07-05 is a Sunday — well within the Sun-Thu 09:00-18:00 window at 13:00 IST.
  const WITHIN_WINDOW_NOW = new Date("2026-07-05T10:00:00Z");

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(WITHIN_WINDOW_NOW);
    mockOpCreds.mockReturnValue(CREDS);
    mockSendInteractiveButtonsWith.mockResolvedValue({ idMessage: "x" });
    mockSleep.mockResolvedValue(undefined);
    mockNeedsReplyFromDidi.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("no-ops when opCreds() is null", async () => {
    mockOpCreds.mockReturnValue(null);

    const result = await sweepUnanswered();

    expect(result).toEqual({ processed: 0, autoReplied: 0, skipped: 0, closedByLlm: 0 });
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it("sends buttons and transitions watching -> pending_followup", async () => {
    mockPoolQuery.mockImplementation((sql: string) => {
      if (sql.includes("state = 'watching'")) {
        return Promise.resolve({ rows: [{ id: "row-1", chat_id: "972501111111@c.us" }] });
      }
      if (sql.includes("count(*)::int")) {
        return Promise.resolve({ rows: [{ c: 0 }] });
      }
      if (sql.includes("SELECT state FROM")) {
        return Promise.resolve({ rows: [{ state: "watching" }] });
      }
      if (sql.includes("SELECT 1 FROM public.wa_unanswered")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    const result = await sweepUnanswered();

    expect(result.autoReplied).toBe(1);
    expect(result.skipped).toBe(0);
    expect(mockSendInteractiveButtonsWith).toHaveBeenCalledWith(
      CREDS,
      "972501111111@c.us",
      AUTO_REPLY_TEXT,
      AUTO_REPLY_BUTTONS,
    );
    const updateCall = mockPoolQuery.mock.calls.find(
      ([sql]) => String(sql).includes("state='pending_followup'") && String(sql).includes("auto_replied_at=now()"),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![1]).toEqual(["row-1"]);
  });

  it("outside the watch window: expires all watching rows and sends nothing", async () => {
    // 2026-07-05 is a Sunday. 20:30 IST = 17:30 UTC — after the 18:00 close.
    vi.setSystemTime(new Date("2026-07-05T17:30:00Z"));
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 4 });

    const result = await sweepUnanswered();

    expect(result).toEqual({ processed: 0, autoReplied: 0, skipped: 0, closedByLlm: 0 });
    expect(mockNeedsReplyFromDidi).not.toHaveBeenCalled();
    expect(mockSendInteractiveButtonsWith).not.toHaveBeenCalled();
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    const expireCall = mockPoolQuery.mock.calls[0];
    expect(String(expireCall[0])).toContain("state='expired'");
    expect(String(expireCall[0])).toContain("WHERE state='watching'");
  });

  it("resolves WITH day-block (no reminder eligibility) when an auto-reply was already sent today for that chat", async () => {
    mockPoolQuery.mockImplementation((sql: string) => {
      if (sql.includes("state = 'watching'")) {
        return Promise.resolve({ rows: [{ id: "row-1", chat_id: "972501111111@c.us" }] });
      }
      if (sql.includes("count(*)::int")) {
        return Promise.resolve({ rows: [{ c: 0 }] });
      }
      if (sql.includes("SELECT 1 FROM public.wa_unanswered")) {
        return Promise.resolve({ rows: [{ x: 1 }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    const result = await sweepUnanswered();

    expect(result.skipped).toBe(1);
    expect(result.autoReplied).toBe(0);
    expect(mockSendInteractiveButtonsWith).not.toHaveBeenCalled();
    const resolveCall = mockPoolQuery.mock.calls.find(
      ([sql]) => String(sql).includes("state='resolved'") && String(sql).includes("blocks_rest_of_day=true"),
    );
    expect(resolveCall).toBeDefined();
    expect(resolveCall![1]).toEqual(["row-1"]);
  });

  it("enforces the daily auto-reply cap: the 21st eligible chat expires without paying the LLM call", async () => {
    const rows = Array.from({ length: 21 }, (_, i) => ({ id: `row-${i}`, chat_id: `97250000${String(i).padStart(3, "0")}@c.us` }));
    mockPoolQuery.mockImplementation((sql: string) => {
      if (sql.includes("state = 'watching'")) {
        return Promise.resolve({ rows });
      }
      if (sql.includes("count(*)::int")) {
        return Promise.resolve({ rows: [{ c: 0 }] });
      }
      if (sql.includes("SELECT state FROM")) {
        return Promise.resolve({ rows: [{ state: "watching" }] });
      }
      if (sql.includes("SELECT 1 FROM public.wa_unanswered")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    const result = await sweepUnanswered();

    expect(result.autoReplied).toBe(20);
    expect(result.skipped).toBe(1);
    expect(mockSendInteractiveButtonsWith).toHaveBeenCalledTimes(20);
    // Cap check runs before the LLM gate — the capped row must not burn a Gemini call.
    expect(mockNeedsReplyFromDidi).toHaveBeenCalledTimes(20);
    const expireCall = mockPoolQuery.mock.calls.find(
      ([sql, params]) => String(sql).includes("state='expired'") && String((params as unknown[])?.[0]) === "row-20",
    );
    expect(expireCall).toBeDefined();
  });

  it("race guard: a row resolved mid-sweep (Didi answered) is skipped — no send", async () => {
    mockPoolQuery.mockImplementation((sql: string) => {
      if (sql.includes("state = 'watching'")) {
        return Promise.resolve({ rows: [{ id: "row-1", chat_id: "972501111111@c.us" }] });
      }
      if (sql.includes("count(*)::int")) return Promise.resolve({ rows: [{ c: 0 }] });
      if (sql.includes("SELECT state FROM")) return Promise.resolve({ rows: [{ state: "resolved" }] });
      if (sql.includes("SELECT 1 FROM public.wa_unanswered")) return Promise.resolve({ rows: [], rowCount: 0 });
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    const result = await sweepUnanswered();

    expect(result.autoReplied).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mockSendInteractiveButtonsWith).not.toHaveBeenCalled();
  });

  it("paces sends 20s apart (sleep called once for 2 sends)", async () => {
    const rows = [
      { id: "row-1", chat_id: "972501111111@c.us" },
      { id: "row-2", chat_id: "972502222222@c.us" },
    ];
    mockPoolQuery.mockImplementation((sql: string) => {
      if (sql.includes("state = 'watching'")) return Promise.resolve({ rows });
      if (sql.includes("count(*)::int")) return Promise.resolve({ rows: [{ c: 0 }] });
      if (sql.includes("SELECT state FROM")) return Promise.resolve({ rows: [{ state: "watching" }] });
      if (sql.includes("SELECT 1 FROM public.wa_unanswered")) return Promise.resolve({ rows: [], rowCount: 0 });
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    await sweepUnanswered();

    expect(mockSleep).toHaveBeenCalledTimes(1);
    expect(mockSleep).toHaveBeenCalledWith(20_000);
  });

  it("LLM gate: a closer judgment resolves the row without sending, counted under closedByLlm", async () => {
    mockNeedsReplyFromDidi.mockResolvedValue(false);
    mockPoolQuery.mockImplementation((sql: string) => {
      if (sql.includes("state = 'watching'")) {
        return Promise.resolve({ rows: [{ id: "row-1", chat_id: "972501111111@c.us" }] });
      }
      if (sql.includes("count(*)::int")) return Promise.resolve({ rows: [{ c: 0 }] });
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    const result = await sweepUnanswered();

    expect(result.closedByLlm).toBe(1);
    expect(result.autoReplied).toBe(0);
    expect(mockSendInteractiveButtonsWith).not.toHaveBeenCalled();
    const resolveCall = mockPoolQuery.mock.calls.find(([sql]) => String(sql).includes("state='resolved'"));
    expect(resolveCall).toBeDefined();
    expect(resolveCall![1]).toEqual(["row-1"]);
  });

  it("LLM gate: a needs-reply judgment proceeds to the normal auto-reply send", async () => {
    mockNeedsReplyFromDidi.mockResolvedValue(true);
    mockPoolQuery.mockImplementation((sql: string) => {
      if (sql.includes("state = 'watching'")) {
        return Promise.resolve({ rows: [{ id: "row-1", chat_id: "972501111111@c.us" }] });
      }
      if (sql.includes("count(*)::int")) return Promise.resolve({ rows: [{ c: 0 }] });
      if (sql.includes("SELECT state FROM")) return Promise.resolve({ rows: [{ state: "watching" }] });
      if (sql.includes("SELECT 1 FROM public.wa_unanswered")) return Promise.resolve({ rows: [], rowCount: 0 });
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    const result = await sweepUnanswered();

    expect(result.closedByLlm).toBe(0);
    expect(result.autoReplied).toBe(1);
    expect(mockSendInteractiveButtonsWith).toHaveBeenCalledWith(
      CREDS,
      "972501111111@c.us",
      AUTO_REPLY_TEXT,
      AUTO_REPLY_BUTTONS,
    );
  });

  it("dedupe-hit: a row already auto-replied today is resolved WITH day-block, no send", async () => {
    mockPoolQuery.mockImplementation((sql: string) => {
      if (sql.includes("state = 'watching'")) {
        return Promise.resolve({ rows: [{ id: "row-1", chat_id: "972501111111@c.us" }] });
      }
      if (sql.includes("count(*)::int")) return Promise.resolve({ rows: [{ c: 0 }] });
      if (sql.includes("SELECT 1 FROM public.wa_unanswered")) return Promise.resolve({ rows: [{ x: 1 }], rowCount: 1 });
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    const result = await sweepUnanswered();

    expect(result.skipped).toBe(1);
    expect(mockSendInteractiveButtonsWith).not.toHaveBeenCalled();
    const resolveCall = mockPoolQuery.mock.calls.find(
      ([sql]) => String(sql).includes("state='resolved'") && String(sql).includes("blocks_rest_of_day=true"),
    );
    expect(resolveCall).toBeDefined();
    expect(resolveCall![1]).toEqual(["row-1"]);
  });

});

// ---------------------------------------------------------------------------
// sendCallbackReminders
// ---------------------------------------------------------------------------

describe("sendCallbackReminders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // 2026-07-05 is a Sunday — a business day for the reminder pass.
    vi.setSystemTime(new Date("2026-07-05T06:00:00Z"));
    mockNotifyOwnerOps.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("aggregates unreminded callback rows into a single owner notify and stamps callback_reminded_at", async () => {
    mockPoolQuery.mockImplementation((sql: string) => {
      if (sql.includes("callback_requested_at IS NOT NULL AND callback_reminded_at IS NULL")) {
        return Promise.resolve({
          rows: [
            { id: "row-1", chat_id: "972501111111@c.us", sender_name: "Yossi" },
            { id: "row-2", chat_id: "972502222222@c.us", sender_name: null },
          ],
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const result = await sendCallbackReminders();

    expect(result.reminded).toBe(2);
    expect(mockNotifyOwnerOps).toHaveBeenCalledOnce();
    const [message] = mockNotifyOwnerOps.mock.calls[0] as [string];
    expect(message).toContain("Yossi");
    expect(message).toContain("050-1111111");
    expect(message).toContain("050-2222222");

    const stampCall = mockPoolQuery.mock.calls.find(
      ([sql]) => String(sql).includes("callback_reminded_at=now()") && String(sql).includes("id = ANY($1)"),
    );
    expect(stampCall).toBeDefined();
    expect(stampCall![1]).toEqual([["row-1", "row-2"]]);
  });

  it("Friday: defers reminders + daily reset to Sunday, but housekeeping still runs", async () => {
    // 2026-07-10 is a Friday.
    vi.setSystemTime(new Date("2026-07-10T06:00:00Z"));
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 3 });

    const result = await sendCallbackReminders();

    expect(mockNotifyOwnerOps).not.toHaveBeenCalled();
    expect(result.reminded).toBe(0);
    expect(result.expired).toBe(0);
    expect(result.deleted).toBe(3);
    // No callback-rows SELECT ran (the housekeeping DELETE shares the predicate text,
    // so match on the SELECT's own column list instead)
    expect(
      mockPoolQuery.mock.calls.find(([sql]) => String(sql).includes("SELECT id, chat_id, sender_name")),
    ).toBeUndefined();
    const deleteCall = mockPoolQuery.mock.calls.find(([sql]) => String(sql).includes("DELETE FROM public.wa_unanswered"));
    expect(deleteCall).toBeDefined();
  });

  it("owner notify fails: rows are NOT stamped (left for tomorrow's retry), reminded=0", async () => {
    mockNotifyOwnerOps.mockResolvedValue(false);
    mockPoolQuery.mockImplementation((sql: string) => {
      if (sql.includes("callback_requested_at IS NOT NULL AND callback_reminded_at IS NULL")) {
        return Promise.resolve({ rows: [{ id: "row-1", chat_id: "972501111111@c.us", sender_name: "Yossi" }] });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const result = await sendCallbackReminders();

    expect(result.reminded).toBe(0);
    expect(mockNotifyOwnerOps).toHaveBeenCalledOnce();
    const stampCall = mockPoolQuery.mock.calls.find(([sql]) => String(sql).includes("callback_reminded_at=now()"));
    expect(stampCall).toBeUndefined();
  });

  it("zero unreminded callback rows: no notify sent", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const result = await sendCallbackReminders();

    expect(result.reminded).toBe(0);
    expect(mockNotifyOwnerOps).not.toHaveBeenCalled();
  });

  it("expires yesterday's pending_followup rows (auto_replied_at before today's Israel day start)", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    await sendCallbackReminders();

    const expireCall = mockPoolQuery.mock.calls.find(
      ([sql]) => String(sql).includes("state='expired'") && String(sql).includes("state='pending_followup'"),
    );
    expect(expireCall).toBeDefined();
  });

  it("housekeeping delete excludes rows with an unreminded callback request", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    await sendCallbackReminders();

    const deleteCall = mockPoolQuery.mock.calls.find(([sql]) => String(sql).includes("DELETE FROM public.wa_unanswered"));
    expect(deleteCall).toBeDefined();
    expect(String(deleteCall![0])).toContain(
      "AND NOT (callback_requested_at IS NOT NULL AND callback_reminded_at IS NULL)",
    );
  });

  it("mode=log: no notify sent and rows are NOT stamped (kept intact for the send-mode flip)", async () => {
    await setUnansweredWaMode("log");
    try {
      mockPoolQuery.mockImplementation((sql: string) => {
        if (sql.includes("callback_requested_at IS NOT NULL AND callback_reminded_at IS NULL")) {
          return Promise.resolve({ rows: [{ id: "row-1", chat_id: "972501111111@c.us", sender_name: "Yossi" }] });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      const result = await sendCallbackReminders();

      expect(result.reminded).toBe(0);
      expect(mockNotifyOwnerOps).not.toHaveBeenCalled();
      const stampCall = mockPoolQuery.mock.calls.find(([sql]) =>
        String(sql).includes("callback_reminded_at=now()"),
      );
      expect(stampCall).toBeUndefined();
    } finally {
      await setUnansweredWaMode("send");
    }
  });
});

// ---------------------------------------------------------------------------
// UNANSWERED_WA_MODE — 3-mode kill switch
// ---------------------------------------------------------------------------

async function setUnansweredWaMode(mode: "off" | "log" | "send"): Promise<void> {
  const { env } = await import("../../config/env.js");
  (env as Record<string, unknown>)["UNANSWERED_WA_MODE"] = mode;
}

describe("handleOpInstanceEvent — mode=off", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await setUnansweredWaMode("off");
  });

  afterEach(async () => {
    await setUnansweredWaMode("send");
  });

  it("does nothing — no row created, no DB queries at all", async () => {
    await handleOpInstanceEvent({
      typeWebhook: "incomingMessageReceived",
      senderData: { chatId: "972501111111@c.us", senderName: "Yossi" },
      timestamp: Math.floor(new Date("2026-07-05T10:00:00Z").getTime() / 1000),
    });

    expect(mockPoolQuery).not.toHaveBeenCalled();
    expect(mockFromImpl).not.toHaveBeenCalled();
  });
});

describe("sweepUnanswered — mode=off", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await setUnansweredWaMode("off");
  });

  afterEach(async () => {
    await setUnansweredWaMode("send");
  });

  it("skips the pipeline, expires all active rows, returns zeroed counters", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 3 });

    const result = await sweepUnanswered();

    expect(result).toEqual({ processed: 0, autoReplied: 0, skipped: 0, closedByLlm: 0 });
    expect(mockOpCreds).not.toHaveBeenCalled();
    expect(mockNeedsReplyFromDidi).not.toHaveBeenCalled();
    expect(mockSendInteractiveButtonsWith).not.toHaveBeenCalled();
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    const expireCall = mockPoolQuery.mock.calls[0];
    expect(String(expireCall[0])).toContain("state='expired'");
    expect(String(expireCall[0])).toContain(
      "WHERE state IN ('watching','awaiting_reply','pending_followup')",
    );
  });
});

describe("sweepUnanswered — mode=log", () => {
  const CREDS = { idInstance: "op-id", token: "op-token", baseUrl: "https://test.api.greenapi.com" };

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // 2026-07-05 is a Sunday, 13:00 IST — inside the window.
    vi.setSystemTime(new Date("2026-07-05T10:00:00Z"));
    await setUnansweredWaMode("log");
    mockOpCreds.mockReturnValue(CREDS);
    mockSleep.mockResolvedValue(undefined);
    mockNeedsReplyFromDidi.mockResolvedValue(true);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await setUnansweredWaMode("send");
  });

  it("does not call sendInteractiveButtonsWith but still stamps auto_replied_at and counts the reply", async () => {
    mockPoolQuery.mockImplementation((sql: string) => {
      if (sql.includes("state = 'watching'")) {
        return Promise.resolve({ rows: [{ id: "row-1", chat_id: "972501111111@c.us" }] });
      }
      if (sql.includes("count(*)::int")) {
        return Promise.resolve({ rows: [{ c: 0 }] });
      }
      if (sql.includes("SELECT state FROM")) {
        return Promise.resolve({ rows: [{ state: "watching" }] });
      }
      if (sql.includes("SELECT 1 FROM public.wa_unanswered")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    const result = await sweepUnanswered();

    expect(result.autoReplied).toBe(1);
    expect(mockSendInteractiveButtonsWith).not.toHaveBeenCalled();
    const updateCall = mockPoolQuery.mock.calls.find(
      ([sql]) => String(sql).includes("state='pending_followup'") && String(sql).includes("auto_replied_at=now()"),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![1]).toEqual(["row-1"]);
  });
});

describe("sendCallbackReminders — mode=off", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await setUnansweredWaMode("off");
  });

  afterEach(async () => {
    await setUnansweredWaMode("send");
  });

  it("skips reminder + expiry work but still runs the housekeeping delete", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 2 });

    const result = await sendCallbackReminders();

    expect(mockNotifyOwnerOps).not.toHaveBeenCalled();
    expect(result.reminded).toBe(0);
    expect(result.expired).toBe(0);
    expect(result.deleted).toBe(2);
  });
});
