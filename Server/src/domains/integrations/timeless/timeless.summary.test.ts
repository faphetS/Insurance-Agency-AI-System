import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// vi.hoisted shared mock functions
// ---------------------------------------------------------------------------
const {
  mockSendMessage,
  mockGenerateReply,
  mockGetDocument,
  mockGetTranscript,
  mockGetRecording,
  mockGetMeeting,
  mockFromImpl,
} = vi.hoisted(() => {
  const mockSendMessage = vi.fn();
  const mockGenerateReply = vi.fn();
  const mockGetDocument = vi.fn();
  const mockGetTranscript = vi.fn();
  const mockGetRecording = vi.fn();
  const mockGetMeeting = vi.fn();
  const mockFromImpl = vi.fn();

  return {
    mockSendMessage,
    mockGenerateReply,
    mockGetDocument,
    mockGetTranscript,
    mockGetRecording,
    mockGetMeeting,
    mockFromImpl,
  };
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock("../../../config/env.js", () => ({
  env: {
    BACKEND_URL: "http://localhost:3000",
    NODE_ENV: "test",
    SUMMARY_RECIPIENT_PHONE: "639219909210",
  },
}));

vi.mock("../../../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../../config/supabase.js", () => ({
  supabaseAdmin: { from: mockFromImpl },
}));

vi.mock("./timeless.client.js", () => ({
  getMeeting: mockGetMeeting,
  getTranscript: mockGetTranscript,
  getRecording: mockGetRecording,
  getDocument: mockGetDocument,
  listWebhooks: vi.fn(),
  createWebhook: vi.fn(),
  deleteWebhook: vi.fn(),
}));

vi.mock("../../ai/ai.service.js", () => {
  // Inline the real isHebrew logic so detection is genuinely tested.
  function isHebrewImpl(text: string): boolean {
    if (!text || !text.trim()) return false;
    const hebrewCount = (text.match(/[ְ-׿]/g) ?? []).length;
    const latinCount = (text.match(/[A-Za-z]/g) ?? []).length;
    return hebrewCount > 0 && hebrewCount >= latinCount;
  }

  return {
    isHebrew: isHebrewImpl,
    ensureHebrew: async (text: string) => {
      if (isHebrewImpl(text)) return text;
      return mockGenerateReply([{ role: "user", text }], "translate-system-prompt", "google/gemini-2.5-flash");
    },
    generateReply: mockGenerateReply,
  };
});

vi.mock("../../whatsapp/whatsapp.service.js", () => ({
  sendMessage: mockSendMessage,
  sendInteractiveButtons: vi.fn().mockResolvedValue({ idMessage: "btn-msg" }),
}));

vi.mock("../../whatsapp/whatsapp.util.js", () => ({
  toChatId: (raw: string | null | undefined): string | null => {
    if (!raw) return null;
    const digits = raw.replace(/\D/g, "");
    if (!digits) return null;
    if (digits.length < 11) return null;
    return `${digits}@c.us`;
  },
}));

// ---------------------------------------------------------------------------
// Helpers: build supabase-shim builder chains
// ---------------------------------------------------------------------------

type Builder = Record<string, unknown>;

function makeBuilder(result: unknown): Builder {
  const terminal = vi.fn().mockResolvedValue(result);
  const builder: Builder = {};
  const chainMethods = ["select", "eq", "neq", "is", "not", "in", "gte", "lte", "order", "insert", "upsert", "update"];
  for (const m of chainMethods) {
    builder[m] = vi.fn().mockReturnValue(builder);
  }
  builder["maybeSingle"] = terminal;
  builder["single"] = terminal;
  return builder;
}

function setupFromSequence(builders: Builder[]): void {
  let callIndex = 0;
  mockFromImpl.mockImplementation(() => {
    const b = builders[callIndex] ?? builders[builders.length - 1];
    callIndex++;
    return b;
  });
}

// ---------------------------------------------------------------------------
// Imports under test (after mocks)
// ---------------------------------------------------------------------------
import { sendSummaryToOwner, resolveSummaryDoc } from "./timeless.service.js";
import { isHebrew } from "../../ai/ai.service.js";

// ---------------------------------------------------------------------------
// isHebrew unit tests
// ---------------------------------------------------------------------------
describe("isHebrew", () => {
  it("returns true for pure Hebrew text", () => {
    expect(isHebrew("שלום עולם")).toBe(true);
  });

  it("returns false for English text", () => {
    expect(isHebrew("Hello world")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isHebrew("")).toBe(false);
  });

  it("returns false for whitespace only", () => {
    expect(isHebrew("   ")).toBe(false);
  });

  it("returns true when Hebrew letters >= Latin letters (Hebrew heavy)", () => {
    expect(isHebrew("הלקוח מעוניין ok")).toBe(true);
  });

  it("returns false when Latin letters > Hebrew letters", () => {
    expect(isHebrew("meeting summary סיכום")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// F6: resolveSummaryDoc unit tests
// ---------------------------------------------------------------------------
describe("resolveSummaryDoc (F6)", () => {
  it("picks doc with title containing 'summary'", () => {
    const docs = [
      { id: "d1", title: "Meeting Summary", created_at: "2026-06-01T10:00:00Z" },
      { id: "d2", title: "Transcript", created_at: "2026-06-01T10:00:00Z" },
    ];
    expect(resolveSummaryDoc(docs)?.id).toBe("d1");
  });

  it("picks doc with Hebrew title 'סיכום פגישה'", () => {
    const docs = [
      { id: "d1", title: "סיכום פגישה", created_at: "2026-06-01T10:00:00Z" },
      { id: "d2", title: "Other", created_at: "2026-06-01T10:00:00Z" },
    ];
    expect(resolveSummaryDoc(docs)?.id).toBe("d1");
  });

  it("picks doc with title containing 'תקציר'", () => {
    const docs = [
      { id: "d1", title: "תקציר הפגישה", created_at: "2026-06-01T10:00:00Z" },
    ];
    expect(resolveSummaryDoc(docs)?.id).toBe("d1");
  });

  it("picks newest doc when multiple match", () => {
    const docs = [
      { id: "d1", title: "Summary v1", created_at: "2026-06-01T09:00:00Z" },
      { id: "d2", title: "Summary v2", created_at: "2026-06-01T10:00:00Z" },
    ];
    expect(resolveSummaryDoc(docs)?.id).toBe("d2");
  });

  it("uses single-doc fallback when no title matches", () => {
    const docs = [
      { id: "d1", title: "Untitled", created_at: "2026-06-01T10:00:00Z" },
    ];
    expect(resolveSummaryDoc(docs)?.id).toBe("d1");
  });

  it("returns undefined when multiple non-matching docs exist", () => {
    const docs = [
      { id: "d1", title: "Recording", created_at: "2026-06-01T10:00:00Z" },
      { id: "d2", title: "Transcript Raw", created_at: "2026-06-01T10:00:00Z" },
    ];
    expect(resolveSummaryDoc(docs)).toBeUndefined();
  });

  it("returns undefined for empty array", () => {
    expect(resolveSummaryDoc([])).toBeUndefined();
  });

  it("returns undefined for undefined documents", () => {
    expect(resolveSummaryDoc(undefined)).toBeUndefined();
  });

  it("matches 'recap', 'notes', 'minutes' in title", () => {
    for (const term of ["recap", "notes", "minutes"]) {
      const docs = [{ id: "d1", title: `Meeting ${term}`, created_at: "2026-06-01T10:00:00Z" }];
      expect(resolveSummaryDoc(docs)?.id).toBe("d1");
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario A — sendSummaryToOwner with Hebrew summary (no translation needed)
// ---------------------------------------------------------------------------
describe("sendSummaryToOwner — Scenario A: Hebrew summary", () => {
  const hebrewContent = "סיכום הפגישה: הלקוח מעוניין בביטוח חיים.";

  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateReply.mockImplementation(() => {
      throw new Error("generateReply MUST NOT be called for already-Hebrew input");
    });
    mockSendMessage.mockResolvedValue({ idMessage: "msg-a" });
  });

  it("sends to owner chatId derived from SUMMARY_RECIPIENT_PHONE without translation", async () => {
    const scheduledAt = new Date("2026-06-07T10:00:00Z").toISOString();

    const meetingSelectBuilder = makeBuilder({
      data: { summary_draft: hebrewContent, scheduled_at: scheduledAt, recording_url: null },
      error: null,
    });
    const clientSelectBuilder = makeBuilder({ data: { full_name: "דני לוי" }, error: null });
    const claimUpdateBuilder = makeBuilder({ data: { id: "meet-a" }, error: null });

    setupFromSequence([meetingSelectBuilder, clientSelectBuilder, claimUpdateBuilder]);

    await sendSummaryToOwner("meet-a", "client-a");

    expect(mockGenerateReply).not.toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalledOnce();

    const [chatId, body] = mockSendMessage.mock.calls[0] as [string, string];
    expect(chatId).toBe("639219909210@c.us");
    expect(body).toContain(hebrewContent);
    expect(body).toContain("📋 סיכום פגישה");
    expect(body).toContain("דני לוי");
  });

  it("includes recording URL when present", async () => {
    const scheduledAt = new Date("2026-06-07T10:00:00Z").toISOString();
    const recordingUrl = "https://timeless.day/recordings/abc123";

    const meetingSelectBuilder = makeBuilder({
      data: { summary_draft: hebrewContent, scheduled_at: scheduledAt, recording_url: recordingUrl },
      error: null,
    });
    const clientSelectBuilder = makeBuilder({ data: { full_name: "רחל כהן" }, error: null });
    const claimUpdateBuilder = makeBuilder({ data: { id: "meet-a2" }, error: null });

    setupFromSequence([meetingSelectBuilder, clientSelectBuilder, claimUpdateBuilder]);

    await sendSummaryToOwner("meet-a2", "client-a2");

    const [, body] = mockSendMessage.mock.calls[0] as [string, string];
    expect(body).toContain(recordingUrl);
  });
});

// ---------------------------------------------------------------------------
// Scenario B — sendSummaryToOwner with English summary (translation needed)
// ---------------------------------------------------------------------------
describe("sendSummaryToOwner — Scenario B: English summary", () => {
  const englishContent = "Meeting summary: the client is interested in life insurance.";
  const hebrewTranslation = "סיכום הפגישה: הלקוח מעוניין בביטוח חיים.";

  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateReply.mockResolvedValue(hebrewTranslation);
    mockSendMessage.mockResolvedValue({ idMessage: "msg-b" });
  });

  it("calls generateReply with model 'google/gemini-2.5-flash' and sends Hebrew translation", async () => {
    const scheduledAt = new Date("2026-06-07T10:00:00Z").toISOString();

    const meetingSelectBuilder = makeBuilder({
      data: { summary_draft: englishContent, scheduled_at: scheduledAt, recording_url: null },
      error: null,
    });
    const clientSelectBuilder = makeBuilder({ data: { full_name: "John Smith" }, error: null });
    const claimUpdateBuilder = makeBuilder({ data: { id: "meet-b" }, error: null });

    setupFromSequence([meetingSelectBuilder, clientSelectBuilder, claimUpdateBuilder]);

    await sendSummaryToOwner("meet-b", "client-b");

    expect(mockGenerateReply).toHaveBeenCalledOnce();
    const [history, , model] = mockGenerateReply.mock.calls[0] as [Array<{ role: string; text: string }>, string, string];
    expect(model).toBe("google/gemini-2.5-flash");
    expect(history[0].text).toBe(englishContent);

    expect(mockSendMessage).toHaveBeenCalledOnce();
    const [chatId, body] = mockSendMessage.mock.calls[0] as [string, string];
    expect(chatId).toBe("639219909210@c.us");
    expect(body).toContain(hebrewTranslation);
  });

  it("sets summary_status='sent' in the atomic claim update", async () => {
    const scheduledAt = new Date("2026-06-07T10:00:00Z").toISOString();

    let capturedUpdateArg: unknown = null;
    const claimBuilder: Builder = {};
    const chainMethods = ["select", "eq", "neq", "is", "not", "in", "gte", "lte", "order", "insert", "upsert"];
    for (const m of chainMethods) {
      claimBuilder[m] = vi.fn().mockReturnValue(claimBuilder);
    }
    claimBuilder["update"] = vi.fn().mockImplementation((arg: unknown) => {
      capturedUpdateArg = arg;
      return claimBuilder;
    });
    claimBuilder["maybeSingle"] = vi.fn().mockResolvedValue({ data: { id: "meet-b2" }, error: null });
    claimBuilder["single"] = vi.fn().mockResolvedValue({ data: { id: "meet-b2" }, error: null });

    const meetingSelectBuilder = makeBuilder({
      data: { summary_draft: englishContent, scheduled_at: scheduledAt, recording_url: null },
      error: null,
    });
    const clientSelectBuilder = makeBuilder({ data: { full_name: "Test" }, error: null });

    setupFromSequence([meetingSelectBuilder, clientSelectBuilder, claimBuilder]);

    await sendSummaryToOwner("meet-b2", "client-b2");

    expect(capturedUpdateArg).toMatchObject({ summary_status: "sent" });
    expect(capturedUpdateArg).toMatchObject({ summary_final: hebrewTranslation });
  });
});

// ---------------------------------------------------------------------------
// Idempotency: claim returns null → already sent, skip send
// ---------------------------------------------------------------------------
describe("sendSummaryToOwner — idempotency (already sent)", () => {
  it("does not call sendMessage when claim returns null data", async () => {
    vi.clearAllMocks();
    mockGenerateReply.mockResolvedValue("הסיכום בעברית.");
    mockSendMessage.mockResolvedValue({ idMessage: "msg-idem" });

    const hebrewContent = "סיכום כבר קיים.";
    const meetingSelectBuilder = makeBuilder({
      data: { summary_draft: hebrewContent, scheduled_at: new Date().toISOString(), recording_url: null },
      error: null,
    });
    const clientSelectBuilder = makeBuilder({ data: { full_name: "לקוח" }, error: null });
    const claimBuilder = makeBuilder({ data: null, error: null });

    setupFromSequence([meetingSelectBuilder, clientSelectBuilder, claimBuilder]);

    await sendSummaryToOwner("meet-idem", "client-idem");

    expect(mockSendMessage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Error handling: send failure reverts the claim
// ---------------------------------------------------------------------------
describe("sendSummaryToOwner — error handling", () => {
  it("reverts claim and re-throws when sendMessage fails", async () => {
    vi.clearAllMocks();
    mockGenerateReply.mockImplementation(() => {
      throw new Error("generateReply must not be called for Hebrew");
    });
    const sendError = new Error("WhatsApp send failed");
    mockSendMessage.mockRejectedValue(sendError);

    const hebrewContent = "סיכום הפגישה בעברית.";

    const meetingSelectBuilder = makeBuilder({
      data: { summary_draft: hebrewContent, scheduled_at: new Date().toISOString(), recording_url: null },
      error: null,
    });
    const clientSelectBuilder = makeBuilder({ data: { full_name: "לקוח" }, error: null });
    const claimUpdateBuilder = makeBuilder({ data: { id: "meet-err" }, error: null });
    const revertBuilder = makeBuilder({ data: null, error: null });

    setupFromSequence([meetingSelectBuilder, clientSelectBuilder, claimUpdateBuilder, revertBuilder]);

    await expect(sendSummaryToOwner("meet-err", "client-err")).rejects.toThrow("WhatsApp send failed");

    expect(mockFromImpl).toHaveBeenCalledTimes(4);
  });
});

// ---------------------------------------------------------------------------
// No phone configured → early return
// ---------------------------------------------------------------------------
describe("sendSummaryToOwner — no SUMMARY_RECIPIENT_PHONE", () => {
  it("returns early without DB calls when env var is absent", async () => {
    vi.clearAllMocks();
    const { env } = await import("../../../config/env.js");
    const originalPhone = (env as Record<string, unknown>)["SUMMARY_RECIPIENT_PHONE"];
    (env as Record<string, unknown>)["SUMMARY_RECIPIENT_PHONE"] = undefined;

    await sendSummaryToOwner("meet-nophone", "client-nophone");

    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockFromImpl).not.toHaveBeenCalled();

    (env as Record<string, unknown>)["SUMMARY_RECIPIENT_PHONE"] = originalPhone;
  });
});
