import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// vi.hoisted shared mock functions
// ---------------------------------------------------------------------------
const {
  mockSendStaffMessage,
  mockSendMessageWithTyping,
  mockGetSignedDocUrl,
  mockFromImpl,
} = vi.hoisted(() => {
  const mockSendStaffMessage = vi.fn().mockResolvedValue({ idMessage: "staff-msg" });
  const mockSendMessageWithTyping = vi.fn().mockResolvedValue({ idMessage: "typing-msg" });
  const mockGetSignedDocUrl = vi.fn().mockResolvedValue(null);
  const mockFromImpl = vi.fn();

  return {
    mockSendStaffMessage,
    mockSendMessageWithTyping,
    mockGetSignedDocUrl,
    mockFromImpl,
  };
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock("../../config/env.js", () => ({
  env: {
    BACKEND_URL: "http://localhost:3000",
    NODE_ENV: "test",
  },
}));

vi.mock("../../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../config/supabase.js", () => ({
  supabaseAdmin: { from: mockFromImpl },
}));

vi.mock("../whatsapp/whatsapp.service.js", () => ({
  sendStaffMessage: mockSendStaffMessage,
  sendMessageWithTyping: mockSendMessageWithTyping,
}));

vi.mock("../whatsapp/whatsapp.util.js", () => ({
  toChatId: (raw: string | null | undefined): string | null => {
    if (!raw) return null;
    const digits = raw.replace(/\D/g, "");
    if (!digits || digits.length < 10) return null;
    return `${digits}@c.us`;
  },
}));

vi.mock("../../lib/storage.js", () => ({
  getSignedDocUrl: mockGetSignedDocUrl,
}));

vi.mock("./operations.format.js", () => ({
  TASK_LABELS_HE: {
    forms_check: "בדיקת טפסים",
    receipt_check: "בדיקת קבלה",
    policy_check: "בדיקת פוליסה",
    deposit_check: "בדיקת הפקדה",
    cross_check: "הצלבת מסמכים",
  },
  formatDueDate: (iso: string) => new Date(iso).toLocaleDateString("he-IL"),
}));

// ---------------------------------------------------------------------------
// Builder shim helpers
// ---------------------------------------------------------------------------
type Builder = Record<string, unknown>;

function makeBuilder(result: unknown): Builder {
  const terminal = vi.fn().mockResolvedValue(result);
  const builder: Builder = {};
  const chainMethods = [
    "select", "eq", "neq", "is", "not", "in", "gte", "lte",
    "order", "insert", "upsert", "update", "limit",
  ];
  for (const m of chainMethods) {
    builder[m] = vi.fn().mockReturnValue(builder);
  }
  builder["maybeSingle"] = terminal;
  builder["single"] = terminal;
  builder["then"] = (onFulfilled: (v: unknown) => unknown) => Promise.resolve(result).then(onFulfilled);
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
// Shared test data
// ---------------------------------------------------------------------------
const MEETING_ID = "meeting-handoff-1";
const CLIENT_ID = "client-handoff-1";
const STAFF_ID = "staff-handoff-1";
const STAFF_PHONE = "0521234567";

function seedHappyPath() {
  const meetingBuilder = makeBuilder({
    data: {
      id: MEETING_ID,
      client_id: CLIENT_ID,
      summary_final: "סיכום סופי",
      summary_draft: null,
    },
    error: null,
  });

  const clientBuilder = makeBuilder({
    data: {
      full_name: "ישראל ישראלי",
      phone: "0541234567",
      id_number: "123456789",
      inquiry_type: "ביטוח חיים",
      id_photo_url: null,
      poa_doc_url: null,
      assigned_to: STAFF_ID,
      assigned_handler_id: null,
      complexity: null,
    },
    error: null,
  });

  const staffBuilder = makeBuilder({
    data: { full_name: "אריאל כהן", phone: STAFF_PHONE },
    error: null,
  });

  const tasksBuilder = makeBuilder({
    data: [
      { type: "forms_check", due_at: new Date(Date.now() + 7 * 86400000).toISOString() },
    ],
    error: null,
  });

  setupFromSequence([meetingBuilder, clientBuilder, staffBuilder, tasksBuilder]);
}

// ---------------------------------------------------------------------------
// Imports under test
// ---------------------------------------------------------------------------
import { notifyStaffHandoff } from "./operations.staff-handoff.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("notifyStaffHandoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSignedDocUrl.mockResolvedValue(null);
  });

  it("viaConversationalBot: true → calls sendMessageWithTyping (instance #1), NOT sendStaffMessage", async () => {
    seedHappyPath();

    await notifyStaffHandoff(MEETING_ID, { viaConversationalBot: true });

    expect(mockSendMessageWithTyping).toHaveBeenCalledOnce();
    expect(mockSendStaffMessage).not.toHaveBeenCalled();

    const [chatId, body] = mockSendMessageWithTyping.mock.calls[0] as [string, string];
    expect(chatId).toBe(`${STAFF_PHONE.replace(/\D/g, "")}@c.us`);
    expect(body).toContain("📥 תיק לקוח חדש");
  });

  it("default (no opts) → calls sendStaffMessage (instance #2), NOT sendMessageWithTyping", async () => {
    seedHappyPath();

    await notifyStaffHandoff(MEETING_ID);

    expect(mockSendStaffMessage).toHaveBeenCalledOnce();
    expect(mockSendMessageWithTyping).not.toHaveBeenCalled();

    const [chatId, body] = mockSendStaffMessage.mock.calls[0] as [string, string];
    expect(chatId).toBe(`${STAFF_PHONE.replace(/\D/g, "")}@c.us`);
    expect(body).toContain("📥 תיק לקוח חדש");
  });

  it("explicit viaConversationalBot: false → uses sendStaffMessage", async () => {
    seedHappyPath();

    await notifyStaffHandoff(MEETING_ID, { viaConversationalBot: false });

    expect(mockSendStaffMessage).toHaveBeenCalledOnce();
    expect(mockSendMessageWithTyping).not.toHaveBeenCalled();
  });

  it("staff with no phone → neither send called (logs and returns)", async () => {
    const meetingBuilder = makeBuilder({
      data: {
        id: MEETING_ID,
        client_id: CLIENT_ID,
        summary_final: null,
        summary_draft: "טיוטה",
      },
      error: null,
    });

    const clientBuilder = makeBuilder({
      data: {
        full_name: "לקוח",
        phone: "0541111111",
        id_number: null,
        inquiry_type: "כללי",
        id_photo_url: null,
        poa_doc_url: null,
        assigned_to: STAFF_ID,
        assigned_handler_id: null,
        complexity: null,
      },
      error: null,
    });

    // Staff has no phone
    const staffBuilder = makeBuilder({
      data: { full_name: "ללא טלפון", phone: null },
      error: null,
    });

    setupFromSequence([meetingBuilder, clientBuilder, staffBuilder]);

    await notifyStaffHandoff(MEETING_ID, { viaConversationalBot: true });

    expect(mockSendMessageWithTyping).not.toHaveBeenCalled();
    expect(mockSendStaffMessage).not.toHaveBeenCalled();
  });

  it("meeting not found → returns without any sends", async () => {
    const meetingBuilder = makeBuilder({ data: null, error: null });
    setupFromSequence([meetingBuilder]);

    await notifyStaffHandoff(MEETING_ID);

    expect(mockSendStaffMessage).not.toHaveBeenCalled();
    expect(mockSendMessageWithTyping).not.toHaveBeenCalled();
  });

  it("message body contains client name and inquiry type", async () => {
    seedHappyPath();

    await notifyStaffHandoff(MEETING_ID, { viaConversationalBot: false });

    const [, body] = mockSendStaffMessage.mock.calls[0] as [string, string];
    expect(body).toContain("ישראל ישראלי");
    expect(body).toContain("ביטוח חיים");
  });

  it("message body contains summary when summary_final exists", async () => {
    seedHappyPath();

    await notifyStaffHandoff(MEETING_ID, { viaConversationalBot: false });

    const [, body] = mockSendStaffMessage.mock.calls[0] as [string, string];
    expect(body).toContain("סיכום סופי");
    expect(body).toContain("📝 סיכום הפגישה");
  });
});
