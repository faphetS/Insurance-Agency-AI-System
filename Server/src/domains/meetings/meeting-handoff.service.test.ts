import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockClixSendText, mockFromImpl } = vi.hoisted(() => {
  const mockClixSendText = vi.fn();
  const mockFromImpl = vi.fn();
  return { mockClixSendText, mockFromImpl };
});

vi.mock("../whatsapp/whatsapp.clix-send.js", () => ({
  clixSendText: mockClixSendText,
  clixSendCreds: vi.fn().mockReturnValue({ url: "http://clix", token: "tok" }),
}));

vi.mock("../../config/supabase.js", () => ({
  supabaseAdmin: { from: mockFromImpl },
}));

vi.mock("../../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../whatsapp/whatsapp.util.js", () => ({
  toChatId: (raw: string | null | undefined): string | null => {
    if (!raw) return null;
    const digits = raw.replace(/\D/g, "");
    if (digits.length < 10) return null;
    return `${digits}@c.us`;
  },
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

describe("notifyStaffHandoff — minimal Clix body", () => {
  const MEETING_ID = "meeting-handoff-1";
  const STAFF_PHONE = "972501234567";

  beforeEach(() => {
    vi.clearAllMocks();
    mockClixSendText.mockResolvedValue(undefined);
  });

  it("sends a message containing the assignment line and the summary", async () => {
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
      data: { full_name: "דנה לוי", phone: STAFF_PHONE },
      error: null,
    });

    setupFromSequence([meetingBuilder, clientBuilder, staffBuilder]);

    await notifyStaffHandoff(MEETING_ID);

    expect(mockClixSendText).toHaveBeenCalledOnce();
    const [chatId, body] = mockClixSendText.mock.calls[0] as [string, string];

    expect(chatId).toBe(`${STAFF_PHONE}@c.us`);
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
      data: { full_name: "משה לוי", phone: STAFF_PHONE },
      error: null,
    });

    setupFromSequence([meetingBuilder, clientBuilder, staffBuilder]);

    await notifyStaffHandoff(MEETING_ID);

    expect(mockClixSendText).toHaveBeenCalledOnce();
    const [, body] = mockClixSendText.mock.calls[0] as [string, string];

    expect(body).toContain("דידי הקצה אותך");
    expect(body).not.toContain("📝 סיכום הפגישה");
  });

  it("does NOT contain phone, ID, inquiry type, or document lines", async () => {
    const summaryText = "סיכום הפגישה עם הלקוח.";

    const meetingBuilder = makeBuilder({
      data: { id: MEETING_ID, client_id: "client-3", summary_final: summaryText, summary_draft: null },
      error: null,
    });
    const clientBuilder = makeBuilder({
      data: { full_name: "דוד כץ", assigned_to: null, assigned_handler_id: "staff-3" },
      error: null,
    });
    const staffBuilder = makeBuilder({
      data: { full_name: "שרה גולן", phone: STAFF_PHONE },
      error: null,
    });

    setupFromSequence([meetingBuilder, clientBuilder, staffBuilder]);

    await notifyStaffHandoff(MEETING_ID);

    const [, body] = mockClixSendText.mock.calls[0] as [string, string];

    expect(body).not.toContain("טלפון:");
    expect(body).not.toContain('ת"ז:');
    expect(body).not.toContain("סוג הפנייה:");
    expect(body).not.toContain("מסמכים");
    expect(body).not.toContain("ייפוי כוח");
  });

  it("returns early without sending when no meeting found", async () => {
    const meetingBuilder = makeBuilder({ data: null, error: null });
    setupFromSequence([meetingBuilder]);

    await notifyStaffHandoff(MEETING_ID);

    expect(mockClixSendText).not.toHaveBeenCalled();
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

    expect(mockClixSendText).not.toHaveBeenCalled();
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
      data: { full_name: "אהרן גורן", phone: STAFF_PHONE },
      error: null,
    });

    setupFromSequence([meetingBuilder, clientBuilder, staffBuilder]);

    await notifyStaffHandoff(MEETING_ID);

    const [, body] = mockClixSendText.mock.calls[0] as [string, string];
    expect(body).toContain(draftSummary);
  });
});
