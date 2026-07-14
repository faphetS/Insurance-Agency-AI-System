import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockFromImpl } = vi.hoisted(() => ({ mockFromImpl: vi.fn() }));

const envMock = {
  CHATWOOT_BASE_URL: "https://cw.test" as string | undefined,
  CHATWOOT_ACCOUNT_ID: "1" as string | undefined,
  CHATWOOT_INBOX_ID: "2" as string | undefined,
  CHATWOOT_BOT_TOKEN: "bot-token" as string | undefined,
  NODE_ENV: "test",
};

vi.mock("../../config/env.js", () => ({ get env() { return envMock; } }));

vi.mock("../../config/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../config/supabase.js", () => ({
  supabaseAdmin: { from: mockFromImpl },
}));

import { mirrorInbound, mirrorOutbound, resetChatwootCache } from "./chatwoot.service.js";
import { logger } from "../../config/logger.js";

function makeBuilder(result: unknown) {
  const b: Record<string, unknown> = {};
  const chain = ["select", "eq", "in", "insert", "upsert", "update", "delete"];
  for (const m of chain) b[m] = vi.fn().mockReturnValue(b);
  const terminal = vi.fn().mockResolvedValue(result);
  b["maybeSingle"] = terminal;
  b["single"] = terminal;
  b["then"] = (resolve: (v: unknown) => void) => Promise.resolve(result).then(resolve);
  return b;
}

function setupFrom(builders: ReturnType<typeof makeBuilder>[]) {
  let i = 0;
  mockFromImpl.mockImplementation(() => {
    const b = builders[i] ?? builders[builders.length - 1]!;
    i++;
    return b;
  });
}

function jsonResponse(status: number, body: unknown) {
  return { status, ok: status < 400, json: () => Promise.resolve(body) };
}

const CHAT = "972501112233@c.us";

const NO_IDS_ROW = {
  data: { chatwoot_contact_id: null, chatwoot_conversation_id: null },
  error: null,
};

const contactCreateResponse = {
  payload: {
    contact: {
      id: 12,
      contact_inboxes: [{ source_id: "uuid-src-1" }],
    },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  resetChatwootCache();
  envMock.CHATWOOT_BASE_URL = "https://cw.test";
  envMock.CHATWOOT_ACCOUNT_ID = "1";
  envMock.CHATWOOT_INBOX_ID = "2";
  envMock.CHATWOOT_BOT_TOKEN = "bot-token";
});

afterEach(() => vi.unstubAllGlobals());

// ---------------------------------------------------------------------------
// Dormant / skip paths
// ---------------------------------------------------------------------------

describe("mirror — dormant and skip paths", () => {
  it("blank env → zero fetches, zero DB reads", async () => {
    envMock.CHATWOOT_BASE_URL = undefined;
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    await mirrorInbound(CHAT, "hello");
    await mirrorOutbound(CHAT, "hello back");

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockFromImpl).not.toHaveBeenCalled();
  });

  it("empty/whitespace text → no fetches", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    await mirrorInbound(CHAT, "   ");
    await mirrorOutbound(CHAT, "");

    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Full mirror chain
// ---------------------------------------------------------------------------

describe("mirror — full chain (contact → conversation → message)", () => {
  it("creates contact + conversation, persists ids, posts the message", async () => {
    setupFrom([
      makeBuilder(NO_IDS_ROW),
      makeBuilder({ data: null, error: null }),
    ]);
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, contactCreateResponse))
      .mockResolvedValueOnce(jsonResponse(200, { id: 34 }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 99 }));
    vi.stubGlobal("fetch", mockFetch);

    await mirrorInbound(CHAT, "שלום", "Dana");

    expect(mockFetch).toHaveBeenCalledTimes(3);

    const [contactUrl, contactInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(contactUrl).toBe("https://cw.test/api/v1/accounts/1/contacts");
    expect(contactInit.method).toBe("POST");
    expect((contactInit.headers as Record<string, string>)["api_access_token"]).toBe("bot-token");
    expect(JSON.parse(contactInit.body as string)).toEqual({
      inbox_id: 2,
      name: "Dana",
      phone_number: "+972501112233",
      identifier: "972501112233@c.us",
    });

    const [convUrl, convInit] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(convUrl).toBe("https://cw.test/api/v1/accounts/1/conversations");
    expect(JSON.parse(convInit.body as string)).toEqual({
      source_id: "uuid-src-1",
      inbox_id: 2,
      contact_id: 12,
    });

    const [msgUrl, msgInit] = mockFetch.mock.calls[2] as [string, RequestInit];
    expect(msgUrl).toBe("https://cw.test/api/v1/accounts/1/conversations/34/messages");
    expect(JSON.parse(msgInit.body as string)).toEqual({
      content: "שלום",
      message_type: "incoming",
      private: false,
    });

    const persistBuilder = mockFromImpl.mock.results[1]!.value as Record<string, unknown>;
    expect(persistBuilder["update"]).toHaveBeenCalledWith({
      chatwoot_contact_id: 12,
      chatwoot_conversation_id: 34,
    });
    expect(persistBuilder["eq"]).toHaveBeenCalledWith("whatsapp_chat_id", CHAT);
  });

  it("handles a bare (non-nested) contact create response", async () => {
    setupFrom([
      makeBuilder(NO_IDS_ROW),
      makeBuilder({ data: null, error: null }),
    ]);
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { id: 21, contact_inboxes: [{ source_id: "uuid-bare" }] }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { id: 40 }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 100 }));
    vi.stubGlobal("fetch", mockFetch);

    await mirrorInbound(CHAT, "hi");

    const [, convInit] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(convInit.body as string)).toMatchObject({
      source_id: "uuid-bare",
      contact_id: 21,
    });
  });

  it("422 on contact create → falls back to /contacts/search and uses the first match", async () => {
    setupFrom([
      makeBuilder(NO_IDS_ROW),
      makeBuilder({ data: null, error: null }),
    ]);
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(422, { message: "Phone number has already been taken" }))
      .mockResolvedValueOnce(
        jsonResponse(200, { payload: [{ id: 5, contact_inboxes: [{ source_id: "uuid-s2" }] }] }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { id: 60 }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 101 }));
    vi.stubGlobal("fetch", mockFetch);

    await mirrorOutbound(CHAT, "reply text");

    const [searchUrl, searchInit] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(searchUrl).toBe(
      "https://cw.test/api/v1/accounts/1/contacts/search?q=972501112233",
    );
    expect(searchInit.method).toBe("GET");

    const [, convInit] = mockFetch.mock.calls[2] as [string, RequestInit];
    expect(JSON.parse(convInit.body as string)).toMatchObject({
      source_id: "uuid-s2",
      contact_id: 5,
    });

    const [msgUrl, msgInit] = mockFetch.mock.calls[3] as [string, RequestInit];
    expect(msgUrl).toContain("/conversations/60/messages");
    expect(JSON.parse(msgInit.body as string)).toMatchObject({ message_type: "outgoing" });
  });
});

// ---------------------------------------------------------------------------
// Cached-ids paths
// ---------------------------------------------------------------------------

describe("mirror — cached ids", () => {
  it("DB row already holds both ids → single fetch (message post only)", async () => {
    setupFrom([
      makeBuilder({ data: { chatwoot_contact_id: 77, chatwoot_conversation_id: 88 }, error: null }),
    ]);
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(200, { id: 1 }));
    vi.stubGlobal("fetch", mockFetch);

    await mirrorInbound(CHAT, "cached hello");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [msgUrl] = mockFetch.mock.calls[0] as [string];
    expect(msgUrl).toBe("https://cw.test/api/v1/accounts/1/conversations/88/messages");
  });

  it("in-memory cache warm → no DB read on the second message", async () => {
    setupFrom([
      makeBuilder({ data: { chatwoot_contact_id: 77, chatwoot_conversation_id: 88 }, error: null }),
    ]);
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(200, { id: 1 }));
    vi.stubGlobal("fetch", mockFetch);

    await mirrorInbound(CHAT, "first");
    const dbReadsAfterFirst = mockFromImpl.mock.calls.length;
    await mirrorOutbound(CHAT, "second");

    expect(mockFromImpl.mock.calls.length).toBe(dbReadsAfterFirst);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// 404 recovery
// ---------------------------------------------------------------------------

describe("mirror — 404 on message post", () => {
  it("clears cached ids and retries the full chain exactly once", async () => {
    setupFrom([
      makeBuilder({ data: { chatwoot_contact_id: 77, chatwoot_conversation_id: 88 }, error: null }),
      makeBuilder({ data: null, error: null }), // clear ids
      makeBuilder(NO_IDS_ROW), // re-read after clear
      makeBuilder({ data: null, error: null }), // persist fresh ids
    ]);
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(404, { error: "Resource could not be found" }))
      .mockResolvedValueOnce(jsonResponse(200, contactCreateResponse))
      .mockResolvedValueOnce(jsonResponse(200, { id: 90 }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 200 }));
    vi.stubGlobal("fetch", mockFetch);

    await mirrorInbound(CHAT, "after delete");

    expect(mockFetch).toHaveBeenCalledTimes(4);

    const clearBuilder = mockFromImpl.mock.results[1]!.value as Record<string, unknown>;
    expect(clearBuilder["update"]).toHaveBeenCalledWith({
      chatwoot_contact_id: null,
      chatwoot_conversation_id: null,
    });

    const [retryMsgUrl] = mockFetch.mock.calls[3] as [string];
    expect(retryMsgUrl).toContain("/conversations/90/messages");
  });

  it("does not loop when the retry also 404s", async () => {
    setupFrom([
      makeBuilder({ data: { chatwoot_contact_id: 77, chatwoot_conversation_id: 88 }, error: null }),
      makeBuilder({ data: null, error: null }),
      makeBuilder(NO_IDS_ROW),
      makeBuilder({ data: null, error: null }),
    ]);
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(404, {}))
      .mockResolvedValueOnce(jsonResponse(200, contactCreateResponse))
      .mockResolvedValueOnce(jsonResponse(200, { id: 91 }))
      .mockResolvedValueOnce(jsonResponse(404, {}));
    vi.stubGlobal("fetch", mockFetch);

    await mirrorInbound(CHAT, "still deleted");

    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(vi.mocked(logger.warn)).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Failure safety + truncation
// ---------------------------------------------------------------------------

describe("mirror — failure safety and truncation", () => {
  it("never throws when fetch rejects", async () => {
    setupFrom([makeBuilder(NO_IDS_ROW)]);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    await expect(mirrorInbound(CHAT, "boom")).resolves.toBeUndefined();
    await expect(mirrorOutbound(CHAT, "boom")).resolves.toBeUndefined();
    expect(vi.mocked(logger.warn)).toHaveBeenCalled();
  });

  it("never throws when the DB read rejects", async () => {
    mockFromImpl.mockImplementation(() => {
      throw new Error("pg down");
    });
    vi.stubGlobal("fetch", vi.fn());

    await expect(mirrorInbound(CHAT, "boom")).resolves.toBeUndefined();
    expect(vi.mocked(logger.warn)).toHaveBeenCalled();
  });

  it("truncates content over 4000 chars", async () => {
    setupFrom([
      makeBuilder({ data: { chatwoot_contact_id: 77, chatwoot_conversation_id: 88 }, error: null }),
    ]);
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(200, { id: 1 }));
    vi.stubGlobal("fetch", mockFetch);

    await mirrorInbound(CHAT, "א".repeat(5000));

    const [, msgInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(msgInit.body as string) as { content: string };
    expect(body.content.length).toBe(4000);
  });
});
