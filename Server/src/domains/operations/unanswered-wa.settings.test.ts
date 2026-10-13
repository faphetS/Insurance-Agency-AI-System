import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock functions
// ---------------------------------------------------------------------------
const { mockPoolQuery, mockLogger } = vi.hoisted(() => ({
  mockPoolQuery: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Module mocks — declared before any project imports so Vitest hoists them
// ---------------------------------------------------------------------------
vi.mock("../../config/env.js", () => ({
  env: { NODE_ENV: "test" },
}));

vi.mock("../../config/logger.js", () => ({
  logger: mockLogger,
}));

vi.mock("../../lib/db.js", () => ({
  pool: { query: mockPoolQuery },
}));

// reminder.service.js (israelWallTimeInstant) pulls these in at import time.
vi.mock("../../config/supabase.js", () => ({
  supabaseAdmin: { from: vi.fn() },
}));

vi.mock("../whatsapp/whatsapp.service.js", () => ({
  sendMessageWithTyping: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Subject import (after mocks)
// ---------------------------------------------------------------------------
import {
  DEFAULT_AUTO_REPLY_TEXT,
  resolveAutoReply,
  getActiveAutoReplyText,
  getAutoReplyState,
  saveMessage,
  deleteMessage,
  restoreOriginal,
  useMessage,
  clearTemporary,
  parseUntil,
} from "./unanswered-wa.settings.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PERMANENT_KEY = "unanswered_wa_reply_permanent";
const TEMPORARY_KEY = "unanswered_wa_reply_temporary";
const HIDDEN_KEY = "unanswered_wa_reply_original_hidden";
const SAVED_ID = "3f2b8c1e-5d4a-4b7e-9c1d-2a6f8e0b1c3d";

const NOW = new Date("2026-10-13T10:00:00.000Z");
const inMinutes = (m: number) => new Date(NOW.getTime() + m * 60_000);

const hiddenRow = { key: HIDDEN_KEY, value: "true" };

const temporaryRow = (text: string, until: Date) => ({
  key: TEMPORARY_KEY,
  value: JSON.stringify({ text, until: until.toISOString() }),
});

type Route = [needle: string, result: unknown];

// Answers each query with the first route whose needle appears in the SQL. An unrouted query
// rejects, so a statement the code isn't supposed to issue fails the test loudly.
function routeQueries(...routes: Route[]) {
  mockPoolQuery.mockImplementation((sql: string) => {
    const hit = routes.find(([needle]) => sql.includes(needle));
    if (!hit) return Promise.reject(new Error(`unrouted query: ${sql}`));
    return Promise.resolve(hit[1]);
  });
}

const queriesMatching = (needle: string) =>
  mockPoolQuery.mock.calls.filter(([sql]) => String(sql).includes(needle));

function errorFrom(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to throw");
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPoolQuery.mockReset();
});

// ---------------------------------------------------------------------------
// DEFAULT_AUTO_REPLY_TEXT
// ---------------------------------------------------------------------------

describe("DEFAULT_AUTO_REPLY_TEXT", () => {
  it("is the original hardcoded auto-reply, unchanged", () => {
    expect(DEFAULT_AUTO_REPLY_TEXT).toBe(
      "היי זה דידי, אני בפגישה. אם מדובר במשהו שבמשרד יכולים לעזור, מוזמנים להתקשר או לשלוח וואטסאפ למספר 026244791",
    );
  });
});

// ---------------------------------------------------------------------------
// resolveAutoReply
// ---------------------------------------------------------------------------

describe("resolveAutoReply", () => {
  it("uses the temporary message while now is before its deadline", () => {
    const until = inMinutes(30);

    expect(
      resolveAutoReply({ permanent: "קבוע", temporary: { text: "זמני", until } }, NOW),
    ).toEqual({ text: "זמני", source: "temporary", until });
  });

  it("falls back to the permanent message once the deadline has passed", () => {
    const expired = { text: "זמני", until: inMinutes(-1) };

    expect(resolveAutoReply({ permanent: "קבוע", temporary: expired }, NOW)).toEqual({
      text: "קבוע",
      source: "permanent",
      until: null,
    });
  });

  it("treats now === until as already expired", () => {
    const boundary = { text: "זמני", until: new Date(NOW.getTime()) };

    expect(resolveAutoReply({ permanent: "קבוע", temporary: boundary }, NOW).source).toBe("permanent");
  });

  it("uses the permanent message when no temporary is set", () => {
    expect(resolveAutoReply({ permanent: "קבוע", temporary: null }, NOW)).toEqual({
      text: "קבוע",
      source: "permanent",
      until: null,
    });
  });

  it("uses the original text when nothing is set", () => {
    expect(resolveAutoReply({ permanent: null, temporary: null }, NOW)).toEqual({
      text: DEFAULT_AUTO_REPLY_TEXT,
      source: "default",
      until: null,
    });
  });

  it("uses the original text when the only temporary has expired", () => {
    expect(
      resolveAutoReply({ permanent: null, temporary: { text: "זמני", until: inMinutes(-5) } }, NOW),
    ).toEqual({ text: DEFAULT_AUTO_REPLY_TEXT, source: "default", until: null });
  });

  it("ignores a hidden-original flag on the state it is given — the original stays the fallback", () => {
    const state = { permanent: null, temporary: null, originalHidden: true };

    expect(resolveAutoReply(state, NOW)).toEqual({
      text: DEFAULT_AUTO_REPLY_TEXT,
      source: "default",
      until: null,
    });
  });
});

// ---------------------------------------------------------------------------
// getActiveAutoReplyText — the send-path read: never throws
// ---------------------------------------------------------------------------

describe("getActiveAutoReplyText", () => {
  it("returns the stored temporary text while it is active", async () => {
    routeQueries([
      "public.system_settings",
      { rows: [{ key: PERMANENT_KEY, value: "קבוע" }, temporaryRow("זמני", inMinutes(60))] },
    ]);

    expect(await getActiveAutoReplyText(NOW)).toBe("זמני");
  });

  it("returns the permanent text once the stored temporary has expired", async () => {
    routeQueries([
      "public.system_settings",
      { rows: [{ key: PERMANENT_KEY, value: "קבוע" }, temporaryRow("זמני", inMinutes(-1))] },
    ]);

    expect(await getActiveAutoReplyText(NOW)).toBe("קבוע");
  });

  it("returns the permanent text when no temporary is stored", async () => {
    routeQueries(["public.system_settings", { rows: [{ key: PERMANENT_KEY, value: "קבוע" }] }]);

    expect(await getActiveAutoReplyText(NOW)).toBe("קבוע");
  });

  it("returns the original text when nothing is stored", async () => {
    routeQueries(["public.system_settings", { rows: [] }]);

    expect(await getActiveAutoReplyText(NOW)).toBe(DEFAULT_AUTO_REPLY_TEXT);
  });

  it("reads only the settings keys (permanent, temporary, hidden flag), in one query, without the saved-messages table", async () => {
    routeQueries(["public.system_settings", { rows: [] }]);

    await getActiveAutoReplyText(NOW);

    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockPoolQuery.mock.calls[0]!;
    expect(sql).toContain("SELECT key, value FROM public.system_settings WHERE key = ANY($1)");
    expect(sql).not.toContain("auto_reply_messages");
    expect(params).toEqual([[PERMANENT_KEY, TEMPORARY_KEY, HIDDEN_KEY]]);
  });

  it("still returns the original text when the hidden flag is the only setting", async () => {
    routeQueries(["public.system_settings", { rows: [hiddenRow] }]);

    expect(await getActiveAutoReplyText(NOW)).toBe(DEFAULT_AUTO_REPLY_TEXT);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("ignores the hidden flag when a permanent or temporary message is set", async () => {
    routeQueries([
      "public.system_settings",
      { rows: [hiddenRow, { key: PERMANENT_KEY, value: "קבוע" }, temporaryRow("זמני", inMinutes(60))] },
    ]);

    expect(await getActiveAutoReplyText(NOW)).toBe("זמני");
    expect(await getActiveAutoReplyText(inMinutes(61))).toBe("קבוע");
  });

  it.each<[label: string, value: string]>([
    ["unparseable JSON", "{not json"],
    ["JSON null", "null"],
    ["a bare string", '"just text"'],
    ["missing text", JSON.stringify({ until: inMinutes(60).toISOString() })],
    ["empty text", JSON.stringify({ text: "", until: inMinutes(60).toISOString() })],
    ["blank text", JSON.stringify({ text: "   ", until: inMinutes(60).toISOString() })],
    ["missing until", JSON.stringify({ text: "זמני" })],
    ["unparseable until", JSON.stringify({ text: "זמני", until: "someday" })],
  ])("ignores a malformed stored temporary (%s) with a warning, falling back to permanent", async (_label, value) => {
    routeQueries([
      "public.system_settings",
      { rows: [{ key: PERMANENT_KEY, value: "קבוע" }, { key: TEMPORARY_KEY, value }] },
    ]);

    await expect(getActiveAutoReplyText(NOW)).resolves.toBe("קבוע");
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
  });

  it("falls back to the original text when a malformed temporary is the only setting", async () => {
    routeQueries(["public.system_settings", { rows: [{ key: TEMPORARY_KEY, value: "{not json" }] }]);

    expect(await getActiveAutoReplyText(NOW)).toBe(DEFAULT_AUTO_REPLY_TEXT);
  });

  it("treats a blank stored permanent as unset", async () => {
    routeQueries(["public.system_settings", { rows: [{ key: PERMANENT_KEY, value: "  " }] }]);

    expect(await getActiveAutoReplyText(NOW)).toBe(DEFAULT_AUTO_REPLY_TEXT);
  });

  it("returns the original text and warns when the query rejects — never throws", async () => {
    mockPoolQuery.mockRejectedValue(new Error("db down"));

    await expect(getActiveAutoReplyText(NOW)).resolves.toBe(DEFAULT_AUTO_REPLY_TEXT);
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// getAutoReplyState — the HTTP-layer read
// ---------------------------------------------------------------------------

describe("getAutoReplyState", () => {
  const savedRows = [
    { id: "id-new", text: "חדשה", created_at: new Date("2026-10-12T08:00:00.000Z") },
    { id: "id-old", text: "ישנה", created_at: new Date("2026-10-01T08:00:00.000Z") },
  ];

  it("lists the built-in message first, then saved messages newest-first", async () => {
    routeQueries(
      ["public.system_settings", { rows: [{ key: PERMANENT_KEY, value: "קבוע" }] }],
      ["public.auto_reply_messages", { rows: savedRows }],
    );

    const state = await getAutoReplyState(NOW);

    expect(state).toEqual({
      active: { text: "קבוע", source: "permanent", until: null },
      permanent: "קבוע",
      temporary: null,
      originalHidden: false,
      originalText: DEFAULT_AUTO_REPLY_TEXT,
      messages: [
        { id: "default", text: DEFAULT_AUTO_REPLY_TEXT, builtIn: true, createdAt: null },
        { id: "id-new", text: "חדשה", builtIn: false, createdAt: "2026-10-12T08:00:00.000Z" },
        { id: "id-old", text: "ישנה", builtIn: false, createdAt: "2026-10-01T08:00:00.000Z" },
      ],
    });
    const [messagesSql] = queriesMatching("public.auto_reply_messages")[0]!;
    expect(messagesSql).toContain("ORDER BY created_at DESC");
  });

  it("omits the built-in original from the list when it is hidden — saved messages unchanged, newest first", async () => {
    routeQueries(
      ["public.system_settings", { rows: [hiddenRow] }],
      ["public.auto_reply_messages", { rows: savedRows }],
    );

    const state = await getAutoReplyState(NOW);

    expect(state.originalHidden).toBe(true);
    expect(state.originalText).toBe(DEFAULT_AUTO_REPLY_TEXT);
    expect(state.messages).toEqual([
      { id: "id-new", text: "חדשה", builtIn: false, createdAt: "2026-10-12T08:00:00.000Z" },
      { id: "id-old", text: "ישנה", builtIn: false, createdAt: "2026-10-01T08:00:00.000Z" },
    ]);
  });

  it("lists nothing when the original is hidden and nothing is saved", async () => {
    routeQueries(
      ["public.system_settings", { rows: [hiddenRow] }],
      ["public.auto_reply_messages", { rows: [] }],
    );

    const state = await getAutoReplyState(NOW);

    expect(state.originalHidden).toBe(true);
    expect(state.messages).toEqual([]);
  });

  it("leaves 'active' alone when the original is hidden — with nothing set the bot still sends the original", async () => {
    routeQueries(
      ["public.system_settings", { rows: [hiddenRow] }],
      ["public.auto_reply_messages", { rows: [] }],
    );

    const state = await getAutoReplyState(NOW);

    expect(state.active).toEqual({ text: DEFAULT_AUTO_REPLY_TEXT, source: "default", until: null });
    expect(state.permanent).toBeNull();
    expect(state.temporary).toBeNull();
  });

  it("leaves an active permanent and temporary alone when the original is hidden", async () => {
    const until = inMinutes(30);
    routeQueries(
      ["public.system_settings", { rows: [hiddenRow, { key: PERMANENT_KEY, value: "קבוע" }, temporaryRow("זמני", until)] }],
      ["public.auto_reply_messages", { rows: [] }],
    );

    const state = await getAutoReplyState(NOW);

    expect(state.active).toEqual({ text: "זמני", source: "temporary", until: until.toISOString() });
    expect(state.permanent).toBe("קבוע");
    expect(state.temporary).toEqual({ text: "זמני", until: until.toISOString() });
  });

  it("always reports originalText as the built-in text, whatever is active", async () => {
    routeQueries(
      ["public.system_settings", { rows: [{ key: PERMANENT_KEY, value: "קבוע" }] }],
      ["public.auto_reply_messages", { rows: [] }],
    );

    const state = await getAutoReplyState(NOW);

    expect(state.originalHidden).toBe(false);
    expect(state.originalText).toBe(DEFAULT_AUTO_REPLY_TEXT);
  });

  it("reads the hidden flag in the same single settings query as the other keys", async () => {
    routeQueries(
      ["public.system_settings", { rows: [] }],
      ["public.auto_reply_messages", { rows: [] }],
    );

    await getAutoReplyState(NOW);

    const settingsReads = queriesMatching("public.system_settings");
    expect(settingsReads).toHaveLength(1);
    expect(settingsReads[0]![1]).toEqual([[PERMANENT_KEY, TEMPORARY_KEY, HIDDEN_KEY]]);
  });

  it("reports an active temporary with its ISO deadline while the permanent one stays visible", async () => {
    const until = inMinutes(90);
    routeQueries(
      ["public.system_settings", { rows: [{ key: PERMANENT_KEY, value: "קבוע" }, temporaryRow("זמני", until)] }],
      ["public.auto_reply_messages", { rows: [] }],
    );

    const state = await getAutoReplyState(NOW);

    expect(state.active).toEqual({ text: "זמני", source: "temporary", until: until.toISOString() });
    expect(state.temporary).toEqual({ text: "זמני", until: until.toISOString() });
    expect(state.permanent).toBe("קבוע");
  });

  it("reports temporary: null once the deadline has passed", async () => {
    routeQueries(
      ["public.system_settings", { rows: [{ key: PERMANENT_KEY, value: "קבוע" }, temporaryRow("זמני", inMinutes(-1))] }],
      ["public.auto_reply_messages", { rows: [] }],
    );

    const state = await getAutoReplyState(NOW);

    expect(state.temporary).toBeNull();
    expect(state.active).toEqual({ text: "קבוע", source: "permanent", until: null });
  });

  it("reports the original text, permanent: null and only the built-in message when nothing is stored", async () => {
    routeQueries(
      ["public.system_settings", { rows: [] }],
      ["public.auto_reply_messages", { rows: [] }],
    );

    const state = await getAutoReplyState(NOW);

    expect(state.active).toEqual({ text: DEFAULT_AUTO_REPLY_TEXT, source: "default", until: null });
    expect(state.permanent).toBeNull();
    expect(state.temporary).toBeNull();
    expect(state.messages).toEqual([
      { id: "default", text: DEFAULT_AUTO_REPLY_TEXT, builtIn: true, createdAt: null },
    ]);
  });

  it("propagates database errors to the HTTP layer", async () => {
    mockPoolQuery.mockRejectedValue(new Error("db down"));

    await expect(getAutoReplyState(NOW)).rejects.toThrow("db down");
  });
});

// ---------------------------------------------------------------------------
// parseUntil
// ---------------------------------------------------------------------------

describe("parseUntil", () => {
  const BEFORE_BOTH = new Date("2026-10-01T00:00:00.000Z");

  it("converts Israel summer time (IDT, UTC+3)", () => {
    expect(parseUntil("2026-10-18T09:00", BEFORE_BOTH).toISOString()).toBe("2026-10-18T06:00:00.000Z");
  });

  it("converts Israel winter time (IST, UTC+2) after the October change", () => {
    expect(parseUntil("2026-10-27T09:00", BEFORE_BOTH).toISOString()).toBe("2026-10-27T07:00:00.000Z");
  });

  it("applies the spring change on the Friday before the last Sunday of March", () => {
    const winterNow = new Date("2026-03-01T00:00:00.000Z");

    expect(parseUntil("2026-03-26T09:00", winterNow).toISOString()).toBe("2026-03-26T07:00:00.000Z");
    expect(parseUntil("2026-03-27T09:00", winterNow).toISOString()).toBe("2026-03-27T06:00:00.000Z");
  });

  it.each([
    ["a non-existent calendar day", "2026-02-30T09:00"],
    ["month 13", "2026-13-01T09:00"],
    ["month 00", "2026-00-10T09:00"],
    ["day 00", "2026-10-00T09:00"],
    ["hour 24", "2026-10-18T24:00"],
    ["minute 60", "2026-10-18T09:60"],
    ["a space instead of T", "2026-10-18 09:00"],
    ["seconds", "2026-10-18T09:00:00"],
    ["a UTC suffix", "2026-10-18T09:00Z"],
    ["a 2-digit year", "26-10-18T09:00"],
    ["an empty string", ""],
  ])("rejects %s with INVALID_UNTIL", (_label, input) => {
    expect(errorFrom(() => parseUntil(input, BEFORE_BOTH))).toMatchObject({
      statusCode: 400,
      code: "INVALID_UNTIL",
      message: "invalid until date/time",
    });
  });

  it("accepts a leap day on a leap year and rejects it on a common year", () => {
    const now = new Date("2027-12-01T00:00:00.000Z");

    expect(parseUntil("2028-02-29T09:00", now).toISOString()).toBe("2028-02-29T07:00:00.000Z");
    expect(errorFrom(() => parseUntil("2029-02-29T09:00", now))).toMatchObject({ code: "INVALID_UNTIL" });
  });

  it("rejects a moment in the past with UNTIL_IN_PAST", () => {
    const after = new Date("2026-10-18T07:00:00.000Z");

    expect(errorFrom(() => parseUntil("2026-10-18T09:00", after))).toMatchObject({
      statusCode: 400,
      code: "UNTIL_IN_PAST",
      message: "until must be in the future",
    });
  });

  it("rejects exactly now as past, but accepts a millisecond earlier 'now'", () => {
    expect(
      errorFrom(() => parseUntil("2026-10-18T09:00", new Date("2026-10-18T06:00:00.000Z"))),
    ).toMatchObject({ code: "UNTIL_IN_PAST" });
    expect(parseUntil("2026-10-18T09:00", new Date("2026-10-18T05:59:59.999Z")).toISOString()).toBe(
      "2026-10-18T06:00:00.000Z",
    );
  });

  it("rejects a moment more than 366 days ahead with UNTIL_TOO_FAR", () => {
    expect(errorFrom(() => parseUntil("2027-10-20T09:00", BEFORE_BOTH))).toMatchObject({
      statusCode: 400,
      code: "UNTIL_TOO_FAR",
      message: "until must be within one year",
    });
  });

  it("allows exactly 366 days ahead but not a minute more", () => {
    const now = new Date("2026-10-13T06:00:00.000Z");

    expect(parseUntil("2027-10-14T09:00", now).toISOString()).toBe("2027-10-14T06:00:00.000Z");
    expect(errorFrom(() => parseUntil("2027-10-14T09:01", now))).toMatchObject({ code: "UNTIL_TOO_FAR" });
  });
});

// ---------------------------------------------------------------------------
// saveMessage
// ---------------------------------------------------------------------------

describe("saveMessage", () => {
  const LOOKUP = "SELECT id FROM public.auto_reply_messages WHERE text = $1";

  it("restores the original and returns 'default' for the original text — trimmed or not — without inserting a row", async () => {
    routeQueries(["DELETE FROM public.system_settings WHERE key = $1", { rows: [], rowCount: 1 }]);

    expect(await saveMessage(DEFAULT_AUTO_REPLY_TEXT)).toBe("default");
    expect(await saveMessage(`  ${DEFAULT_AUTO_REPLY_TEXT}\n`)).toBe("default");

    expect(mockPoolQuery).toHaveBeenCalledTimes(2);
    for (const [sql, params] of mockPoolQuery.mock.calls) {
      expect(sql).toContain("DELETE FROM public.system_settings WHERE key = $1");
      expect(params).toEqual([HIDDEN_KEY]);
    }
    expect(queriesMatching("auto_reply_messages")).toHaveLength(0);
    expect(queriesMatching("INSERT INTO")).toHaveLength(0);
  });

  it("does not touch the hidden flag when saving any other text", async () => {
    routeQueries(
      [LOOKUP, { rows: [] }],
      ["count(*)", { rows: [{ c: 3 }] }],
      ["INSERT INTO public.auto_reply_messages", { rows: [{ id: "new-id" }] }],
    );

    await saveMessage("הודעה חדשה");

    expect(JSON.stringify(mockPoolQuery.mock.calls)).not.toContain(HIDDEN_KEY);
    expect(queriesMatching("system_settings")).toHaveLength(0);
  });

  it("returns the existing id for an identical saved text — no cap check, no insert", async () => {
    routeQueries([LOOKUP, { rows: [{ id: "existing-id" }] }]);

    expect(await saveMessage("  שלום  ")).toBe("existing-id");

    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    expect(mockPoolQuery.mock.calls[0]![1]).toEqual(["שלום"]);
  });

  it("inserts a new trimmed text and returns the new id", async () => {
    routeQueries(
      [LOOKUP, { rows: [] }],
      ["count(*)", { rows: [{ c: 49 }] }],
      ["INSERT INTO public.auto_reply_messages", { rows: [{ id: "new-id" }] }],
    );

    expect(await saveMessage("  הודעה חדשה  ")).toBe("new-id");

    const [insert] = queriesMatching("INSERT INTO public.auto_reply_messages");
    expect(insert![1]).toEqual(["הודעה חדשה"]);
    expect(String(insert![0])).toContain("ON CONFLICT (text)");
  });

  it("rejects the 51st new message with MESSAGE_LIMIT_REACHED and never inserts", async () => {
    routeQueries([LOOKUP, { rows: [] }], ["count(*)", { rows: [{ c: 50 }] }]);

    await expect(saveMessage("עוד אחת")).rejects.toMatchObject({
      statusCode: 400,
      code: "MESSAGE_LIMIT_REACHED",
      message: "saved message limit reached (50)",
    });
    expect(queriesMatching("INSERT INTO")).toHaveLength(0);
  });

  it("still returns the id of an identical text when the list is already full", async () => {
    routeQueries([LOOKUP, { rows: [{ id: "existing-id" }] }], ["count(*)", { rows: [{ c: 50 }] }]);

    expect(await saveMessage("שלום")).toBe("existing-id");
  });
});

// ---------------------------------------------------------------------------
// deleteMessage
// ---------------------------------------------------------------------------

describe("deleteMessage", () => {
  describe("the built-in original", () => {
    it("is hidden by upserting ONLY the hidden flag — permanent and temporary stay untouched", async () => {
      routeQueries(["INSERT INTO public.system_settings", { rows: [], rowCount: 1 }]);

      await expect(deleteMessage("default")).resolves.toBeUndefined();

      expect(mockPoolQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockPoolQuery.mock.calls[0]!;
      expect(sql).toContain("INSERT INTO public.system_settings (key, value)");
      expect(sql).toContain("ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()");
      expect(sql).not.toContain("DELETE");
      expect(params).toEqual([HIDDEN_KEY, "true"]);
      expect(JSON.stringify(mockPoolQuery.mock.calls)).not.toContain(PERMANENT_KEY);
      expect(JSON.stringify(mockPoolQuery.mock.calls)).not.toContain(TEMPORARY_KEY);
      expect(queriesMatching("auto_reply_messages")).toHaveLength(0);
    });

    it("is idempotent — hiding it again issues the same upsert and never fails", async () => {
      routeQueries(["INSERT INTO public.system_settings", { rows: [], rowCount: 1 }]);

      await deleteMessage("default");
      await deleteMessage("default");

      expect(mockPoolQuery).toHaveBeenCalledTimes(2);
      expect(mockPoolQuery.mock.calls[1]).toEqual(mockPoolQuery.mock.calls[0]);
    });

    it("writes a flag the state reader recognizes as hidden", async () => {
      routeQueries(["INSERT INTO public.system_settings", { rows: [] }]);
      await deleteMessage("default");
      const [key, value] = mockPoolQuery.mock.calls[0]![1] as [string, string];

      routeQueries(
        ["public.system_settings", { rows: [{ key, value }] }],
        ["public.auto_reply_messages", { rows: [] }],
      );
      const state = await getAutoReplyState(NOW);

      expect(state.originalHidden).toBe(true);
      expect(state.messages).toEqual([]);
    });
  });

  it("throws NOT_FOUND when no row was deleted", async () => {
    routeQueries(["DELETE FROM public.auto_reply_messages", { rows: [], rowCount: 0 }]);

    await expect(deleteMessage(SAVED_ID)).rejects.toMatchObject({
      statusCode: 404,
      code: "NOT_FOUND",
      message: "Saved message not found",
    });
  });

  it("deletes the saved row without touching the active settings", async () => {
    routeQueries(["DELETE FROM public.auto_reply_messages", { rows: [], rowCount: 1 }]);

    await expect(deleteMessage(SAVED_ID)).resolves.toBeUndefined();

    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    expect(mockPoolQuery.mock.calls[0]![0]).toContain("WHERE id = $1");
    expect(mockPoolQuery.mock.calls[0]![1]).toEqual([SAVED_ID]);
    expect(queriesMatching("system_settings")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// restoreOriginal
// ---------------------------------------------------------------------------

describe("restoreOriginal", () => {
  it("deletes only the hidden flag", async () => {
    routeQueries(["DELETE FROM public.system_settings WHERE key = $1", { rows: [], rowCount: 1 }]);

    await restoreOriginal();

    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    expect(mockPoolQuery.mock.calls[0]![1]).toEqual([HIDDEN_KEY]);
  });

  it("is idempotent — resolves when the original was not hidden", async () => {
    routeQueries(["DELETE FROM public.system_settings WHERE key = $1", { rows: [], rowCount: 0 }]);

    await expect(restoreOriginal()).resolves.toBeUndefined();
  });

  it("brings the original back into the list the state reader returns", async () => {
    routeQueries(["DELETE FROM public.system_settings WHERE key = $1", { rows: [], rowCount: 1 }]);
    await restoreOriginal();

    routeQueries(
      ["public.system_settings", { rows: [] }],
      ["public.auto_reply_messages", { rows: [] }],
    );
    const state = await getAutoReplyState(NOW);

    expect(state.originalHidden).toBe(false);
    expect(state.messages).toEqual([
      { id: "default", text: DEFAULT_AUTO_REPLY_TEXT, builtIn: true, createdAt: null },
    ]);
  });
});

// ---------------------------------------------------------------------------
// useMessage / clearTemporary
// ---------------------------------------------------------------------------

describe("useMessage", () => {
  const SELECT_TEXT = "SELECT text FROM public.auto_reply_messages WHERE id = $1";
  const UNTIL = new Date("2026-10-18T06:00:00.000Z");

  describe("permanent", () => {
    it("upserts the permanent key and clears the temporary one in ONE statement", async () => {
      routeQueries([SELECT_TEXT, { rows: [{ text: "טקסט שמור" }] }], ["WITH cleared AS", { rows: [] }]);

      await useMessage(SAVED_ID, "permanent");

      const writes = queriesMatching("system_settings");
      expect(writes).toHaveLength(1);
      const [sql, params] = writes[0]!;
      expect(sql).toContain("WITH cleared AS (DELETE FROM public.system_settings WHERE key = $1)");
      expect(sql).toContain("INSERT INTO public.system_settings (key, value)");
      expect(sql).toContain("ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()");
      expect(params).toEqual([TEMPORARY_KEY, PERMANENT_KEY, "טקסט שמור"]);
    });

    it("'default' deletes BOTH keys in one statement, without a lookup", async () => {
      routeQueries(["DELETE FROM public.system_settings WHERE key = ANY($1)", { rows: [], rowCount: 2 }]);

      await useMessage("default", "permanent");

      expect(mockPoolQuery).toHaveBeenCalledTimes(1);
      expect(mockPoolQuery.mock.calls[0]![1]).toEqual([[PERMANENT_KEY, TEMPORARY_KEY]]);
    });

    it("throws NOT_FOUND for an unknown id and writes nothing", async () => {
      routeQueries([SELECT_TEXT, { rows: [] }]);

      await expect(useMessage(SAVED_ID, "permanent")).rejects.toMatchObject({
        statusCode: 404,
        code: "NOT_FOUND",
      });
      expect(queriesMatching("system_settings")).toHaveLength(0);
    });
  });

  describe("temporary", () => {
    it("upserts only the temporary key with JSON {text, until}", async () => {
      routeQueries([SELECT_TEXT, { rows: [{ text: "טקסט שמור" }] }], ["INSERT INTO public.system_settings", { rows: [] }]);

      await useMessage(SAVED_ID, "temporary", UNTIL);

      const writes = queriesMatching("system_settings");
      expect(writes).toHaveLength(1);
      const [sql, params] = writes[0]!;
      expect(sql).toContain("ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()");
      expect(sql).not.toContain("DELETE");
      const [key, value] = params as [string, string];
      expect(key).toBe(TEMPORARY_KEY);
      expect(JSON.parse(value)).toEqual({ text: "טקסט שמור", until: "2026-10-18T06:00:00.000Z" });
      expect(JSON.stringify(mockPoolQuery.mock.calls)).not.toContain(PERMANENT_KEY);
    });

    it("'default' stores the original text as the temporary message, without a lookup", async () => {
      routeQueries(["INSERT INTO public.system_settings", { rows: [] }]);

      await useMessage("default", "temporary", UNTIL);

      expect(mockPoolQuery).toHaveBeenCalledTimes(1);
      const [, value] = mockPoolQuery.mock.calls[0]![1] as [string, string];
      expect(JSON.parse(value)).toEqual({ text: DEFAULT_AUTO_REPLY_TEXT, until: "2026-10-18T06:00:00.000Z" });
    });

    it("throws NOT_FOUND for an unknown id and writes nothing", async () => {
      routeQueries([SELECT_TEXT, { rows: [] }]);

      await expect(useMessage(SAVED_ID, "temporary", UNTIL)).rejects.toMatchObject({
        statusCode: 404,
        code: "NOT_FOUND",
      });
      expect(queriesMatching("system_settings")).toHaveLength(0);
    });

    it("writes JSON the send-path reader accepts, and stops applying it at the deadline", async () => {
      routeQueries([SELECT_TEXT, { rows: [{ text: "טקסט שמור" }] }], ["INSERT INTO public.system_settings", { rows: [] }]);
      await useMessage(SAVED_ID, "temporary", UNTIL);
      const [, stored] = queriesMatching("system_settings")[0]![1] as [string, string];

      routeQueries(["public.system_settings", { rows: [{ key: TEMPORARY_KEY, value: stored }] }]);

      expect(await getActiveAutoReplyText(new Date("2026-10-18T05:59:59.000Z"))).toBe("טקסט שמור");
      expect(await getActiveAutoReplyText(UNTIL)).toBe(DEFAULT_AUTO_REPLY_TEXT);
    });
  });
});

describe("clearTemporary", () => {
  it("deletes only the temporary key", async () => {
    routeQueries(["DELETE FROM public.system_settings WHERE key = $1", { rows: [], rowCount: 1 }]);

    await clearTemporary();

    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    expect(mockPoolQuery.mock.calls[0]![1]).toEqual([TEMPORARY_KEY]);
  });

  it("is idempotent — resolves when there was nothing to delete", async () => {
    routeQueries(["DELETE FROM public.system_settings WHERE key = $1", { rows: [], rowCount: 0 }]);

    await expect(clearTemporary()).resolves.toBeUndefined();
  });
});
