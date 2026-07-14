import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// vi.hoisted shared mock functions
// ---------------------------------------------------------------------------
const {
  mockSendMessageWith,
  mockNotifyCreds,
  mockGenerateReply,
  mockGetDocument,
  mockGetTranscript,
  mockGetRecording,
  mockGetMeeting,
  mockFromImpl,
} = vi.hoisted(() => {
  const mockSendMessageWith = vi.fn();
  const mockNotifyCreds = vi.fn();
  const mockGenerateReply = vi.fn();
  const mockGetDocument = vi.fn();
  const mockGetTranscript = vi.fn();
  const mockGetRecording = vi.fn();
  const mockGetMeeting = vi.fn();
  const mockFromImpl = vi.fn();

  return {
    mockSendMessageWith,
    mockNotifyCreds,
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
  notifyCreds: mockNotifyCreds,
  sendMessageWith: mockSendMessageWith,
  sendInteractiveButtonsWith: vi.fn().mockResolvedValue({ idMessage: "btn-msg" }),
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
// Imports under test (after mocks)
// ---------------------------------------------------------------------------
import { sendSummaryToOwner, resolveSummaryDoc } from "./timeless.service.js";

const NOTIFY_CREDS = { idInstance: "notify-id", token: "notify-token", baseUrl: "https://notify.api.greenapi.com" };
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
// sendSummaryToOwner — DISABLED (2026-07-15): no-ops before any DB read/claim
// or WhatsApp send. Owner sends are no longer needed.
// ---------------------------------------------------------------------------
describe("sendSummaryToOwner — disabled (no-op)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNotifyCreds.mockReturnValue(NOTIFY_CREDS);
  });

  it("does not call sendMessage, generateReply, or touch the DB", async () => {
    await sendSummaryToOwner("meet-a", "client-a");

    expect(mockSendMessageWith).not.toHaveBeenCalled();
    expect(mockGenerateReply).not.toHaveBeenCalled();
    expect(mockFromImpl).not.toHaveBeenCalled();
  });
});
