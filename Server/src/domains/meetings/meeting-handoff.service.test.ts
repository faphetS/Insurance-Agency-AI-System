import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSendMessage, mockSendOwnerEmail, mockFromImpl, mockEnv } = vi.hoisted(() => {
  const mockSendMessage = vi.fn();
  const mockSendOwnerEmail = vi.fn();
  const mockFromImpl = vi.fn();
  const mockEnv = { STAFF_EMAIL_NOTIFY_MODE: "send" as "send" | "log" };
  return { mockSendMessage, mockSendOwnerEmail, mockFromImpl, mockEnv };
});

vi.mock("../whatsapp/whatsapp.service.js", () => ({
  sendMessage: mockSendMessage,
}));

vi.mock("../../config/supabase.js", () => ({
  supabaseAdmin: { from: mockFromImpl },
}));

vi.mock("../../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../integrations/google/google.gmail.js", () => ({
  sendOwnerEmail: mockSendOwnerEmail,
}));

vi.mock("../../config/env.js", () => ({
  env: mockEnv,
}));

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

import { notifyStaffHandoff } from "./meeting-handoff.service.js";

describe("notifyStaffHandoff — email handoff", () => {
  const MEETING_ID = "meeting-handoff-1";
  const STAFF_EMAIL = "dana@shaked-ins.com";

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.STAFF_EMAIL_NOTIFY_MODE = "send";
    mockSendOwnerEmail.mockResolvedValue({ id: "msg-1" });
    mockSendMessage.mockResolvedValue({ idMessage: "msg-wa" });
  });

  it("sends an email containing the assignment line and the summary", async () => {
    const summaryText = "הלקוח מעוניין בביטוח חיים, דרושה בדיקה נוספת.";

    const meetingBuilder = makeBuilder({
      data: { id: MEETING_ID, client_id: "client-1", summary_final: summaryText, summary_draft: null },
      error: null,
    });
    const clientBuilder = makeBuilder({
      data: { full_name: "יוסי כהן", assigned_to: null, assigned_handler_id: "staff-1" },
      error: null,
    });
    const staffBuilder = makeBuilder({
      data: { full_name: "דנה לוי", email: STAFF_EMAIL },
      error: null,
    });

    setupFromSequence([meetingBuilder, clientBuilder, staffBuilder]);

    await notifyStaffHandoff(MEETING_ID);

    expect(mockSendOwnerEmail).toHaveBeenCalledOnce();
    const [to, subject, body] = mockSendOwnerEmail.mock.calls[0] as [string, string, string];

    expect(to).toBe(STAFF_EMAIL);
    expect(subject).toContain("יוסי כהן");
    expect(body).toContain("דידי הקצה אותך");
    expect(body).toContain("יוסי כהן");
    expect(body).toContain(summaryText);
    expect(body).toContain("📝 סיכום הפגישה");
  });

  it("omits the summary header when summary is empty", async () => {
    const meetingBuilder = makeBuilder({
      data: { id: MEETING_ID, client_id: "client-2", summary_final: null, summary_draft: null },
      error: null,
    });
    const clientBuilder = makeBuilder({
      data: { full_name: "רחל אברהם", assigned_to: null, assigned_handler_id: "staff-2" },
      error: null,
    });
    const staffBuilder = makeBuilder({
      data: { full_name: "משה לוי", email: STAFF_EMAIL },
      error: null,
    });

    setupFromSequence([meetingBuilder, clientBuilder, staffBuilder]);

    await notifyStaffHandoff(MEETING_ID);

    expect(mockSendOwnerEmail).toHaveBeenCalledOnce();
    const [, , body] = mockSendOwnerEmail.mock.calls[0] as [string, string, string];

    expect(body).toContain("דידי הקצה אותך");
    expect(body).not.toContain("📝 סיכום הפגישה");
  });

  it("returns early without sending when no meeting found", async () => {
    const meetingBuilder = makeBuilder({ data: null, error: null });
    setupFromSequence([meetingBuilder]);

    await notifyStaffHandoff(MEETING_ID);

    expect(mockSendOwnerEmail).not.toHaveBeenCalled();
  });

  it("returns early without sending when client has no assigned staff", async () => {
    const meetingBuilder = makeBuilder({
      data: { id: MEETING_ID, client_id: "client-5", summary_final: null, summary_draft: null },
      error: null,
    });
    const clientBuilder = makeBuilder({
      data: { full_name: "ללא שם", assigned_to: null, assigned_handler_id: null },
      error: null,
    });

    setupFromSequence([meetingBuilder, clientBuilder]);

    await notifyStaffHandoff(MEETING_ID);

    expect(mockSendOwnerEmail).not.toHaveBeenCalled();
  });

  it("falls back to summary_draft when summary_final is null", async () => {
    const draftSummary = "טיוטת סיכום בלבד.";

    const meetingBuilder = makeBuilder({
      data: { id: MEETING_ID, client_id: "client-6", summary_final: null, summary_draft: draftSummary },
      error: null,
    });
    const clientBuilder = makeBuilder({
      data: { full_name: "אסתר מזרחי", assigned_to: null, assigned_handler_id: "staff-6" },
      error: null,
    });
    const staffBuilder = makeBuilder({
      data: { full_name: "אהרן גורן", email: STAFF_EMAIL },
      error: null,
    });

    setupFromSequence([meetingBuilder, clientBuilder, staffBuilder]);

    await notifyStaffHandoff(MEETING_ID);

    const [, , body] = mockSendOwnerEmail.mock.calls[0] as [string, string, string];
    expect(body).toContain(draftSummary);
  });

  it("does NOT send email in log mode (dry-run)", async () => {
    mockEnv.STAFF_EMAIL_NOTIFY_MODE = "log";

    const meetingBuilder = makeBuilder({
      data: { id: MEETING_ID, client_id: "client-7", summary_final: "סיכום.", summary_draft: null },
      error: null,
    });
    const clientBuilder = makeBuilder({
      data: { full_name: "אורי שלם", assigned_to: null, assigned_handler_id: "staff-7" },
      error: null,
    });
    const staffBuilder = makeBuilder({
      data: { full_name: "נועה ברק", email: STAFF_EMAIL },
      error: null,
    });

    setupFromSequence([meetingBuilder, clientBuilder, staffBuilder]);

    await notifyStaffHandoff(MEETING_ID);

    expect(mockSendOwnerEmail).not.toHaveBeenCalled();
  });
});
