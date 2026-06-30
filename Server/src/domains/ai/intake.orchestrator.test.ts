/**
 * Unit tests for the v3 intake flow:
 *  - handleClientType: captures client_type ('new'/'old'), advances to inquiry_type
 *  - handleInquiryType: old → issue, new → full_name; fires dept notify fire-and-forget
 *  - handleIssue: stores issue_description, mirrors, advances to action_choice
 *  - handleActionChoice: move_to_rep → rep_ack + finalize (no meeting); schedule_meeting → finalize (meeting)
 *  - sendButtonPrompt: fallback to plain text on failure
 *
 * All DB and external I/O is mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — vi.hoisted so factories can reference them before module init
// ---------------------------------------------------------------------------

const {
  mockSendInteractiveButtons,
  mockSendMessageWithTyping,
  mockFromImpl,
  mockNotifyDept,
  mockMirrorLeadToSheet,
} = vi.hoisted(() => ({
  mockSendInteractiveButtons: vi.fn().mockResolvedValue({ idMessage: "btn-1" }),
  mockSendMessageWithTyping: vi.fn().mockResolvedValue({ idMessage: "txt-1" }),
  mockFromImpl: vi.fn(),
  mockNotifyDept: vi.fn().mockResolvedValue(undefined),
  mockMirrorLeadToSheet: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../config/supabase.js", () => ({
  supabaseAdmin: { from: mockFromImpl },
}));

vi.mock("../../config/env.js", () => ({
  env: {
    GOOGLE_CALENDAR_BOOKING_URL: "https://example.com/book",
    NODE_ENV: "test",
  },
}));

vi.mock("../../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../whatsapp/whatsapp.service.js", () => ({
  sendMessageWithTyping: mockSendMessageWithTyping,
  sendInteractiveButtonsWithTyping: mockSendInteractiveButtons,
}));

vi.mock("./ai.service.js", () => ({
  classifyIntakeResponse: vi.fn(),
  validateIdPhoto: vi.fn(),
  classifyComplexity: vi.fn(),
}));

vi.mock("../../lib/storage.js", () => ({ fetchRemoteFile: vi.fn() }));
vi.mock("../integrations/google/google.drive.js", () => ({ uploadLeadDocument: vi.fn() }));
vi.mock("../integrations/google/leads-mirror.service.js", () => ({ mirrorLeadToSheet: mockMirrorLeadToSheet }));
vi.mock("../whatsapp/department-routing.js", () => ({ notifyDepartmentForInquiry: mockNotifyDept }));

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

import { handleIntake } from "./intake.orchestrator.js";
import type { MessagePayload } from "../whatsapp/whatsapp.validator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBuilder(result: unknown) {
  const b: Record<string, unknown> = {};
  const chainMethods = [
    "select", "eq", "neq", "is", "not", "in", "gte", "lte", "lt", "gt",
    "order", "limit", "insert", "upsert", "update", "delete",
  ];
  for (const m of chainMethods) {
    b[m] = vi.fn().mockReturnValue(b);
  }
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
const imagePayload = (): MessagePayload => ({
  kind: "image",
  fileUrl: "https://example.com/img.jpg",
  mimeType: "image/jpeg",
  fileName: "img.jpg",
  caption: undefined,
});

const BOT_ENABLED = { data: { enabled: true }, error: null };
const CONV_ACTIVE = { data: { bot_paused: false, bot_paused_until: null }, error: null };

// ---------------------------------------------------------------------------
// handleClientType — captures client_type and advances to inquiry_type
// ---------------------------------------------------------------------------

describe("handleClientType — client_type mapping and advances to inquiry_type", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendInteractiveButtons.mockResolvedValue({ idMessage: "btn-inquiry" });
    mockSendMessageWithTyping.mockResolvedValue({ idMessage: "txt-inquiry" });
  });

  function setupClientTypeSlot() {
    const botSettings = makeBuilder(BOT_ENABLED);
    const conv = makeBuilder(CONV_ACTIVE);
    const client = makeBuilder({ data: { intake_state: "collecting", intake_current_slot: "client_type" }, error: null });
    const updateClientType = makeBuilder({ data: null, error: null });
    const updateSlot = makeBuilder({ data: null, error: null });
    const persistMsg = makeBuilder({ data: null, error: null });
    setupFrom([botSettings, conv, client, updateClientType, updateSlot, persistMsg]);
    return { updateClientType };
  }

  it("id 'old_client' → client_type 'old'", async () => {
    const { updateClientType } = setupClientTypeSlot();
    await handleIntake("conv1", "client1", "chat1@c.us", textPayload("old_client"));
    const updateFn = updateClientType["update"] as ReturnType<typeof vi.fn>;
    expect(updateFn).toHaveBeenCalledOnce();
    expect(updateFn.mock.calls[0]?.[0]).toMatchObject({ client_type: "old" });
  });

  it("id 'new_client' → client_type 'new'", async () => {
    const { updateClientType } = setupClientTypeSlot();
    await handleIntake("conv1", "client1", "chat1@c.us", textPayload("new_client"));
    const updateFn = updateClientType["update"] as ReturnType<typeof vi.fn>;
    expect(updateFn).toHaveBeenCalledOnce();
    expect(updateFn.mock.calls[0]?.[0]).toMatchObject({ client_type: "new" });
  });

  it("Hebrew label 'אני לקוח/ה קיים/ת' (contains קיים) → client_type 'old'", async () => {
    const { updateClientType } = setupClientTypeSlot();
    await handleIntake("conv1", "client1", "chat1@c.us", textPayload("אני לקוח/ה קיים/ת"));
    const updateFn = updateClientType["update"] as ReturnType<typeof vi.fn>;
    expect(updateFn.mock.calls[0]?.[0]).toMatchObject({ client_type: "old" });
  });

  it("advances to inquiry_type (sends interactive buttons)", async () => {
    setupClientTypeSlot();
    const result = await handleIntake("conv1", "client1", "chat1@c.us", textPayload("old_client"));
    expect(result.consumed).toBe(true);
    expect(mockSendInteractiveButtons).toHaveBeenCalledOnce();
    const call = mockSendInteractiveButtons.mock.calls[0];
    expect(call?.[1]).toContain("נושא");
  });

  it("unrecognised text → defaults to 'new'", async () => {
    const { updateClientType } = setupClientTypeSlot();
    await handleIntake("conv1", "client1", "chat1@c.us", textPayload("something else"));
    const updateFn = updateClientType["update"] as ReturnType<typeof vi.fn>;
    expect(updateFn.mock.calls[0]?.[0]).toMatchObject({ client_type: "new" });
  });
});

// ---------------------------------------------------------------------------
// handleInquiryType — branches old→issue, new→full_name; fires dept notify
// ---------------------------------------------------------------------------

describe("handleInquiryType — old→issue, new→full_name, dept notify fire-and-forget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendInteractiveButtons.mockResolvedValue({ idMessage: "btn-x" });
    mockSendMessageWithTyping.mockResolvedValue({ idMessage: "txt-x" });
    mockNotifyDept.mockResolvedValue(undefined);
    mockMirrorLeadToSheet.mockResolvedValue(undefined);
  });

  function setupInquirySlot(clientType: "new" | "old") {
    const botSettings = makeBuilder(BOT_ENABLED);
    const conv = makeBuilder(CONV_ACTIVE);
    const client = makeBuilder({ data: { intake_state: "collecting", intake_current_slot: "inquiry_type" }, error: null });
    const updateInquiry = makeBuilder({ data: null, error: null });
    // lookup for client_type + phone
    const clientLookup = makeBuilder({ data: { client_type: clientType, phone: "972501234567" }, error: null });
    const updateSlot = makeBuilder({ data: null, error: null });
    const persistMsg = makeBuilder({ data: null, error: null });
    setupFrom([botSettings, conv, client, updateInquiry, clientLookup, updateSlot, persistMsg]);
    return { updateInquiry };
  }

  it("new client tap 'vehicle' → stores inquiry_type, advances to full_name", async () => {
    const { updateInquiry } = setupInquirySlot("new");
    const result = await handleIntake("conv5", "client5", "chat5@c.us", textPayload("vehicle"));
    expect(result.consumed).toBe(true);
    const updateFn = updateInquiry["update"] as ReturnType<typeof vi.fn>;
    expect(updateFn).toHaveBeenCalledOnce();
    expect(updateFn.mock.calls[0]?.[0]).toMatchObject({ inquiry_type: "vehicle" });
    expect(mockSendMessageWithTyping).toHaveBeenCalledOnce();
    const sentText = mockSendMessageWithTyping.mock.calls[0]?.[1] as string;
    expect(sentText).toContain("שם");
  });

  it("old client tap 'home' → advances to issue (text prompt)", async () => {
    setupInquirySlot("old");
    const result = await handleIntake("conv6", "client6", "chat6@c.us", textPayload("home"));
    expect(result.consumed).toBe(true);
    expect(mockSendMessageWithTyping).toHaveBeenCalledOnce();
    const sentText = mockSendMessageWithTyping.mock.calls[0]?.[1] as string;
    expect(sentText).toContain("בעיה");
    expect(mockSendInteractiveButtons).not.toHaveBeenCalled();
  });

  it("fires dept notify fire-and-forget", async () => {
    setupInquirySlot("new");
    await handleIntake("conv7", "client7", "chat7@c.us", textPayload("vehicle"));
    expect(mockNotifyDept).toHaveBeenCalledOnce();
    expect(mockNotifyDept.mock.calls[0]?.[0]).toBe("vehicle");
  });

  it("unmatched text → re-sends buttons, no advance", async () => {
    const botSettings = makeBuilder(BOT_ENABLED);
    const conv = makeBuilder(CONV_ACTIVE);
    const client = makeBuilder({ data: { intake_state: "collecting", intake_current_slot: "inquiry_type" }, error: null });
    const persistMsg = makeBuilder({ data: null, error: null });
    setupFrom([botSettings, conv, client, persistMsg]);

    const result = await handleIntake("conv5", "client5", "chat5@c.us", textPayload("random words"));
    expect(result.consumed).toBe(true);
    expect(mockSendInteractiveButtons).toHaveBeenCalledOnce();
    expect(mockSendMessageWithTyping).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleIssue — stores issue_description, mirrors, advances to action_choice
// ---------------------------------------------------------------------------

describe("handleIssue — stores text, mirrors, advances to action_choice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendInteractiveButtons.mockResolvedValue({ idMessage: "btn-ac" });
    mockSendMessageWithTyping.mockResolvedValue({ idMessage: "txt-ac" });
    mockMirrorLeadToSheet.mockResolvedValue(undefined);
  });

  function setupIssueSlot() {
    const botSettings = makeBuilder(BOT_ENABLED);
    const conv = makeBuilder(CONV_ACTIVE);
    const client = makeBuilder({ data: { intake_state: "collecting", intake_current_slot: "issue" }, error: null });
    const updateIssue = makeBuilder({ data: null, error: null });
    const updateSlot = makeBuilder({ data: null, error: null });
    const persistMsg = makeBuilder({ data: null, error: null });
    setupFrom([botSettings, conv, client, updateIssue, updateSlot, persistMsg]);
    return { updateIssue };
  }

  it("valid text → stores issue_description and advances to action_choice", async () => {
    const { updateIssue } = setupIssueSlot();
    const result = await handleIntake("conv-i", "client-i", "chat-i@c.us", textPayload("הפוליסה שלי פגה"));
    expect(result.consumed).toBe(true);
    const updateFn = updateIssue["update"] as ReturnType<typeof vi.fn>;
    expect(updateFn).toHaveBeenCalledOnce();
    expect(updateFn.mock.calls[0]?.[0]).toMatchObject({ issue_description: "הפוליסה שלי פגה" });
    expect(mockSendInteractiveButtons).toHaveBeenCalledOnce();
    const call = mockSendInteractiveButtons.mock.calls[0];
    expect(call?.[1]).toContain("תרצה/י");
  });

  it("empty text → re-sends issue prompt, no update", async () => {
    const botSettings = makeBuilder(BOT_ENABLED);
    const conv = makeBuilder(CONV_ACTIVE);
    const client = makeBuilder({ data: { intake_state: "collecting", intake_current_slot: "issue" }, error: null });
    const persistMsg = makeBuilder({ data: null, error: null });
    setupFrom([botSettings, conv, client, persistMsg]);

    const result = await handleIntake("conv-i2", "client-i2", "chat-i2@c.us", textPayload("  "));
    expect(result.consumed).toBe(true);
    expect(mockSendMessageWithTyping).toHaveBeenCalledOnce();
    const sentText = mockSendMessageWithTyping.mock.calls[0]?.[1] as string;
    expect(sentText).toContain("בעיה");
    expect(mockSendInteractiveButtons).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleActionChoice — move_to_rep sends ack + no meeting; schedule_meeting → booking
// ---------------------------------------------------------------------------

describe("handleActionChoice — move_to_rep finalizes without meeting; schedule_meeting finalizes with meeting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendMessageWithTyping.mockResolvedValue({ idMessage: "txt-ac" });
    mockSendInteractiveButtons.mockResolvedValue({ idMessage: "btn-ac" });
    mockMirrorLeadToSheet.mockResolvedValue(undefined);
  });

  function setupActionChoiceSlot() {
    const botSettings = makeBuilder(BOT_ENABLED);
    const conv = makeBuilder(CONV_ACTIVE);
    const client = makeBuilder({ data: { intake_state: "collecting", intake_current_slot: "action_choice" }, error: null });
    return { botSettings, conv, client };
  }

  it("move_to_rep → sends rep_ack text, finalizes (no meeting insert), bot paused", async () => {
    const { botSettings, conv, client } = setupActionChoiceSlot();
    const persistRepAck = makeBuilder({ data: null, error: null });
    const finalizeUpdate = makeBuilder({ data: null, error: null });
    const convPause = makeBuilder({ data: null, error: null });
    setupFrom([botSettings, conv, client, persistRepAck, finalizeUpdate, convPause]);

    const result = await handleIntake("conv-ac", "client-ac", "chat-ac@c.us", textPayload("move_to_rep"));
    expect(result.consumed).toBe(true);
    expect(mockSendMessageWithTyping).toHaveBeenCalledOnce();
    const sentText = mockSendMessageWithTyping.mock.calls[0]?.[1] as string;
    expect(sentText).toContain("נציג");

    const convPauseFn = convPause["update"] as ReturnType<typeof vi.fn>;
    expect(convPauseFn).toHaveBeenCalledWith({ bot_paused: true });

    expect(mockSendInteractiveButtons).not.toHaveBeenCalled();
  });

  it("move_to_rep via Hebrew label → same result", async () => {
    const { botSettings, conv, client } = setupActionChoiceSlot();
    const persistRepAck = makeBuilder({ data: null, error: null });
    const finalizeUpdate = makeBuilder({ data: null, error: null });
    const convPause = makeBuilder({ data: null, error: null });
    setupFrom([botSettings, conv, client, persistRepAck, finalizeUpdate, convPause]);

    const result = await handleIntake("conv-ac2", "client-ac2", "chat-ac2@c.us", textPayload("מעבר לנציג/ה"));
    expect(result.consumed).toBe(true);
    const sentText = mockSendMessageWithTyping.mock.calls[0]?.[1] as string;
    expect(sentText).toContain("נציג");
  });

  it("move_to_rep → does NOT insert a meetings row", async () => {
    const { botSettings, conv, client } = setupActionChoiceSlot();
    const persistRepAck = makeBuilder({ data: null, error: null });
    const finalizeUpdate = makeBuilder({ data: null, error: null });
    const convPause = makeBuilder({ data: null, error: null });
    setupFrom([botSettings, conv, client, persistRepAck, finalizeUpdate, convPause]);

    await handleIntake("conv-ac3", "client-ac3", "chat-ac3@c.us", textPayload("move_to_rep"));

    const allFromCalls = mockFromImpl.mock.calls.map((c: unknown[]) => c[0]);
    expect(allFromCalls).not.toContain("meetings");
  });

  it("schedule_meeting → calls finalize path with booking link and meeting insert", async () => {
    const { botSettings, conv, client } = setupActionChoiceSlot();
    const updateSlot = makeBuilder({ data: null, error: null });
    const clientForFinalize = makeBuilder({ data: { inquiry_type: "home", poa_doc_url: null, email: null, client_type: "old" }, error: null });
    const finalizeUpdate = makeBuilder({ data: null, error: null });
    const meetingsInsert = makeBuilder({ data: null, error: null });
    const persistDone = makeBuilder({ data: null, error: null });
    const convPause = makeBuilder({ data: null, error: null });
    setupFrom([botSettings, conv, client, updateSlot, clientForFinalize, finalizeUpdate, meetingsInsert, persistDone, convPause]);

    const result = await handleIntake("conv-sm", "client-sm", "chat-sm@c.us", textPayload("schedule_meeting"));
    expect(result.consumed).toBe(true);

    const allFromCalls = mockFromImpl.mock.calls.map((c: unknown[]) => c[0]);
    expect(allFromCalls).toContain("meetings");

    expect(mockSendMessageWithTyping).toHaveBeenCalledOnce();
    const sentText = mockSendMessageWithTyping.mock.calls[0]?.[1] as string;
    expect(sentText).toContain("https://example.com/book");
  });

  it("Hebrew label 'קביעת פגישה' → same schedule_meeting finalize path (meeting inserted)", async () => {
    const { botSettings, conv, client } = setupActionChoiceSlot();
    const updateSlot = makeBuilder({ data: null, error: null });
    const clientForFinalize = makeBuilder({ data: { inquiry_type: "home", poa_doc_url: null, email: null, client_type: "old" }, error: null });
    const finalizeUpdate = makeBuilder({ data: null, error: null });
    const meetingsInsert = makeBuilder({ data: null, error: null });
    const persistDone = makeBuilder({ data: null, error: null });
    const convPause = makeBuilder({ data: null, error: null });
    setupFrom([botSettings, conv, client, updateSlot, clientForFinalize, finalizeUpdate, meetingsInsert, persistDone, convPause]);

    const result = await handleIntake("conv-he-sm", "client-he-sm", "chat-he-sm@c.us", textPayload("קביעת פגישה"));
    expect(result.consumed).toBe(true);

    const allFromCalls = mockFromImpl.mock.calls.map((c: unknown[]) => c[0]);
    expect(allFromCalls).toContain("meetings");

    expect(mockSendMessageWithTyping).toHaveBeenCalledOnce();
    const sentText = mockSendMessageWithTyping.mock.calls[0]?.[1] as string;
    expect(sentText).toContain("https://example.com/book");
  });

  it("unmatched button text → re-sends action_choice buttons", async () => {
    const { botSettings, conv, client } = setupActionChoiceSlot();
    const persistReprompt = makeBuilder({ data: null, error: null });
    setupFrom([botSettings, conv, client, persistReprompt]);

    const result = await handleIntake("conv-ac4", "client-ac4", "chat-ac4@c.us", textPayload("something else"));
    expect(result.consumed).toBe(true);
    expect(mockSendInteractiveButtons).toHaveBeenCalledOnce();
    expect(mockSendMessageWithTyping).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// sendButtonPrompt — fallback to plain text on button send failure
// ---------------------------------------------------------------------------

describe("sendButtonPrompt — fallback to plain text on button send failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendMessageWithTyping.mockResolvedValue({ idMessage: "fallback-txt" });
  });

  it("client_type: falls back to plain text list when interactive buttons throw", async () => {
    mockSendInteractiveButtons.mockRejectedValueOnce(new Error("buttons unsupported"));

    const botSettings = makeBuilder(BOT_ENABLED);
    const conv = makeBuilder(CONV_ACTIVE);
    const client = makeBuilder({ data: { intake_state: "collecting", intake_current_slot: "welcome" }, error: null });
    const updateSlot = makeBuilder({ data: null, error: null });
    const persistMsg = makeBuilder({ data: null, error: null });
    setupFrom([botSettings, conv, client, updateSlot, persistMsg]);

    const result = await handleIntake("conv3", "client3", "chat3@c.us", textPayload("hi"));
    expect(result.consumed).toBe(true);
    expect(mockSendMessageWithTyping).toHaveBeenCalledOnce();
    const fallbackText = mockSendMessageWithTyping.mock.calls[0]?.[1] as string;
    expect(fallbackText).toContain("אני לקוח/ה קיים/ת");
    expect(fallbackText).toContain("מתעניין");
  });

  it("inquiry_type: falls back to plain text list when interactive buttons throw", async () => {
    mockSendInteractiveButtons.mockRejectedValueOnce(new Error("buttons unsupported"));

    const botSettings = makeBuilder(BOT_ENABLED);
    const conv = makeBuilder(CONV_ACTIVE);
    const client = makeBuilder({ data: { intake_state: "collecting", intake_current_slot: "client_type" }, error: null });
    const updateClientType = makeBuilder({ data: null, error: null });
    const updateSlot = makeBuilder({ data: null, error: null });
    const persistMsg = makeBuilder({ data: null, error: null });
    setupFrom([botSettings, conv, client, updateClientType, updateSlot, persistMsg]);

    const result = await handleIntake("conv4", "client4", "chat4@c.us", textPayload("old_client"));
    expect(result.consumed).toBe(true);
    expect(mockSendMessageWithTyping).toHaveBeenCalledOnce();
    const fallbackText = mockSendMessageWithTyping.mock.calls[0]?.[1] as string;
    expect(fallbackText).toContain("ביטוח רכב");
  });
});

// ---------------------------------------------------------------------------
// handleInquiryType — 7-button strict match; unmatched always re-prompts
// ---------------------------------------------------------------------------

describe("handleInquiryType — strict button match, re-prompt on no match", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendInteractiveButtons.mockResolvedValue({ idMessage: "btn-inquiry" });
    mockSendMessageWithTyping.mockResolvedValue({ idMessage: "txt-inquiry" });
    mockNotifyDept.mockResolvedValue(undefined);
    mockMirrorLeadToSheet.mockResolvedValue(undefined);
  });

  function setupInquirySlot() {
    const botSettings = makeBuilder(BOT_ENABLED);
    const conv = makeBuilder(CONV_ACTIVE);
    const client = makeBuilder({ data: { intake_state: "collecting", intake_current_slot: "inquiry_type" }, error: null });
    const updateInquiry = makeBuilder({ data: null, error: null });
    const clientLookup = makeBuilder({ data: { client_type: "new", phone: "972501234567" }, error: null });
    const updateSlot = makeBuilder({ data: null, error: null });
    const persistMsg = makeBuilder({ data: null, error: null });
    setupFrom([botSettings, conv, client, updateInquiry, clientLookup, updateSlot, persistMsg]);
    return { updateInquiry };
  }

  it("tap by label 'ביטוח רכב' → stored as 'vehicle'", async () => {
    const { updateInquiry } = setupInquirySlot();
    await handleIntake("conv5", "client5", "chat5@c.us", textPayload("ביטוח רכב"));
    const updateFn = updateInquiry["update"] as ReturnType<typeof vi.fn>;
    expect(updateFn).toHaveBeenCalledOnce();
    expect(updateFn.mock.calls[0]?.[0]).toMatchObject({ inquiry_type: "vehicle" });
  });

  it("tap by id 'finance' → stored as 'finance'", async () => {
    const { updateInquiry } = setupInquirySlot();
    await handleIntake("conv5", "client5", "chat5@c.us", textPayload("finance"));
    const updateFn = updateInquiry["update"] as ReturnType<typeof vi.fn>;
    expect(updateFn).toHaveBeenCalledOnce();
    expect(updateFn.mock.calls[0]?.[0]).toMatchObject({ inquiry_type: "finance" });
  });

  it("tap combined button label → stored as 'life_health_pension'", async () => {
    const { updateInquiry } = setupInquirySlot();
    await handleIntake("conv5", "client5", "chat5@c.us", textPayload('ביטוח חיים/בריאות/פנסיה'));
    const updateFn = updateInquiry["update"] as ReturnType<typeof vi.fn>;
    expect(updateFn).toHaveBeenCalledOnce();
    expect(updateFn.mock.calls[0]?.[0]).toMatchObject({ inquiry_type: "life_health_pension" });
  });

  it("non-text payload re-sends buttons once, updateClient NOT called", async () => {
    const botSettings = makeBuilder(BOT_ENABLED);
    const conv = makeBuilder(CONV_ACTIVE);
    const client = makeBuilder({ data: { intake_state: "collecting", intake_current_slot: "inquiry_type" }, error: null });
    const persistMsg = makeBuilder({ data: null, error: null });
    setupFrom([botSettings, conv, client, persistMsg]);

    const result = await handleIntake("conv5", "client5", "chat5@c.us", imagePayload());
    expect(result.consumed).toBe(true);
    expect(mockSendInteractiveButtons).toHaveBeenCalledOnce();
    expect(mockSendMessageWithTyping).not.toHaveBeenCalled();
  });
});
