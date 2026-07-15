import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock functions
// ---------------------------------------------------------------------------
const {
  mockPoolQuery,
  mockFromImpl,
  mockOpCreds,
  mockSendMessageWith,
  mockSendInteractiveButtonsWith,
  mockNotifyOwnerOps,
  mockExtractButtonId,
  mockSleep,
  mockNeedsReplyFromDidi,
} = vi.hoisted(() => ({
  mockPoolQuery: vi.fn(),
  mockFromImpl: vi.fn(),
  mockOpCreds: vi.fn(),
  mockSendMessageWith: vi.fn(),
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
  sendMessageWith: mockSendMessageWith,
  sendInteractiveButtonsWith: mockSendInteractiveButtonsWith,
  sendMessageWithTyping: vi.fn(),
}));

// Use the REAL toChatId (pure), mock only extractButtonId
vi.mock("../whatsapp/whatsapp.util.js", async () => {
  const actual = await vi.importActual<typeof import("../whatsapp/whatsapp.util.js")>("../whatsapp/whatsapp.util.js");
  return {
    toChatId: actual.toChatId,
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
  sendUnansweredFollowups,
  isWithinWatchWindow,
  AUTO_REPLY_TEXT,
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
// isWithinWatchWindow — Israel TZ window boundaries (07:00-20:00 inclusive)
// ---------------------------------------------------------------------------

describe("isWithinWatchWindow", () => {
  it("06:59 Israel summer (UTC+3) is outside the window", () => {
    expect(isWithinWatchWindow(new Date("2026-07-01T03:59:00Z"))).toBe(false);
  });

  it("07:00 Israel summer (UTC+3) is inside the window", () => {
    expect(isWithinWatchWindow(new Date("2026-07-01T04:00:00Z"))).toBe(true);
  });

  it("19:59 Israel summer (UTC+3) is inside the window", () => {
    expect(isWithinWatchWindow(new Date("2026-07-01T16:59:00Z"))).toBe(true);
  });

  it("20:01 Israel summer (UTC+3) is outside the window", () => {
    expect(isWithinWatchWindow(new Date("2026-07-01T17:01:00Z"))).toBe(false);
  });

  it("06:59 Israel winter (UTC+2) is outside the window", () => {
    expect(isWithinWatchWindow(new Date("2026-01-15T04:59:00Z"))).toBe(false);
  });

  it("07:00 Israel winter (UTC+2) is inside the window", () => {
    expect(isWithinWatchWindow(new Date("2026-01-15T05:00:00Z"))).toBe(true);
  });

  it("19:59 Israel winter (UTC+2) is inside the window", () => {
    expect(isWithinWatchWindow(new Date("2026-01-15T17:59:00Z"))).toBe(true);
  });

  it("20:01 Israel winter (UTC+2) is outside the window", () => {
    expect(isWithinWatchWindow(new Date("2026-01-15T18:01:00Z"))).toBe(false);
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
      timestamp: Math.floor(new Date("2026-07-01T10:00:00Z").getTime() / 1000), // 13:00 IST summer
    });

    const insertCall = mockPoolQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO public.wa_unanswered"),
    );
    expect(insertCall).toBeDefined();
    expect(insertCall![1]).toEqual(["972501111111@c.us", "Yossi", "2026-07-01T10:00:00.000Z"]);
  });

  it("does nothing when the message is outside the watch window", async () => {
    await handleOpInstanceEvent({
      typeWebhook: "incomingMessageReceived",
      senderData: { chatId: "972501111111@c.us", senderName: "Yossi" },
      timestamp: Math.floor(new Date("2026-07-01T17:30:00Z").getTime() / 1000), // 20:30 IST summer
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
        timestamp: Math.floor(new Date("2026-07-01T17:30:00Z").getTime() / 1000), // 20:30 IST summer
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
      timestamp: Math.floor(new Date("2026-07-01T10:00:00Z").getTime() / 1000), // 13:00 IST summer
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
        timestamp: Math.floor(new Date("2026-07-01T10:00:00Z").getTime() / 1000),
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
      timestamp: Math.floor(new Date("2026-07-01T10:00:00Z").getTime() / 1000),
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
      timestamp: Math.floor(new Date("2026-07-01T10:00:00Z").getTime() / 1000), // 13:00 IST summer
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

  it("watching + incoming message: leaves state as-is (no insert, no update)", async () => {
    mockPoolQuery.mockImplementationOnce(() =>
      Promise.resolve({ rows: [{ id: "row-1", chat_id: "972501111111@c.us", state: "watching" }] }),
    );

    await handleOpInstanceEvent({
      typeWebhook: "incomingMessageReceived",
      senderData: { chatId: "972501111111@c.us", senderName: "Yossi" },
    });

    expect(mockPoolQuery).toHaveBeenCalledTimes(1); // only the active-row select
  });

  it("awaiting_reply + incoming message: resolves the row WITH day-block (any reply cancels follow-up)", async () => {
    mockPoolQuery.mockImplementationOnce(() =>
      Promise.resolve({ rows: [{ id: "row-2", chat_id: "972501111111@c.us", state: "awaiting_reply" }] }),
    );

    await handleOpInstanceEvent({
      typeWebhook: "incomingMessageReceived",
      senderData: { chatId: "972501111111@c.us", senderName: "Yossi" },
    });

    const resolveCall = mockPoolQuery.mock.calls.find(
      ([sql]) => String(sql).includes("state='resolved'") && String(sql).includes("blocks_rest_of_day=true"),
    );
    expect(resolveCall).toBeDefined();
    expect(resolveCall![1]).toEqual(["row-2"]);
  });

  it("awaiting_reply + a reaction: also resolves the row WITH day-block", async () => {
    mockPoolQuery.mockImplementationOnce(() =>
      Promise.resolve({ rows: [{ id: "row-2b", chat_id: "972501111111@c.us", state: "awaiting_reply" }] }),
    );

    await handleOpInstanceEvent({
      typeWebhook: "incomingMessageReceived",
      senderData: { chatId: "972501111111@c.us", senderName: "Yossi" },
      messageData: { typeMessage: "reactionMessage" },
    });

    const resolveCall = mockPoolQuery.mock.calls.find(
      ([sql]) => String(sql).includes("state='resolved'") && String(sql).includes("blocks_rest_of_day=true"),
    );
    expect(resolveCall).toBeDefined();
    expect(resolveCall![1]).toEqual(["row-2b"]);
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

  it("pending_followup + ua_ok: resolves WITH day-block, WITHOUT alerting Didi", async () => {
    mockPoolQuery.mockImplementationOnce(() =>
      Promise.resolve({ rows: [{ id: "row-3", chat_id: "972501111111@c.us", state: "pending_followup" }] }),
    );
    mockExtractButtonId.mockReturnValue("ua_ok");

    await handleOpInstanceEvent({
      typeWebhook: "incomingMessageReceived",
      senderData: { chatId: "972501111111@c.us", senderName: "Yossi" },
    });

    expect(mockNotifyOwnerOps).not.toHaveBeenCalled();
    const resolveCall = mockPoolQuery.mock.calls.find(
      ([sql]) => String(sql).includes("state='resolved'") && String(sql).includes("blocks_rest_of_day=true"),
    );
    expect(resolveCall).toBeDefined();
    expect(resolveCall![1]).toEqual(["row-3"]);
  });

  it("pending_followup + ua_callback: alerts Didi via notifyOwnerOps, then resolves WITH day-block", async () => {
    mockPoolQuery.mockImplementationOnce(() =>
      Promise.resolve({ rows: [{ id: "row-4", chat_id: "972501111111@c.us", state: "pending_followup" }] }),
    );
    mockExtractButtonId.mockReturnValue("ua_callback");

    await handleOpInstanceEvent({
      typeWebhook: "incomingMessageReceived",
      senderData: { chatId: "972501111111@c.us", senderName: "Yossi" },
    });

    expect(mockNotifyOwnerOps).toHaveBeenCalledOnce();
    const [text] = mockNotifyOwnerOps.mock.calls[0] as [string];
    expect(text).toContain("Yossi");
    expect(text).toContain("972501111111");
    const resolveCall = mockPoolQuery.mock.calls.find(
      ([sql]) => String(sql).includes("state='resolved'") && String(sql).includes("blocks_rest_of_day=true"),
    );
    expect(resolveCall).toBeDefined();
    expect(resolveCall![1]).toEqual(["row-4"]);
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

  beforeEach(() => {
    vi.clearAllMocks();
    mockOpCreds.mockReturnValue(CREDS);
    mockSendMessageWith.mockResolvedValue({ idMessage: "x" });
    mockSleep.mockResolvedValue(undefined);
    mockNeedsReplyFromDidi.mockResolvedValue(true);
  });

  it("no-ops when opCreds() is null", async () => {
    mockOpCreds.mockReturnValue(null);

    const result = await sweepUnanswered();

    expect(result).toEqual({ processed: 0, autoReplied: 0, skipped: 0, closedByLlm: 0 });
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it("sends an auto-reply and transitions watching -> awaiting_reply", async () => {
    mockPoolQuery.mockImplementation((sql: string) => {
      if (sql.includes("state = 'watching'")) {
        return Promise.resolve({ rows: [{ id: "row-1", chat_id: "972501111111@c.us" }] });
      }
      if (sql.includes("count(*)::int")) {
        return Promise.resolve({ rows: [{ c: 0 }] });
      }
      if (sql.includes("SELECT 1 FROM public.wa_unanswered")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    const result = await sweepUnanswered();

    expect(result.autoReplied).toBe(1);
    expect(result.skipped).toBe(0);
    expect(mockSendMessageWith).toHaveBeenCalledWith(CREDS, "972501111111@c.us", AUTO_REPLY_TEXT);
  });

  it("resolves WITH day-block (no follow-up eligibility) when an auto-reply was already sent today for that chat", async () => {
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
    expect(mockSendMessageWith).not.toHaveBeenCalled();
    const resolveCall = mockPoolQuery.mock.calls.find(
      ([sql]) => String(sql).includes("state='resolved'") && String(sql).includes("blocks_rest_of_day=true"),
    );
    expect(resolveCall).toBeDefined();
    expect(resolveCall![1]).toEqual(["row-1"]);
  });

  it("enforces the daily auto-reply cap: the 21st eligible chat is skipped, not sent", async () => {
    const rows = Array.from({ length: 21 }, (_, i) => ({ id: `row-${i}`, chat_id: `97250000${String(i).padStart(3, "0")}@c.us` }));
    mockPoolQuery.mockImplementation((sql: string) => {
      if (sql.includes("state = 'watching'")) {
        return Promise.resolve({ rows });
      }
      if (sql.includes("count(*)::int")) {
        return Promise.resolve({ rows: [{ c: 0 }] });
      }
      if (sql.includes("SELECT 1 FROM public.wa_unanswered")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    const result = await sweepUnanswered();

    expect(result.autoReplied).toBe(20);
    expect(result.skipped).toBe(1);
    expect(mockSendMessageWith).toHaveBeenCalledTimes(20);
    const expireCall = mockPoolQuery.mock.calls.find(
      ([sql, params]) => String(sql).includes("state='expired'") && String((params as unknown[])?.[0]) === "row-20",
    );
    expect(expireCall).toBeDefined();
  });

  it("paces sends 20s apart (sleep called once for 2 sends)", async () => {
    const rows = [
      { id: "row-1", chat_id: "972501111111@c.us" },
      { id: "row-2", chat_id: "972502222222@c.us" },
    ];
    mockPoolQuery.mockImplementation((sql: string) => {
      if (sql.includes("state = 'watching'")) return Promise.resolve({ rows });
      if (sql.includes("count(*)::int")) return Promise.resolve({ rows: [{ c: 0 }] });
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
    expect(mockSendMessageWith).not.toHaveBeenCalled();
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
      if (sql.includes("SELECT 1 FROM public.wa_unanswered")) return Promise.resolve({ rows: [], rowCount: 0 });
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    const result = await sweepUnanswered();

    expect(result.closedByLlm).toBe(0);
    expect(result.autoReplied).toBe(1);
    expect(mockSendMessageWith).toHaveBeenCalledWith(CREDS, "972501111111@c.us", AUTO_REPLY_TEXT);
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
    expect(mockSendMessageWith).not.toHaveBeenCalled();
    const resolveCall = mockPoolQuery.mock.calls.find(
      ([sql]) => String(sql).includes("state='resolved'") && String(sql).includes("blocks_rest_of_day=true"),
    );
    expect(resolveCall).toBeDefined();
    expect(resolveCall![1]).toEqual(["row-1"]);
  });

  it("cap-hit: the 21st eligible row expires (not resolved, not day-blocked), no send", async () => {
    const rows = Array.from({ length: 21 }, (_, i) => ({ id: `row-${i}`, chat_id: `97250000${String(i).padStart(3, "0")}@c.us` }));
    mockPoolQuery.mockImplementation((sql: string) => {
      if (sql.includes("state = 'watching'")) return Promise.resolve({ rows });
      if (sql.includes("count(*)::int")) return Promise.resolve({ rows: [{ c: 0 }] });
      if (sql.includes("SELECT 1 FROM public.wa_unanswered")) return Promise.resolve({ rows: [], rowCount: 0 });
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    const result = await sweepUnanswered();

    expect(result.skipped).toBe(1);
    expect(mockSendMessageWith).toHaveBeenCalledTimes(20);
    const expireCall = mockPoolQuery.mock.calls.find(
      ([sql, params]) => String(sql).includes("state='expired'") && String((params as unknown[])?.[0]) === "row-20",
    );
    expect(expireCall).toBeDefined();
  });

  it("midnight expiry: expires yesterday's pending_followup rows via the daily-reset update", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    await sweepUnanswered();

    const expireCall = mockPoolQuery.mock.calls.find(
      ([sql]) => String(sql).includes("state='expired'") && String(sql).includes("state='pending_followup'"),
    );
    expect(expireCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// sendUnansweredFollowups
// ---------------------------------------------------------------------------

describe("sendUnansweredFollowups", () => {
  const CREDS = { idInstance: "op-id", token: "op-token", baseUrl: "https://test.api.greenapi.com" };

  beforeEach(() => {
    vi.clearAllMocks();
    mockOpCreds.mockReturnValue(CREDS);
    mockSendInteractiveButtonsWith.mockResolvedValue({ idMessage: "x" });
    mockSleep.mockResolvedValue(undefined);
  });

  it("sends follow-up buttons and transitions awaiting_reply -> pending_followup", async () => {
    mockPoolQuery.mockImplementation((sql: string) => {
      if (sql.includes("state = 'awaiting_reply'")) {
        return Promise.resolve({ rows: [{ id: "row-1", chat_id: "972501111111@c.us" }] });
      }
      if (sql.includes("count(*)::int")) {
        return Promise.resolve({ rows: [{ c: 0 }] });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const result = await sendUnansweredFollowups();

    expect(result.followupsSent).toBe(1);
    expect(mockSendInteractiveButtonsWith).toHaveBeenCalledOnce();
    const call = mockSendInteractiveButtonsWith.mock.calls[0] as [unknown, string, string, unknown];
    expect(call[0]).toEqual(CREDS);
    expect(call[1]).toBe("972501111111@c.us");
  });

  it("enforces the daily follow-up cap: the 41st eligible chat is expired, not sent", async () => {
    const rows = Array.from({ length: 41 }, (_, i) => ({ id: `row-${i}`, chat_id: `97250000${String(i).padStart(3, "0")}@c.us` }));
    mockPoolQuery.mockImplementation((sql: string) => {
      if (sql.includes("state = 'awaiting_reply'")) {
        return Promise.resolve({ rows });
      }
      if (sql.includes("count(*)::int")) {
        return Promise.resolve({ rows: [{ c: 0 }] });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const result = await sendUnansweredFollowups();

    expect(result.followupsSent).toBe(40);
    expect(mockSendInteractiveButtonsWith).toHaveBeenCalledTimes(40);
    expect(result.expired).toBeGreaterThanOrEqual(1);
  });

  it("paces sends 20s apart (sleep called once for 2 sends)", async () => {
    const rows = [
      { id: "row-1", chat_id: "972501111111@c.us" },
      { id: "row-2", chat_id: "972502222222@c.us" },
    ];
    mockPoolQuery.mockImplementation((sql: string) => {
      if (sql.includes("state = 'awaiting_reply'")) return Promise.resolve({ rows });
      if (sql.includes("count(*)::int")) return Promise.resolve({ rows: [{ c: 0 }] });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    await sendUnansweredFollowups();

    expect(mockSleep).toHaveBeenCalledTimes(1);
    expect(mockSleep).toHaveBeenCalledWith(20_000);
  });

  it("still runs housekeeping even when opCreds() is null (no sends, no expiry — that now lives in sweepUnanswered)", async () => {
    mockOpCreds.mockReturnValue(null);
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 3 });

    const result = await sendUnansweredFollowups();

    expect(mockSendInteractiveButtonsWith).not.toHaveBeenCalled();
    expect(result.followupsSent).toBe(0);
    expect(result.expired).toBe(0);
    expect(result.deleted).toBe(3);
  });

  it("eligibility query requires a non-NULL auto_replied_at — excludes rows never genuinely auto-replied", async () => {
    mockPoolQuery.mockImplementation((sql: string) => {
      if (sql.includes("state = 'awaiting_reply'")) {
        expect(sql).toContain("auto_replied_at IS NOT NULL");
        expect(sql).not.toContain("COALESCE");
        return Promise.resolve({ rows: [{ id: "row-1", chat_id: "972501111111@c.us" }] });
      }
      if (sql.includes("count(*)::int")) {
        return Promise.resolve({ rows: [{ c: 0 }] });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const result = await sendUnansweredFollowups();

    expect(result.followupsSent).toBe(1);
    expect(mockSendInteractiveButtonsWith).toHaveBeenCalledOnce();
  });
});
