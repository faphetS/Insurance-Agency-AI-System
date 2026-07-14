import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// vi.hoisted shared mock functions
// ---------------------------------------------------------------------------
const {
  mockSendInteractiveButtonsWith,
  mockSendMessageWith,
  mockNotifyCreds,
  mockSendOwnerEmail,
  mockFromImpl,
} = vi.hoisted(() => {
  const mockSendInteractiveButtonsWith = vi.fn();
  const mockSendMessageWith = vi.fn();
  const mockNotifyCreds = vi.fn();
  const mockSendOwnerEmail = vi.fn();
  const mockFromImpl = vi.fn();

  return {
    mockSendInteractiveButtonsWith,
    mockSendMessageWith,
    mockNotifyCreds,
    mockSendOwnerEmail,
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
  getMeeting: vi.fn(),
  getTranscript: vi.fn(),
  getRecording: vi.fn(),
  getDocument: vi.fn(),
  listWebhooks: vi.fn(),
  createWebhook: vi.fn(),
  deleteWebhook: vi.fn(),
}));

vi.mock("../../ai/ai.service.js", () => ({
  isHebrew: vi.fn().mockReturnValue(true),
  ensureHebrew: vi.fn().mockImplementation((text: string) => Promise.resolve(text)),
  generateReply: vi.fn(),
}));

vi.mock("../../whatsapp/whatsapp.service.js", () => ({
  notifyCreds: mockNotifyCreds,
  sendMessageWith: mockSendMessageWith,
  sendInteractiveButtonsWith: mockSendInteractiveButtonsWith,
}));

// Use the REAL toChatId implementation so 639219909210 → 639219909210@c.us is genuinely exercised.
vi.mock("../../whatsapp/whatsapp.util.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../whatsapp/whatsapp.util.js")>();
  return {
    toChatId: actual.toChatId,
  };
});

vi.mock("../google/google.gmail.js", () => ({
  sendOwnerEmail: mockSendOwnerEmail,
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
// Imports under test (after mocks)
// ---------------------------------------------------------------------------
import { sendStaffPickerToOwner, sendClientSummaryEmail } from "./timeless.service.js";

const NOTIFY_CREDS = { idInstance: "notify-id", token: "notify-token", baseUrl: "https://notify.api.greenapi.com" };

// ---------------------------------------------------------------------------
// sendStaffPickerToOwner
// ---------------------------------------------------------------------------
describe("sendStaffPickerToOwner", () => {
  const MEETING_ID = "meeting-picker-1";

  beforeEach(() => {
    vi.clearAllMocks();
    mockNotifyCreds.mockReturnValue(NOTIFY_CREDS);
    mockSendInteractiveButtonsWith.mockResolvedValue({ idMessage: "btn-msg" });
  });

  it("calls sendInteractiveButtons with chatId 639219909210@c.us and 5-button array when 5 active staff", async () => {
    const staffList = [
      { id: "s1", full_name: "אריאל כהן" },
      { id: "s2", full_name: "דנה לוי" },
      { id: "s3", full_name: "יוסי ברק" },
      { id: "s4", full_name: "נועה פרץ" },
      { id: "s5", full_name: "מיכל שאול" },
    ];

    const staffBuilder = makeBuilder({ data: staffList, error: null });
    const claimBuilder = makeBuilder({ data: { id: MEETING_ID }, error: null });
    setupFromSequence([staffBuilder, claimBuilder]);

    await sendStaffPickerToOwner(MEETING_ID);

    expect(mockSendInteractiveButtonsWith).toHaveBeenCalledOnce();
    const [creds, chatId, body, buttons] = mockSendInteractiveButtonsWith.mock.calls[0] as [
      unknown,
      string,
      string,
      { buttonId: string; buttonText: string }[],
    ];
    expect(creds).toEqual(NOTIFY_CREDS);
    expect(chatId).toBe("639219909210@c.us");
    expect(body).toBe("👤 בחר/י את הגורם המטפל בלקוח:");
    expect(buttons).toHaveLength(5);
    expect(buttons[0]).toMatchObject({
      buttonId: `assign_staff:${MEETING_ID}:s1`,
      buttonText: "אריאל כהן",
    });
  });

  it("buttonId format is assign_staff:<meetingId>:<staffId>", async () => {
    const staffList = [{ id: "staff-abc", full_name: "Test Staff" }];
    const staffBuilder = makeBuilder({ data: staffList, error: null });
    const claimBuilder = makeBuilder({ data: { id: MEETING_ID }, error: null });
    setupFromSequence([staffBuilder, claimBuilder]);

    await sendStaffPickerToOwner(MEETING_ID);

    const [, , , buttons] = mockSendInteractiveButtonsWith.mock.calls[0] as [
      unknown,
      string,
      string,
      { buttonId: string; buttonText: string }[],
    ];
    expect(buttons[0].buttonId).toBe(`assign_staff:${MEETING_ID}:staff-abc`);
  });

  it("truncates full_name >25 chars to 25 in buttonText", async () => {
    const longName = "א".repeat(30);
    const staffList = [{ id: "s-long", full_name: longName }];
    const staffBuilder = makeBuilder({ data: staffList, error: null });
    const claimBuilder = makeBuilder({ data: { id: MEETING_ID }, error: null });
    setupFromSequence([staffBuilder, claimBuilder]);

    await sendStaffPickerToOwner(MEETING_ID);

    const [, , , buttons] = mockSendInteractiveButtonsWith.mock.calls[0] as [
      unknown,
      string,
      string,
      { buttonId: string; buttonText: string }[],
    ];
    expect(buttons[0].buttonText).toHaveLength(25);
    expect(buttons[0].buttonText).toBe(longName.slice(0, 25));
  });

  it("does NOT call sendInteractiveButtons when staff list is empty", async () => {
    const staffBuilder = makeBuilder({ data: [], error: null });
    setupFromSequence([staffBuilder]);

    await sendStaffPickerToOwner(MEETING_ID);

    expect(mockSendInteractiveButtonsWith).not.toHaveBeenCalled();
  });

  it("does NOT call sendInteractiveButtons when staff select returns null", async () => {
    const staffBuilder = makeBuilder({ data: null, error: null });
    setupFromSequence([staffBuilder]);

    await sendStaffPickerToOwner(MEETING_ID);

    expect(mockSendInteractiveButtonsWith).not.toHaveBeenCalled();
  });

  it("does NOT call sendInteractiveButtons when idempotency claim returns null (already sent)", async () => {
    const staffList = [{ id: "s1", full_name: "Test" }];
    const staffBuilder = makeBuilder({ data: staffList, error: null });
    const claimBuilder = makeBuilder({ data: null, error: null });
    setupFromSequence([staffBuilder, claimBuilder]);

    await sendStaffPickerToOwner(MEETING_ID);

    expect(mockSendInteractiveButtonsWith).not.toHaveBeenCalled();
  });

  it("allows >3 buttons (7 staff members — no cap)", async () => {
    const staffList = Array.from({ length: 7 }, (_, i) => ({
      id: `s${i}`,
      full_name: `Staff ${i}`,
    }));
    const staffBuilder = makeBuilder({ data: staffList, error: null });
    const claimBuilder = makeBuilder({ data: { id: MEETING_ID }, error: null });
    setupFromSequence([staffBuilder, claimBuilder]);

    await sendStaffPickerToOwner(MEETING_ID);

    const [, , , buttons] = mockSendInteractiveButtonsWith.mock.calls[0] as [
      unknown,
      string,
      string,
      { buttonId: string; buttonText: string }[],
    ];
    expect(buttons.length).toBeGreaterThan(3);
    expect(buttons).toHaveLength(7);
  });
});

// ---------------------------------------------------------------------------
// sendClientSummaryEmail
// ---------------------------------------------------------------------------
describe("sendClientSummaryEmail", () => {
  const MEETING_ID = "meeting-email-1";
  const CLIENT_ID = "client-email-1";

  beforeEach(() => {
    vi.clearAllMocks();
    mockSendOwnerEmail.mockResolvedValue({ id: "gmail-msg-1" });
  });

  it("calls sendOwnerEmail with correct args when client has email + summary_final claimed", async () => {
    const hebrewSummary = "סיכום הפגישה: הלקוח מעוניין בביטוח חיים.";
    const clientEmail = "client@example.com";
    const clientName = "דני לוי";

    const clientBuilder = makeBuilder({
      data: { full_name: clientName, email: clientEmail },
      error: null,
    });
    const claimBuilder = makeBuilder({
      data: { summary_final: hebrewSummary, summary_draft: null },
      error: null,
    });
    setupFromSequence([clientBuilder, claimBuilder]);

    await sendClientSummaryEmail(MEETING_ID, CLIENT_ID);

    expect(mockSendOwnerEmail).toHaveBeenCalledOnce();
    const [to, subject, body] = mockSendOwnerEmail.mock.calls[0] as [string, string, string];
    expect(to).toBe(clientEmail);
    expect(subject).toBe("סיכום הפגישה שלך");
    expect(body).toContain(hebrewSummary);
    expect(body).toContain(clientName);
  });

  it("returns early and does NOT call sendOwnerEmail when client has no email", async () => {
    const clientBuilder = makeBuilder({
      data: { full_name: "ללא מייל", email: null },
      error: null,
    });
    setupFromSequence([clientBuilder]);

    await sendClientSummaryEmail(MEETING_ID, CLIENT_ID);

    expect(mockSendOwnerEmail).not.toHaveBeenCalled();
    expect(mockFromImpl).toHaveBeenCalledTimes(1);
  });

  it("reverts claim when sendOwnerEmail throws", async () => {
    const sendError = new Error("WS token not authorized");
    mockSendOwnerEmail.mockRejectedValue(sendError);

    const clientBuilder = makeBuilder({
      data: { full_name: "Test", email: "err@example.com" },
      error: null,
    });
    const claimBuilder = makeBuilder({
      data: { summary_final: "סיכום", summary_draft: null },
      error: null,
    });
    const revertBuilder = makeBuilder({ data: null, error: null });
    setupFromSequence([clientBuilder, claimBuilder, revertBuilder]);

    await sendClientSummaryEmail(MEETING_ID, CLIENT_ID);

    expect(mockSendOwnerEmail).toHaveBeenCalledOnce();
    expect(mockFromImpl).toHaveBeenCalledTimes(3);
    const revertBuilderUpdate = revertBuilder["update"] as ReturnType<typeof vi.fn>;
    expect(revertBuilderUpdate).toHaveBeenCalledWith({ client_summary_emailed_at: null });
  });

  it("does NOT call sendOwnerEmail when idempotency claim returns null (already sent)", async () => {
    const clientBuilder = makeBuilder({
      data: { full_name: "Test", email: "test@example.com" },
      error: null,
    });
    const claimBuilder = makeBuilder({ data: null, error: null });
    setupFromSequence([clientBuilder, claimBuilder]);

    await sendClientSummaryEmail(MEETING_ID, CLIENT_ID);

    expect(mockSendOwnerEmail).not.toHaveBeenCalled();
  });
});
