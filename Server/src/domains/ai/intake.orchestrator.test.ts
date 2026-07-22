/**
 * Unit tests for the v4.1 intake flow (9-button menu + email slot):
 *  - welcome → menu buttons + scheduled brand image
 *  - menu: free text / image → re-prompt #12; buttons 1-7 → staff email + thanks + endFlow;
 *    callback_didi → notifyOwner + thanks; meeting_didi → meeting_type sub-choice
 *  - meeting_type: either tap saves client_type ('old'/'new') and advances to the email ask
 *  - email: first email-looking token stored lowercased; old → booking link + 24h pause;
 *    new → consent buttons + consent_prompted_at; junk/image/button-tap → re-prompt
 *  - consent: tap-only advance; typed מאשר re-prompts
 *  - id_photo: valid → Drive name from OCR name (phone fallback), full_name upgraded, terminal + pause
 *  - completed + unpaused → fresh menu restart
 *
 * All DB and external I/O is mocked. No live WhatsApp / email / GreenAPI calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockSendInteractiveButtons,
  mockSendMessageWithTyping,
  mockSendFileByUrl,
  mockFromImpl,
  mockMirrorLeadToSheet,
  mockValidateIdPhoto,
  mockFetchRemoteFile,
  mockUploadLeadDocument,
  mockSendStaffLeadEmail,
  mockBuildCallbackAlert,
  mockSendCallbackRequestEmail,
  mockNotifyOwner,
} = vi.hoisted(() => ({
  mockSendInteractiveButtons: vi.fn().mockResolvedValue({ idMessage: "btn-1" }),
  mockSendMessageWithTyping: vi.fn().mockResolvedValue({ idMessage: "txt-1" }),
  mockSendFileByUrl: vi.fn().mockResolvedValue({ idMessage: "file-1" }),
  mockFromImpl: vi.fn(),
  mockMirrorLeadToSheet: vi.fn().mockResolvedValue(undefined),
  mockValidateIdPhoto: vi.fn(),
  mockFetchRemoteFile: vi.fn(),
  mockUploadLeadDocument: vi.fn(),
  mockSendStaffLeadEmail: vi.fn().mockResolvedValue(undefined),
  mockBuildCallbackAlert: vi.fn(() => "📞 CALLBACK ALERT"),
  mockSendCallbackRequestEmail: vi.fn().mockResolvedValue(undefined),
  mockNotifyOwner: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../config/supabase.js", () => ({ supabaseAdmin: { from: mockFromImpl } }));
vi.mock("../../config/env.js", () => ({
  env: {
    GOOGLE_CALENDAR_BOOKING_URL: "https://example.com/book",
    WELCOME_IMAGE_URL: "https://example.com/brand.jpeg",
    BACKEND_URL: "https://example.com",
    NODE_ENV: "test",
  },
}));
vi.mock("../../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../whatsapp/whatsapp.service.js", () => ({
  sendMessageWithTyping: mockSendMessageWithTyping,
  sendInteractiveButtonsWithTyping: mockSendInteractiveButtons,
  sendFileByUrl: mockSendFileByUrl,
}));
vi.mock("./ai.service.js", () => ({ validateIdPhoto: mockValidateIdPhoto }));
vi.mock("../../lib/storage.js", () => ({ fetchRemoteFile: mockFetchRemoteFile }));
vi.mock("../integrations/google/google.drive.js", () => ({ uploadLeadDocument: mockUploadLeadDocument }));
vi.mock("../integrations/google/leads-mirror.service.js", () => ({ mirrorLeadToSheet: mockMirrorLeadToSheet }));
vi.mock("./intake-notify.service.js", () => ({
  sendStaffLeadEmail: mockSendStaffLeadEmail,
  buildCallbackAlert: mockBuildCallbackAlert,
  sendCallbackRequestEmail: mockSendCallbackRequestEmail,
}));
vi.mock("../operations/owner-notify.js", () => ({ notifyOwner: mockNotifyOwner }));

import { handleIntake } from "./intake.orchestrator.js";
import type { MessagePayload } from "../whatsapp/whatsapp.validator.js";

function makeBuilder(result: unknown) {
  const b: Record<string, unknown> = {};
  const chain = [
    "select", "eq", "neq", "is", "not", "in", "gte", "lte", "lt", "gt",
    "order", "limit", "insert", "upsert", "update", "delete",
  ];
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

const textPayload = (text: string): MessagePayload => ({ kind: "text", text });
const buttonPayload = (text: string): MessagePayload => ({ kind: "text", text, isButtonReply: true });
const imagePayload = (): MessagePayload => ({
  kind: "image",
  fileUrl: "https://example.com/img.jpg",
  mimeType: "image/jpeg",
  fileName: "img.jpg",
  caption: undefined,
});

const BOT_ENABLED = { data: { enabled: true }, error: null };
const CONV_ACTIVE = { data: { bot_paused: false, bot_paused_until: null }, error: null };
const clientState = (slot: string, state = "collecting") => ({
  data: { intake_state: state, intake_current_slot: slot },
  error: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mockSendInteractiveButtons.mockResolvedValue({ idMessage: "btn" });
  mockSendMessageWithTyping.mockResolvedValue({ idMessage: "txt" });
  mockSendFileByUrl.mockResolvedValue({ idMessage: "file" });
  mockMirrorLeadToSheet.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// welcome
// ---------------------------------------------------------------------------

describe("welcome slot", () => {
  it("sends the 9-button opening menu", async () => {
    setupFrom([makeBuilder(BOT_ENABLED), makeBuilder(CONV_ACTIVE), makeBuilder(clientState("welcome")), makeBuilder({ data: null, error: null })]);

    const result = await handleIntake("conv1", "client1", "chat1@c.us", textPayload("hi"));

    expect(result.consumed).toBe(true);
    expect(mockSendInteractiveButtons).toHaveBeenCalledOnce();
    const [, body, buttons] = mockSendInteractiveButtons.mock.calls[0] as [string, string, { buttonId: string }[]];
    expect(body).toContain("שקד סוכנות לביטוח");
    expect(buttons).toHaveLength(9);
  });

  it("schedules the brand image as a 2nd bubble", async () => {
    setupFrom([makeBuilder(BOT_ENABLED), makeBuilder(CONV_ACTIVE), makeBuilder(clientState("welcome")), makeBuilder({ data: null, error: null })]);

    await handleIntake("conv1", "client1", "chat1@c.us", textPayload("hi"));
    await vi.runAllTimersAsync();

    expect(mockSendFileByUrl).toHaveBeenCalledOnce();
    expect(mockSendFileByUrl.mock.calls[0]?.[1]).toBe("https://example.com/brand.jpeg");
  });
});

// ---------------------------------------------------------------------------
// menu — re-prompt on non-button input
// ---------------------------------------------------------------------------

describe("menu slot — free-text / image re-prompt", () => {
  it("free text → menu re-prompt #12, slot unchanged", async () => {
    const client = makeBuilder(clientState("menu"));
    setupFrom([makeBuilder(BOT_ENABLED), makeBuilder(CONV_ACTIVE), client, makeBuilder({ data: null, error: null })]);

    const result = await handleIntake("c", "cl", "chat@c.us", textPayload("random words"));

    expect(result.consumed).toBe(true);
    expect(mockSendMessageWithTyping).toHaveBeenCalledOnce();
    expect(mockSendMessageWithTyping.mock.calls[0]?.[1]).toBe("אנא בחר אחת מהאפשרויות בתפריט למעלה");
    expect(mockSendInteractiveButtons).not.toHaveBeenCalled();
    expect(client["update"]).not.toHaveBeenCalled();
  });

  it("image at menu → re-prompt, never crashes on fileUrl payload", async () => {
    setupFrom([makeBuilder(BOT_ENABLED), makeBuilder(CONV_ACTIVE), makeBuilder(clientState("menu")), makeBuilder({ data: null, error: null })]);

    const result = await handleIntake("c", "cl", "chat@c.us", imagePayload());

    expect(result.consumed).toBe(true);
    expect(mockSendMessageWithTyping.mock.calls[0]?.[1]).toBe("אנא בחר אחת מהאפשרויות בתפריט למעלה");
  });
});

// ---------------------------------------------------------------------------
// menu — buttons 1-7 (insurance)
// ---------------------------------------------------------------------------

describe("menu slot — insurance buttons 1-7", () => {
  function setupInquiry() {
    const updateInquiry = makeBuilder({ data: null, error: null });
    const contact = makeBuilder({ data: { full_name: "יעל כהן", phone: "972501234567" }, error: null });
    const persist = makeBuilder({ data: null, error: null });
    const endUpdate = makeBuilder({ data: null, error: null });
    const convPause = makeBuilder({ data: null, error: null });
    setupFrom([
      makeBuilder(BOT_ENABLED),
      makeBuilder(CONV_ACTIVE),
      makeBuilder(clientState("menu")),
      updateInquiry,
      contact,
      persist,
      endUpdate,
      convPause,
    ]);
    return { updateInquiry, endUpdate, convPause };
  }

  it("vehicle → staff email, thanks #3, endFlow (completed + 24h pause)", async () => {
    const { updateInquiry, endUpdate, convPause } = setupInquiry();

    const result = await handleIntake("conv", "client", "chat@c.us", textPayload("vehicle"));

    expect(result.consumed).toBe(true);
    expect((updateInquiry["update"] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({ inquiry_type: "vehicle" });
    expect(mockSendStaffLeadEmail).toHaveBeenCalledOnce();
    expect(mockSendStaffLeadEmail.mock.calls[0]?.[0]).toBe("vehicle");
    expect(mockSendMessageWithTyping.mock.calls[0]?.[1]).toBe("תודה על פנייתך! קיבלנו את הפרטים וניצור איתך קשר בהקדם.");

    expect((endUpdate["update"] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({
      intake_state: "completed",
      intake_current_slot: "done",
      pipeline_stage: "new_lead",
    });
    const pauseArg = (convPause["update"] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      bot_paused: boolean;
      bot_paused_until: string;
    };
    expect(pauseArg.bot_paused).toBe(true);
    const until = new Date(pauseArg.bot_paused_until).getTime();
    const expected = Date.now() + 24 * 60 * 60 * 1000;
    expect(Math.abs(until - expected)).toBeLessThan(5000);
    expect(mockNotifyOwner).not.toHaveBeenCalled();
  });

  it("passes the WA display name to sendStaffLeadEmail", async () => {
    setupInquiry();
    await handleIntake("conv", "client", "chat@c.us", textPayload("home"));
    expect(mockSendStaffLeadEmail.mock.calls[0]?.[1]).toEqual({ phone: "972501234567", waName: "יעל כהן" });
  });

  it.each(["vehicle", "home", "business", "life_health_pension", "travel", "finance", "other"])(
    "button %s → sendStaffLeadEmail called with that id",
    async (id) => {
      setupInquiry();
      await handleIntake("conv", "client", "chat@c.us", textPayload(id));
      expect(mockSendStaffLeadEmail).toHaveBeenCalledOnce();
      expect(mockSendStaffLeadEmail.mock.calls[0]?.[0]).toBe(id);
    },
  );
});

// ---------------------------------------------------------------------------
// menu — button 8 callback
// ---------------------------------------------------------------------------

describe("menu slot — callback_didi (button 8)", () => {
  it("notifies Didi with the 📞 template, thanks #4, NO staff email", async () => {
    const updateInquiry = makeBuilder({ data: null, error: null });
    const contact = makeBuilder({ data: { full_name: "דוד", phone: "972501234567" }, error: null });
    setupFrom([
      makeBuilder(BOT_ENABLED),
      makeBuilder(CONV_ACTIVE),
      makeBuilder(clientState("menu")),
      updateInquiry,
      contact,
      makeBuilder({ data: null, error: null }),
    ]);

    const result = await handleIntake("conv", "client", "chat@c.us", buttonPayload("callback_didi"));

    expect(result.consumed).toBe(true);
    expect((updateInquiry["update"] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({ inquiry_type: "callback" });
    expect(mockBuildCallbackAlert).toHaveBeenCalledOnce();
    expect(mockNotifyOwner).toHaveBeenCalledOnce();
    expect(mockNotifyOwner.mock.calls[0]?.[0]).toBe("📞 CALLBACK ALERT");
    expect(mockSendStaffLeadEmail).not.toHaveBeenCalled();
    expect(mockSendCallbackRequestEmail).toHaveBeenCalledOnce();
    expect(mockSendCallbackRequestEmail.mock.calls[0]?.[0]).toMatchObject({
      phone: "972501234567",
      waName: "דוד",
    });
    expect(mockSendMessageWithTyping.mock.calls[0]?.[1]).toBe("תודה! הפרטים הועברו לדידי והוא יחזור אליך בהקדם.");
  });
});

// ---------------------------------------------------------------------------
// menu — button 9 meeting → meeting_type
// ---------------------------------------------------------------------------

describe("menu slot — meeting_didi (button 9)", () => {
  it("advances to the existing/new sub-choice buttons", async () => {
    const updateInquiry = makeBuilder({ data: null, error: null });
    setupFrom([
      makeBuilder(BOT_ENABLED),
      makeBuilder(CONV_ACTIVE),
      makeBuilder(clientState("menu")),
      updateInquiry, // updateInquiry meeting
      makeBuilder({ data: null, error: null }), // updateSlot
      makeBuilder({ data: null, error: null }), // persist
    ]);

    const result = await handleIntake("conv", "client", "chat@c.us", buttonPayload("meeting_didi"));

    expect(result.consumed).toBe(true);
    expect((updateInquiry["update"] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({
      inquiry_type: "meeting",
      client_type: null,
    });
    expect(mockSendInteractiveButtons).toHaveBeenCalledOnce();
    const [, , buttons] = mockSendInteractiveButtons.mock.calls[0] as [string, string, { buttonId: string }[]];
    expect(buttons.map((b) => b.buttonId)).toEqual(["existing_client", "new_client"]);
  });
});

// ---------------------------------------------------------------------------
// meeting_type
// ---------------------------------------------------------------------------

describe("meeting_type slot", () => {
  it("existing → client_type 'old', advances to email prompt", async () => {
    const updateType = makeBuilder({ data: null, error: null });
    const updateSlot = makeBuilder({ data: null, error: null });
    const persist = makeBuilder({ data: null, error: null });
    setupFrom([
      makeBuilder(BOT_ENABLED),
      makeBuilder(CONV_ACTIVE),
      makeBuilder(clientState("meeting_type")),
      updateType, // update client_type
      updateSlot, // advanceTo email
      persist,    // persist email prompt
    ]);

    const result = await handleIntake("conv", "client", "chat@c.us", buttonPayload("existing_client"));

    expect(result.consumed).toBe(true);
    expect((updateType["update"] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({ client_type: "old" });
    expect((updateSlot["update"] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({ intake_current_slot: "email" });
    const sent = mockSendMessageWithTyping.mock.calls[0]?.[1] as string;
    expect(sent).toBe("מה כתובת המייל שלך?");
    expect(sent).not.toContain("https://example.com/book");
    expect(mockNotifyOwner).not.toHaveBeenCalled();
    expect(mockSendStaffLeadEmail).not.toHaveBeenCalled();
  });

  it("new → client_type 'new', advances to email prompt — NO consent stamp yet", async () => {
    const updateType = makeBuilder({ data: null, error: null });
    const updateSlot = makeBuilder({ data: null, error: null });
    const persist = makeBuilder({ data: null, error: null });
    setupFrom([
      makeBuilder(BOT_ENABLED),
      makeBuilder(CONV_ACTIVE),
      makeBuilder(clientState("meeting_type")),
      updateType,
      updateSlot,
      persist,
    ]);

    const result = await handleIntake("conv", "client", "chat@c.us", buttonPayload("new_client"));

    expect(result.consumed).toBe(true);
    expect((updateType["update"] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({ client_type: "new" });
    expect((updateSlot["update"] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({ intake_current_slot: "email" });
    expect(mockSendMessageWithTyping.mock.calls[0]?.[1]).toBe("מה כתובת המייל שלך?");
    // consent_prompted_at moved to handleEmail — the trailing builder (also the
    // fallback for any extra .from() call) must never see an update here.
    expect(persist["update"]).not.toHaveBeenCalled();
  });

  it("unmatched free text → menu re-prompt, no advance", async () => {
    const client = makeBuilder(clientState("meeting_type"));
    setupFrom([makeBuilder(BOT_ENABLED), makeBuilder(CONV_ACTIVE), client, makeBuilder({ data: null, error: null })]);

    await handleIntake("conv", "client", "chat@c.us", textPayload("שלום"));

    expect(mockSendMessageWithTyping.mock.calls[0]?.[1]).toBe("אנא בחר אחת מהאפשרויות בתפריט למעלה");
    expect(client["update"]).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// email — free-text collection between meeting_type and the branch terminals
// ---------------------------------------------------------------------------

describe("email slot", () => {
  it("valid email + old client → lowercased email stored, booking link + endFlow", async () => {
    const updateEmail = makeBuilder({ data: null, error: null });
    const typeSelect = makeBuilder({ data: { client_type: "old" }, error: null });
    const persist = makeBuilder({ data: null, error: null });
    const endUpdate = makeBuilder({ data: null, error: null });
    const convPause = makeBuilder({ data: null, error: null });
    setupFrom([
      makeBuilder(BOT_ENABLED),
      makeBuilder(CONV_ACTIVE),
      makeBuilder(clientState("email")),
      updateEmail, // update clients.email
      typeSelect,  // select client_type
      persist,     // persist done_existing
      endUpdate,   // endFlow client update
      convPause,   // endFlow conversation pause
    ]);

    const result = await handleIntake(
      "conv",
      "client",
      "chat@c.us",
      textPayload("המייל שלי: John.Doe@Example.COM "),
    );

    expect(result.consumed).toBe(true);
    expect((updateEmail["update"] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toEqual({
      email: "john.doe@example.com",
    });
    const sent = mockSendMessageWithTyping.mock.calls[0]?.[1] as string;
    expect(sent).toContain("לקביעת פגישה");
    expect(sent).toContain("https://example.com/book");
    expect((endUpdate["update"] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({
      intake_state: "completed",
      intake_current_slot: "done",
      pipeline_stage: "meeting_scheduling",
    });
    expect((convPause["update"] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({ bot_paused: true });
  });

  it("valid email + new client → consent buttons + consent_prompted_at stamped", async () => {
    const updateEmail = makeBuilder({ data: null, error: null });
    const typeSelect = makeBuilder({ data: { client_type: "new" }, error: null });
    const updateSlot = makeBuilder({ data: null, error: null });
    const persist = makeBuilder({ data: null, error: null });
    const updateConsent = makeBuilder({ data: null, error: null });
    setupFrom([
      makeBuilder(BOT_ENABLED),
      makeBuilder(CONV_ACTIVE),
      makeBuilder(clientState("email")),
      updateEmail,
      typeSelect,
      updateSlot,    // advanceTo consent
      persist,       // persist consent buttons
      updateConsent, // consent_prompted_at stamp
    ]);

    const result = await handleIntake("conv", "client", "chat@c.us", textPayload("name@example.co.il"));

    expect(result.consumed).toBe(true);
    expect((updateEmail["update"] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toEqual({
      email: "name@example.co.il",
    });
    expect((updateSlot["update"] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({
      intake_current_slot: "consent",
    });
    expect(mockSendInteractiveButtons).toHaveBeenCalledOnce();
    const [, , buttons] = mockSendInteractiveButtons.mock.calls[0] as [string, string, { buttonId: string }[]];
    expect(buttons[0]?.buttonId).toBe("consent_approve");

    const consentArg = (updateConsent["update"] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      consent_prompted_at: string;
      stall_notified_at: null;
    };
    expect(typeof consentArg.consent_prompted_at).toBe("string");
    expect(consentArg.stall_notified_at).toBeNull();
  });

  it("junk text with no email → email re-prompt, no client update", async () => {
    const client = makeBuilder(clientState("email"));
    setupFrom([makeBuilder(BOT_ENABLED), makeBuilder(CONV_ACTIVE), client, makeBuilder({ data: null, error: null })]);

    const result = await handleIntake("conv", "client", "chat@c.us", textPayload("אין לי כרגע"));

    expect(result.consumed).toBe(true);
    expect(mockSendMessageWithTyping.mock.calls[0]?.[1]).toBe(
      "לא זיהינו כתובת מייל תקינה. נא לשלוח כתובת מייל, לדוגמה: name@example.com",
    );
    expect(client["update"]).not.toHaveBeenCalled();
  });

  it("image at email → re-prompt", async () => {
    const client = makeBuilder(clientState("email"));
    setupFrom([makeBuilder(BOT_ENABLED), makeBuilder(CONV_ACTIVE), client, makeBuilder({ data: null, error: null })]);

    await handleIntake("conv", "client", "chat@c.us", imagePayload());

    expect(mockSendMessageWithTyping.mock.calls[0]?.[1]).toBe(
      "לא זיהינו כתובת מייל תקינה. נא לשלוח כתובת מייל, לדוגמה: name@example.com",
    );
    expect(client["update"]).not.toHaveBeenCalled();
  });

  it("stale button tap (isButtonReply) → re-prompt", async () => {
    const client = makeBuilder(clientState("email"));
    setupFrom([makeBuilder(BOT_ENABLED), makeBuilder(CONV_ACTIVE), client, makeBuilder({ data: null, error: null })]);

    await handleIntake("conv", "client", "chat@c.us", buttonPayload("existing_client"));

    expect(mockSendMessageWithTyping.mock.calls[0]?.[1]).toBe(
      "לא זיהינו כתובת מייל תקינה. נא לשלוח כתובת מייל, לדוגמה: name@example.com",
    );
    expect(client["update"]).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// consent — tap-only
// ---------------------------------------------------------------------------

describe("consent slot — tap-only advance", () => {
  it("typed 'מאשר' WITHOUT isButtonReply → re-prompt #8, no advance", async () => {
    const client = makeBuilder(clientState("consent"));
    setupFrom([makeBuilder(BOT_ENABLED), makeBuilder(CONV_ACTIVE), client, makeBuilder({ data: null, error: null })]);

    const result = await handleIntake("conv", "client", "chat@c.us", textPayload("מאשר"));

    expect(result.consumed).toBe(true);
    expect(mockSendMessageWithTyping.mock.calls[0]?.[1]).toBe('כדי להמשיך, יש ללחוץ על כפתור "מאשר"');
    expect(client["update"]).not.toHaveBeenCalled();
    expect(mockSendInteractiveButtons).not.toHaveBeenCalled();
  });

  it("tap by buttonId (isButtonReply) → advances to id_photo prompt #9", async () => {
    const updateSlot = makeBuilder({ data: null, error: null });
    setupFrom([
      makeBuilder(BOT_ENABLED),
      makeBuilder(CONV_ACTIVE),
      makeBuilder(clientState("consent")),
      updateSlot,
      makeBuilder({ data: null, error: null }),
    ]);

    await handleIntake("conv", "client", "chat@c.us", buttonPayload("consent_approve"));

    expect((updateSlot["update"] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({ intake_current_slot: "id_photo" });
    expect(mockSendMessageWithTyping.mock.calls[0]?.[1]).toContain("צילום תעודת הזהות");
  });

  it("tap by Hebrew label 'מאשר' (isButtonReply) → also advances", async () => {
    const updateSlot = makeBuilder({ data: null, error: null });
    setupFrom([
      makeBuilder(BOT_ENABLED),
      makeBuilder(CONV_ACTIVE),
      makeBuilder(clientState("consent")),
      updateSlot,
      makeBuilder({ data: null, error: null }),
    ]);

    await handleIntake("conv", "client", "chat@c.us", buttonPayload("מאשר"));

    expect((updateSlot["update"] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({ intake_current_slot: "id_photo" });
  });
});

// ---------------------------------------------------------------------------
// id_photo
// ---------------------------------------------------------------------------

describe("id_photo slot", () => {
  function setupIdPhoto(contactData: { full_name: string | null; phone: string }) {
    const contact = makeBuilder({ data: contactData, error: null });
    const docInsert = makeBuilder({ data: null, error: null });
    const updatePhoto = makeBuilder({ data: null, error: null });
    const persist = makeBuilder({ data: null, error: null });
    const endUpdate = makeBuilder({ data: null, error: null });
    const convPause = makeBuilder({ data: null, error: null });
    setupFrom([
      makeBuilder(BOT_ENABLED),
      makeBuilder(CONV_ACTIVE),
      makeBuilder(clientState("id_photo")),
      contact,
      docInsert,
      updatePhoto,
      persist,
      endUpdate,
      convPause,
    ]);
    return { updatePhoto, convPause };
  }

  it("valid ID → Drive name from OCR name, full_name upgraded, terminal #11 + pause", async () => {
    mockValidateIdPhoto.mockResolvedValue({ valid: true, hasIdCard: true, hasAppendix: true, idNumber: "123456789", fullName: "משה לוי" });
    mockFetchRemoteFile.mockResolvedValue(Buffer.from("bytes"));
    mockUploadLeadDocument.mockResolvedValue({ fileId: "d1", webViewLink: "https://drive/x" });

    const { updatePhoto, convPause } = setupIdPhoto({ full_name: "old", phone: "972501234567" });

    const result = await handleIntake("conv", "client", "chat@c.us", imagePayload());

    expect(result.consumed).toBe(true);
    // Download-first: one fetch feeds both the OCR (as a data URL) and Drive.
    expect(mockFetchRemoteFile).toHaveBeenCalledOnce();
    expect(mockFetchRemoteFile).toHaveBeenCalledWith("https://example.com/img.jpg");
    expect(mockValidateIdPhoto).toHaveBeenCalledWith(
      `data:image/jpeg;base64,${Buffer.from("bytes").toString("base64")}`,
    );
    expect(mockUploadLeadDocument.mock.calls[0]?.[0]).toMatchObject({ name: "משה לוי - ID" });
    expect((updatePhoto["update"] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({
      id_photo_url: "https://drive/x",
      id_validated: true,
      id_number: "123456789",
      full_name: "משה לוי",
    });
    const sent = mockSendMessageWithTyping.mock.calls[0]?.[1] as string;
    expect(sent).toContain("תודה רבה! קיבלנו את כל הפרטים");
    expect(sent).toContain("https://example.com/book");
    expect((convPause["update"] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({ bot_paused: true });
    expect(mockNotifyOwner).not.toHaveBeenCalled(); // silent completion
  });

  it("valid ID with no OCR name → Drive name falls back to phone digits", async () => {
    mockValidateIdPhoto.mockResolvedValue({ valid: true, hasIdCard: true, hasAppendix: true, idNumber: null, fullName: null });
    mockFetchRemoteFile.mockResolvedValue(Buffer.from("bytes"));
    mockUploadLeadDocument.mockResolvedValue({ fileId: "d1", webViewLink: "https://drive/x" });

    const { updatePhoto } = setupIdPhoto({ full_name: null, phone: "972501234567" });

    await handleIntake("conv", "client", "chat@c.us", imagePayload());

    expect(mockUploadLeadDocument.mock.calls[0]?.[0]).toMatchObject({ name: "972501234567 - ID" });
    // full_name not overwritten when OCR name is null
    expect((updatePhoto["update"] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).not.toHaveProperty("full_name");
  });

  it("invalid ID → generic re-ask, no upload", async () => {
    mockValidateIdPhoto.mockResolvedValue({ valid: false, hasIdCard: true, hasAppendix: false, idNumber: null, fullName: null });
    mockFetchRemoteFile.mockResolvedValue(Buffer.from("bytes"));
    setupFrom([
      makeBuilder(BOT_ENABLED),
      makeBuilder(CONV_ACTIVE),
      makeBuilder(clientState("id_photo")),
      makeBuilder({ data: null, error: null }),
    ]);

    await handleIntake("conv", "client", "chat@c.us", imagePayload());

    const sent = mockSendMessageWithTyping.mock.calls[0]?.[1] as string;
    expect(sent).toContain("הספח");
    expect(sent).toContain("תעודת הזהות");
    expect(mockUploadLeadDocument).not.toHaveBeenCalled();
  });

  it("media download failure → resend request, OCR never runs", async () => {
    mockFetchRemoteFile.mockResolvedValue(null);
    setupFrom([
      makeBuilder(BOT_ENABLED),
      makeBuilder(CONV_ACTIVE),
      makeBuilder(clientState("id_photo")),
      makeBuilder({ data: null, error: null }),
    ]);

    await handleIntake("conv", "client", "chat@c.us", imagePayload());

    expect(mockSendMessageWithTyping.mock.calls[0]?.[1]).toContain("לא הצלחנו לשמור את הקובץ");
    expect(mockValidateIdPhoto).not.toHaveBeenCalled();
    expect(mockUploadLeadDocument).not.toHaveBeenCalled();
  });

  it("non-image at id_photo → resends the id_photo prompt", async () => {
    setupFrom([
      makeBuilder(BOT_ENABLED),
      makeBuilder(CONV_ACTIVE),
      makeBuilder(clientState("id_photo")),
      makeBuilder({ data: null, error: null }),
    ]);

    await handleIntake("conv", "client", "chat@c.us", textPayload("hello"));

    expect(mockSendMessageWithTyping.mock.calls[0]?.[1]).toContain("צילום תעודת הזהות");
    expect(mockValidateIdPhoto).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// completed + unpaused → fresh menu restart
// ---------------------------------------------------------------------------

describe("post-cooldown restart", () => {
  it("completed + unpaused client message → fresh reset → menu re-sent", async () => {
    const reset = makeBuilder({ data: null, error: null });
    setupFrom([
      makeBuilder(BOT_ENABLED),
      makeBuilder(CONV_ACTIVE),
      makeBuilder(clientState("done", "completed")),
      reset,
      makeBuilder({ data: null, error: null }), // advanceTo updateSlot
      makeBuilder({ data: null, error: null }), // persist menu
    ]);

    const result = await handleIntake("conv", "client", "chat@c.us", textPayload("hi again"));

    expect(result.consumed).toBe(true);
    expect((reset["update"] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({
      intake_state: "collecting",
      intake_current_slot: "welcome",
      consent_prompted_at: null,
      stall_notified_at: null,
      intake_completed_at: null,
      inquiry_type: "general",
      client_type: null,
    });
    expect(mockSendInteractiveButtons).toHaveBeenCalledOnce();
    const [, , buttons] = mockSendInteractiveButtons.mock.calls[0] as [string, string, { buttonId: string }[]];
    expect(buttons).toHaveLength(9);
  });
});

// ---------------------------------------------------------------------------
// sendButtonPrompt fallback
// ---------------------------------------------------------------------------

describe("sendButtonPrompt fallback", () => {
  it("falls back to a plain text list when interactive buttons throw", async () => {
    mockSendInteractiveButtons.mockRejectedValueOnce(new Error("buttons unsupported"));
    setupFrom([
      makeBuilder(BOT_ENABLED),
      makeBuilder(CONV_ACTIVE),
      makeBuilder(clientState("welcome")),
      makeBuilder({ data: null, error: null }),
      makeBuilder({ data: null, error: null }),
    ]);

    const result = await handleIntake("conv", "client", "chat@c.us", textPayload("hi"));

    expect(result.consumed).toBe(true);
    const fallback = mockSendMessageWithTyping.mock.calls[0]?.[1] as string;
    expect(fallback).toContain("ביטוח רכב");
    expect(fallback).toContain("מבקש שדידי יחזור אליי");
  });
});

// ---------------------------------------------------------------------------
// gates
// ---------------------------------------------------------------------------

describe("entry gates", () => {
  it("bot disabled → not consumed", async () => {
    setupFrom([makeBuilder({ data: { enabled: false }, error: null })]);
    const result = await handleIntake("conv", "client", "chat@c.us", textPayload("hi"));
    expect(result.consumed).toBe(false);
  });

  it("paused (not expired) → not consumed", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    setupFrom([
      makeBuilder(BOT_ENABLED),
      makeBuilder({ data: { bot_paused: true, bot_paused_until: future }, error: null }),
    ]);
    const result = await handleIntake("conv", "client", "chat@c.us", textPayload("hi"));
    expect(result.consumed).toBe(false);
  });

  it("intake_state 'skipped' → not consumed (operator escape hatch)", async () => {
    setupFrom([
      makeBuilder(BOT_ENABLED),
      makeBuilder(CONV_ACTIVE),
      makeBuilder(clientState("menu", "skipped")),
    ]);
    const result = await handleIntake("conv", "client", "chat@c.us", textPayload("hi"));
    expect(result.consumed).toBe(false);
  });
});
