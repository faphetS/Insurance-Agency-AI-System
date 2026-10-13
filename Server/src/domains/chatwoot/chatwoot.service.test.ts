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

import {
  mirrorInbound,
  mirrorInboundAttachment,
  mirrorOutbound,
  resetChatwootCache,
  resolveConversationId,
  type ChatwootAttachment,
} from "./chatwoot.service.js";
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

// ---------------------------------------------------------------------------
// Attachments (lead photos, files, voice notes, video)
// ---------------------------------------------------------------------------

const CACHED_ROW = { data: { chatwoot_contact_id: 77, chatwoot_conversation_id: 88 }, error: null };
const VOICE_BYTES = Buffer.from("OggS-voice-bytes");
const CAPTION = "הרכב אחרי התאונה";
const FILE_NAME = "דוח שמאי.pdf";

function voiceNote(over: Partial<ChatwootAttachment> = {}): ChatwootAttachment {
  return {
    bytes: VOICE_BYTES,
    fileName: "voice-note-2026-10-13_18-05-09.ogg",
    contentType: "audio/ogg",
    isVoice: true,
    ...over,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

// A macrotask turn: every pending microtask (queued mirror steps) has run by then.
const settle = () => new Promise((r) => setTimeout(r, 0));

function initOf(mockFetch: ReturnType<typeof vi.fn>, call: number): RequestInit {
  return (mockFetch.mock.calls[call] as [string, RequestInit])[1];
}

function urlsOf(mockFetch: ReturnType<typeof vi.fn>): string[] {
  return mockFetch.mock.calls.map((c) => (c as [string])[0]);
}

// JSON.stringify drops an Error's message; spell it out so it is checked too.
function allLogs(): string {
  return JSON.stringify(
    [logger.info, logger.warn, logger.error, logger.debug].map((fn) => vi.mocked(fn).mock.calls),
    (_key, value: unknown) => (value instanceof Error ? { name: value.name, message: value.message } : value),
  );
}

/** Counts the Blobs the service builds and keeps what each was built from. */
function countBlobs(): unknown[] {
  const sources: unknown[] = [];
  vi.stubGlobal(
    "Blob",
    class extends Blob {
      constructor(...args: ConstructorParameters<typeof Blob>) {
        super(...args);
        sources.push(args[0]?.[0]);
      }
    },
  );
  return sources;
}

describe("mirrorInboundAttachment — multipart upload", () => {
  it("voice note without a caption: no content, incoming, voice flag, one file part — and no JSON headers", async () => {
    setupFrom([makeBuilder(CACHED_ROW)]);
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(200, { id: 1 }));
    vi.stubGlobal("fetch", mockFetch);

    await mirrorInboundAttachment(CHAT, async () => voiceNote(), undefined, "[הודעה קולית]");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://cw.test/api/v1/accounts/1/conversations/88/messages");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["api_access_token"]).toBe("bot-token");
    expect(headers).not.toHaveProperty("Content-Type");

    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect([...form.keys()].sort()).toEqual(["attachments[]", "is_voice_message", "message_type"]);
    expect(form.get("message_type")).toBe("incoming");
    expect(form.get("is_voice_message")).toBe("true");
    const files = form.getAll("attachments[]") as File[];
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe("voice-note-2026-10-13_18-05-09.ogg");
    expect(files[0]!.type).toBe("audio/ogg");
    expect(Buffer.from(await files[0]!.arrayBuffer()).equals(VOICE_BYTES)).toBe(true);
  });

  it("a caption becomes the trimmed message text; no voice flag for a document; Hebrew file name kept", async () => {
    setupFrom([makeBuilder(CACHED_ROW)]);
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(200, { id: 1 }));
    vi.stubGlobal("fetch", mockFetch);

    await mirrorInboundAttachment(
      CHAT,
      async () => ({ bytes: Buffer.from("%PDF"), fileName: FILE_NAME, contentType: "application/pdf" }),
      `  ${CAPTION}  `,
      `[מסמך]\n${CAPTION}`,
    );

    const form = initOf(mockFetch, 0).body as FormData;
    expect(form.get("content")).toBe(CAPTION);
    expect(form.has("is_voice_message")).toBe(false);
    expect(form.has("private")).toBe(false);
    const file = form.get("attachments[]") as File;
    expect(file.name).toBe(FILE_NAME);
    expect(file.type).toBe("application/pdf");
  });

  it("a blank caption is omitted; a long one is cut at 4000 chars", async () => {
    setupFrom([makeBuilder(CACHED_ROW)]);
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(200, { id: 1 }));
    vi.stubGlobal("fetch", mockFetch);

    await mirrorInboundAttachment(CHAT, async () => voiceNote(), "   ", "[הודעה קולית]");
    await mirrorInboundAttachment(CHAT, async () => voiceNote(), "א".repeat(5000), "[הודעה קולית]");

    expect((initOf(mockFetch, 0).body as FormData).has("content")).toBe(false);
    expect(((initOf(mockFetch, 1).body as FormData).get("content") as string).length).toBe(4000);
  });

  it("a brand-new chat: contact + conversation are created first, then the file is uploaded", async () => {
    setupFrom([makeBuilder(NO_IDS_ROW), makeBuilder({ data: null, error: null })]);
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, contactCreateResponse))
      .mockResolvedValueOnce(jsonResponse(200, { id: 34 }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 99 }));
    vi.stubGlobal("fetch", mockFetch);

    await mirrorInboundAttachment(CHAT, async () => voiceNote(), undefined, "[הודעה קולית]", "Dana");

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(JSON.parse(initOf(mockFetch, 0).body as string)).toMatchObject({ name: "Dana" });
    expect((mockFetch.mock.calls[2] as [string])[0]).toBe("https://cw.test/api/v1/accounts/1/conversations/34/messages");
    expect(initOf(mockFetch, 2).body).toBeInstanceOf(FormData);
  });

  it("every Chatwoot call is time-bounded: 20s for the JSON calls, 120s for the upload", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    try {
      setupFrom([makeBuilder(NO_IDS_ROW), makeBuilder({ data: null, error: null })]);
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(jsonResponse(200, contactCreateResponse))
        .mockResolvedValueOnce(jsonResponse(200, { id: 34 }))
        .mockResolvedValue(jsonResponse(200, { id: 99 }));
      vi.stubGlobal("fetch", mockFetch);

      await mirrorInboundAttachment(CHAT, async () => voiceNote(), undefined, "[הודעה קולית]");
      await mirrorOutbound(CHAT, "reply");

      expect(timeoutSpy.mock.calls.map((c) => c[0])).toEqual([20_000, 20_000, 120_000, 20_000]);
      for (let i = 0; i < 4; i++) {
        expect(initOf(mockFetch, i).signal).toBe(timeoutSpy.mock.results[i]!.value);
      }
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});

describe("mirrorInboundAttachment — the conversation comes before the download", () => {
  it("a new lead's slow first file: the conversation exists (and is persisted) before the download ends", async () => {
    setupFrom([makeBuilder(NO_IDS_ROW), makeBuilder({ data: null, error: null })]);
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, contactCreateResponse))
      .mockResolvedValueOnce(jsonResponse(200, { id: 34 }))
      .mockResolvedValue(jsonResponse(200, { id: 99 }));
    vi.stubGlobal("fetch", mockFetch);
    const download = deferred<ChatwootAttachment | null>();
    const loader = vi.fn(() => download.promise);

    const done = mirrorInboundAttachment(CHAT, loader, undefined, "[וידאו]", "Dana");
    await vi.waitFor(() => expect(loader).toHaveBeenCalledOnce());

    expect(urlsOf(mockFetch)).toEqual([
      "https://cw.test/api/v1/accounts/1/contacts",
      "https://cw.test/api/v1/accounts/1/conversations",
    ]);
    const persistBuilder = mockFromImpl.mock.results[1]!.value as Record<string, unknown>;
    expect(persistBuilder["update"]).toHaveBeenCalledWith({ chatwoot_contact_id: 12, chatwoot_conversation_id: 34 });
    // What a menu tap's auto-assign reads while the file is still downloading.
    await expect(resolveConversationId(CHAT)).resolves.toBe(34);

    download.resolve(voiceNote());
    await done;
    expect(urlsOf(mockFetch)[2]).toBe("https://cw.test/api/v1/accounts/1/conversations/34/messages");
    expect(initOf(mockFetch, 2).body).toBeInstanceOf(FormData);
  });

  it("nowhere to post (the contact cannot be created) → the file is never downloaded", async () => {
    setupFrom([makeBuilder(NO_IDS_ROW)]);
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(500, {}));
    vi.stubGlobal("fetch", mockFetch);
    const loader = vi.fn();

    await mirrorInboundAttachment(CHAT, loader, CAPTION, `[תמונה]\n${CAPTION}`);

    expect(loader).not.toHaveBeenCalled();
    expect(urlsOf(mockFetch)).toEqual(["https://cw.test/api/v1/accounts/1/contacts"]);
  });

  it("download failed and the conversation was deleted → the placeholder goes to a rebuilt conversation", async () => {
    setupFrom([
      makeBuilder(CACHED_ROW),
      makeBuilder({ data: null, error: null }), // clear ids
      makeBuilder(NO_IDS_ROW), // re-read after clear
      makeBuilder({ data: null, error: null }), // persist fresh ids
    ]);
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(404, {}))
      .mockResolvedValueOnce(jsonResponse(200, contactCreateResponse))
      .mockResolvedValueOnce(jsonResponse(200, { id: 92 }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 300 }));
    vi.stubGlobal("fetch", mockFetch);

    await mirrorInboundAttachment(CHAT, async () => null, CAPTION, `[תמונה]\n${CAPTION}`);

    expect(urlsOf(mockFetch)).toEqual([
      "https://cw.test/api/v1/accounts/1/conversations/88/messages",
      "https://cw.test/api/v1/accounts/1/contacts",
      "https://cw.test/api/v1/accounts/1/conversations",
      "https://cw.test/api/v1/accounts/1/conversations/92/messages",
    ]);
    expect(JSON.parse(initOf(mockFetch, 3).body as string)).toEqual({
      content: `[תמונה]\n${CAPTION}`,
      message_type: "incoming",
      private: false,
    });
  });
});

describe("mirrorInboundAttachment — 404 recovery", () => {
  it("clears the ids, rebuilds the conversation once and re-uploads there", async () => {
    setupFrom([
      makeBuilder(CACHED_ROW),
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
    const blobSources = countBlobs();

    await mirrorInboundAttachment(CHAT, async () => voiceNote(), undefined, "[הודעה קולית]");

    expect(mockFetch).toHaveBeenCalledTimes(4);
    const clearBuilder = mockFromImpl.mock.results[1]!.value as Record<string, unknown>;
    expect(clearBuilder["update"]).toHaveBeenCalledWith({ chatwoot_contact_id: null, chatwoot_conversation_id: null });
    expect((mockFetch.mock.calls[3] as [string])[0]).toContain("/conversations/90/messages");
    expect(initOf(mockFetch, 3).body).toBeInstanceOf(FormData);

    // One Blob for both uploads, built straight from the Buffer (no extra copy).
    expect(blobSources).toHaveLength(1);
    expect(blobSources[0]).toBe(VOICE_BYTES);
    for (const call of [0, 3]) {
      const file = (initOf(mockFetch, call).body as FormData).get("attachments[]") as File;
      expect(Buffer.from(await file.arrayBuffer()).equals(VOICE_BYTES)).toBe(true);
    }
  });

  it("does not loop: when the retry fails too, the placeholder goes to the rebuilt conversation", async () => {
    setupFrom([
      makeBuilder(CACHED_ROW),
      makeBuilder({ data: null, error: null }),
      makeBuilder(NO_IDS_ROW),
      makeBuilder({ data: null, error: null }),
    ]);
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(404, {}))
      .mockResolvedValueOnce(jsonResponse(200, contactCreateResponse))
      .mockResolvedValueOnce(jsonResponse(200, { id: 91 }))
      .mockResolvedValueOnce(jsonResponse(500, {}))
      .mockResolvedValueOnce(jsonResponse(200, { id: 201 }));
    vi.stubGlobal("fetch", mockFetch);

    await mirrorInboundAttachment(CHAT, async () => voiceNote(), undefined, "[הודעה קולית]");

    expect(mockFetch).toHaveBeenCalledTimes(5);
    expect((mockFetch.mock.calls[4] as [string])[0]).toContain("/conversations/91/messages");
    expect(JSON.parse(initOf(mockFetch, 4).body as string)).toEqual({
      content: "[הודעה קולית]",
      message_type: "incoming",
      private: false,
    });
  });
});

describe("mirrorInboundAttachment — the placeholder fallback (nothing disappears)", () => {
  it("Chatwoot rejects the upload (≥400) → the placeholder with the caption is posted as plain text", async () => {
    setupFrom([makeBuilder(CACHED_ROW)]);
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(413, { error: "too large" }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 2 }));
    vi.stubGlobal("fetch", mockFetch);

    await mirrorInboundAttachment(
      CHAT,
      async () => ({ bytes: Buffer.from("mp4"), fileName: FILE_NAME, contentType: "video/mp4" }),
      CAPTION,
      `[וידאו]\n${CAPTION}`,
    );

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(initOf(mockFetch, 1).body as string)).toEqual({
      content: `[וידאו]\n${CAPTION}`,
      message_type: "incoming",
      private: false,
    });
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      { chatId: CHAT, status: 413, contentType: "video/mp4", size: 3 },
      "chatwoot attachment upload failed — posting the placeholder",
    );
  });

  it("an upload timeout or network error → placeholder posted, never a rejection", async () => {
    setupFrom([makeBuilder(CACHED_ROW)]);
    const mockFetch = vi.fn()
      .mockRejectedValueOnce(new DOMException("The operation was aborted due to timeout", "TimeoutError"))
      .mockResolvedValueOnce(jsonResponse(200, { id: 2 }));
    vi.stubGlobal("fetch", mockFetch);

    await expect(
      mirrorInboundAttachment(CHAT, async () => voiceNote(), undefined, "[הודעה קולית]"),
    ).resolves.toBeUndefined();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(initOf(mockFetch, 1).body as string)).toMatchObject({ content: "[הודעה קולית]" });
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: CHAT, status: null }),
      "chatwoot attachment upload failed — posting the placeholder",
    );
  });

  it("the file could not be downloaded (loader → null) → placeholder posted exactly like a text mirror", async () => {
    setupFrom([makeBuilder(CACHED_ROW)]);
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(200, { id: 2 }));
    vi.stubGlobal("fetch", mockFetch);

    await mirrorInboundAttachment(CHAT, async () => null, CAPTION, `[תמונה]\n${CAPTION}`, "Dana");

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(JSON.parse(initOf(mockFetch, 0).body as string)).toEqual({
      content: `[תמונה]\n${CAPTION}`,
      message_type: "incoming",
      private: false,
    });
  });

  it("a loader that throws counts as no file → placeholder posted", async () => {
    setupFrom([makeBuilder(CACHED_ROW)]);
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(200, { id: 2 }));
    vi.stubGlobal("fetch", mockFetch);

    await mirrorInboundAttachment(
      CHAT,
      () => Promise.reject(new Error("import failed")),
      undefined,
      "[סטיקר]",
    );

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(JSON.parse(initOf(mockFetch, 0).body as string)).toMatchObject({ content: "[סטיקר]" });
  });

  it("blank env → the file is never even loaded; zero fetches, zero DB reads", async () => {
    envMock.CHATWOOT_BOT_TOKEN = undefined;
    const loader = vi.fn();
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    await mirrorInboundAttachment(CHAT, loader, CAPTION, "[תמונה]");

    expect(loader).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockFromImpl).not.toHaveBeenCalled();
  });

  it("logs never carry the caption, the file name or the bytes", async () => {
    setupFrom([makeBuilder(CACHED_ROW)]);
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(500, { content: CAPTION }))
      .mockRejectedValueOnce(new Error("ECONNRESET"));
    vi.stubGlobal("fetch", mockFetch);

    await mirrorInboundAttachment(
      CHAT,
      async () => voiceNote({ fileName: FILE_NAME }),
      CAPTION,
      `[הודעה קולית]\n${CAPTION}`,
    );

    expect(vi.mocked(logger.warn)).toHaveBeenCalled();
    // Error messages are part of what is checked: the placeholder post's network error is there.
    expect(allLogs()).toContain("ECONNRESET");
    expect(allLogs()).not.toContain(CAPTION);
    expect(allLogs()).not.toContain(FILE_NAME);
    expect(allLogs()).not.toContain("OggS");
  });

  it("a loader error is logged by its message only — never the caption or file name", async () => {
    setupFrom([makeBuilder(CACHED_ROW)]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { id: 2 })));

    await mirrorInboundAttachment(
      CHAT,
      () => Promise.reject(new Error("inbound-media import failed")),
      CAPTION,
      `[מסמך]\n${CAPTION}`,
    );

    expect(allLogs()).toContain("inbound-media import failed");
    expect(allLogs()).not.toContain(CAPTION);
  });
});

// ---------------------------------------------------------------------------
// Per-chat serial queue
// ---------------------------------------------------------------------------

describe("mirror — per-chat serial queue", () => {
  it("a bot reply mirrored right after a slow attachment is posted AFTER it", async () => {
    setupFrom([makeBuilder(CACHED_ROW)]);
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(200, { id: 1 }));
    vi.stubGlobal("fetch", mockFetch);
    const download = deferred<ChatwootAttachment | null>();
    const loader = vi.fn(() => download.promise);

    const attachmentDone = mirrorInboundAttachment(CHAT, loader, undefined, "[תמונה]");
    const replyDone = mirrorOutbound(CHAT, "תודה, קיבלנו");
    await vi.waitFor(() => expect(loader).toHaveBeenCalledOnce());
    await settle();

    expect(mockFetch).not.toHaveBeenCalled();

    download.resolve({
      bytes: Buffer.from("jpeg"),
      fileName: "image-2026-10-13_18-05-09.jpg",
      contentType: "image/jpeg",
    });
    await Promise.all([attachmentDone, replyDone]);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(initOf(mockFetch, 0).body).toBeInstanceOf(FormData);
    expect(JSON.parse(initOf(mockFetch, 1).body as string)).toMatchObject({
      content: "תודה, קיבלנו",
      message_type: "outgoing",
    });
  });

  it("each returned promise settles when THAT post is done", async () => {
    setupFrom([makeBuilder(CACHED_ROW)]);
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(200, { id: 1 }));
    vi.stubGlobal("fetch", mockFetch);
    const download = deferred<ChatwootAttachment | null>();
    const loader = vi.fn(() => download.promise);

    let replySettled = false;
    const attachmentDone = mirrorInboundAttachment(CHAT, loader, undefined, "[וידאו]");
    const replyDone = mirrorOutbound(CHAT, "reply").then(() => {
      replySettled = true;
    });
    await vi.waitFor(() => expect(loader).toHaveBeenCalledOnce());
    await settle();
    expect(replySettled).toBe(false);

    download.resolve(voiceNote());
    await attachmentDone;
    await replyDone;
    expect(replySettled).toBe(true);
  });

  it("different chats are not blocked by each other", async () => {
    mockFromImpl.mockImplementation(() => makeBuilder(CACHED_ROW));
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(200, { id: 1 }));
    vi.stubGlobal("fetch", mockFetch);
    const download = deferred<ChatwootAttachment | null>();
    const loader = vi.fn(() => download.promise);

    const slow = mirrorInboundAttachment(CHAT, loader, undefined, "[וידאו]");
    // The other chat starts once this one is mid-download. (Starting both at once would race
    // two dynamic imports of the mocked supabase module, which Vitest can resolve to the real one.)
    await vi.waitFor(() => expect(loader).toHaveBeenCalledOnce());
    await mirrorInbound("972509998877@c.us", "שלום מהצאט השני");

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(JSON.parse(initOf(mockFetch, 0).body as string)).toMatchObject({ content: "שלום מהצאט השני" });

    download.resolve(voiceNote());
    await slow;
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("resetChatwootCache() also drops the queues, so a never-ending task cannot hold up the next test", async () => {
    mockFromImpl.mockImplementation(() => makeBuilder(CACHED_ROW));
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(200, { id: 1 }));
    vi.stubGlobal("fetch", mockFetch);
    const download = deferred<ChatwootAttachment | null>();
    const loader = vi.fn(() => download.promise);

    const stuck = mirrorInboundAttachment(CHAT, loader, undefined, "[וידאו]");
    await vi.waitFor(() => expect(loader).toHaveBeenCalledOnce());
    resetChatwootCache();

    await mirrorInbound(CHAT, "after the reset");
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(JSON.parse(initOf(mockFetch, 0).body as string)).toMatchObject({ content: "after the reset" });

    download.resolve(null);
    await stuck;
  });

  it("keeps working after a failed task, in order", async () => {
    setupFrom([makeBuilder(CACHED_ROW)]);
    const mockFetch = vi.fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValue(jsonResponse(200, { id: 2 }));
    vi.stubGlobal("fetch", mockFetch);

    const first = mirrorInbound(CHAT, "first");
    const second = mirrorInbound(CHAT, "second");

    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: CHAT }),
      "chatwoot mirrorInbound failed — continuing",
    );
    expect(JSON.parse(initOf(mockFetch, 1).body as string)).toMatchObject({ content: "second" });

    await mirrorOutbound(CHAT, "third");
    expect(JSON.parse(initOf(mockFetch, 2).body as string)).toMatchObject({ content: "third" });
  });

  it("two mirrors racing for a brand-new chat create ONE Chatwoot conversation (the 2026-10-01 duplicate)", async () => {
    setupFrom([makeBuilder(NO_IDS_ROW), makeBuilder({ data: null, error: null })]);
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, contactCreateResponse))
      .mockResolvedValueOnce(jsonResponse(200, { id: 34 }))
      .mockResolvedValue(jsonResponse(200, { id: 99 }));
    vi.stubGlobal("fetch", mockFetch);

    await Promise.all([
      mirrorInboundAttachment(CHAT, async () => voiceNote(), undefined, "[הודעה קולית]", "Dana"),
      mirrorOutbound(CHAT, "היי, הגעתם לשקד"),
    ]);

    const urls = mockFetch.mock.calls.map((c) => (c as [string])[0]);
    expect(urls).toEqual([
      "https://cw.test/api/v1/accounts/1/contacts",
      "https://cw.test/api/v1/accounts/1/conversations",
      "https://cw.test/api/v1/accounts/1/conversations/34/messages",
      "https://cw.test/api/v1/accounts/1/conversations/34/messages",
    ]);
  });
});
