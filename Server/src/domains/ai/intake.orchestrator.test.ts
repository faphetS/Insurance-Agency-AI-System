/**
 * Unit tests for the new front-of-flow slots:
 *  - handleClientType: captures client_type ('new'/'old'), persists it, then advances to team_routing
 *  - handleTeamRouting: advances team_routing → full_name on any payload
 *  - sendButtonPrompt: sends interactive buttons for new slots; falls back to plain text on failure
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
} = vi.hoisted(() => ({
  mockSendInteractiveButtons: vi.fn().mockResolvedValue({ idMessage: "btn-1" }),
  mockSendMessageWithTyping: vi.fn().mockResolvedValue({ idMessage: "txt-1" }),
  mockFromImpl: vi.fn(),
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
vi.mock("../integrations/google/leads-mirror.service.js", () => ({ mirrorLeadToSheet: vi.fn() }));

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
// handleClientType — captures client_type and advances to team_routing
// ---------------------------------------------------------------------------

describe("handleClientType — client_type mapping and DB persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendInteractiveButtons.mockResolvedValue({ idMessage: "btn-team" });
    mockSendMessageWithTyping.mockResolvedValue({ idMessage: "txt-team" });
  });

  function setupClientTypeSlot() {
    const botSettings = makeBuilder(BOT_ENABLED);
    const conv = makeBuilder(CONV_ACTIVE);
    const client = makeBuilder({ data: { intake_state: "collecting", intake_current_slot: "client_type" }, error: null });
    // updateClient for client_type
    const updateClientType = makeBuilder({ data: null, error: null });
    // updateClient inside advanceTo for intake_current_slot
    const updateSlot = makeBuilder({ data: null, error: null });
    // persistOutbound
    const persistMsg = makeBuilder({ data: null, error: null });
    setupFrom([botSettings, conv, client, updateClientType, updateSlot, persistMsg]);
    return { updateClientType };
  }

  it("label 'New client' → client_type 'new'", async () => {
    const { updateClientType } = setupClientTypeSlot();
    await handleIntake("conv1", "client1", "chat1@c.us", textPayload("New client"));
    const updateFn = updateClientType["update"] as ReturnType<typeof vi.fn>;
    expect(updateFn).toHaveBeenCalledOnce();
    expect(updateFn.mock.calls[0]?.[0]).toMatchObject({ client_type: "new" });
  });

  it("label 'Old client' → client_type 'old'", async () => {
    const { updateClientType } = setupClientTypeSlot();
    await handleIntake("conv1", "client1", "chat1@c.us", textPayload("Old client"));
    const updateFn = updateClientType["update"] as ReturnType<typeof vi.fn>;
    expect(updateFn).toHaveBeenCalledOnce();
    expect(updateFn.mock.calls[0]?.[0]).toMatchObject({ client_type: "old" });
  });

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

  it("unrecognised text → defaults to 'new'", async () => {
    const { updateClientType } = setupClientTypeSlot();
    await handleIntake("conv1", "client1", "chat1@c.us", textPayload("something else"));
    const updateFn = updateClientType["update"] as ReturnType<typeof vi.fn>;
    expect(updateFn).toHaveBeenCalledOnce();
    expect(updateFn.mock.calls[0]?.[0]).toMatchObject({ client_type: "new" });
  });

  it("non-text payload (image) → defaults to 'new'", async () => {
    const { updateClientType } = setupClientTypeSlot();
    await handleIntake("conv1", "client1", "chat1@c.us", imagePayload());
    const updateFn = updateClientType["update"] as ReturnType<typeof vi.fn>;
    expect(updateFn).toHaveBeenCalledOnce();
    expect(updateFn.mock.calls[0]?.[0]).toMatchObject({ client_type: "new" });
  });

  it("advances to team_routing regardless of payload (text)", async () => {
    setupClientTypeSlot();
    const result = await handleIntake("conv1", "client1", "chat1@c.us", textPayload("New client"));
    expect(result.consumed).toBe(true);
    expect(mockSendInteractiveButtons).toHaveBeenCalledOnce();
    const call = mockSendInteractiveButtons.mock.calls[0];
    expect(call?.[1]).toContain("צוות");
  });

  it("advances to team_routing regardless of payload (image)", async () => {
    setupClientTypeSlot();
    const result = await handleIntake("conv1", "client1", "chat1@c.us", imagePayload());
    expect(result.consumed).toBe(true);
    expect(mockSendInteractiveButtons).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// handleTeamRouting — forks on client_type: 'old' → done, else → full_name
// ---------------------------------------------------------------------------

describe("handleTeamRouting — old client skips to done, new client goes to full_name", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendMessageWithTyping.mockResolvedValue({ idMessage: "txt-name" });
  });

  function setupTeamRoutingSlot(client_type: "new" | "old" | null) {
    const botSettings = makeBuilder(BOT_ENABLED);
    const conv = makeBuilder(CONV_ACTIVE);
    const client = makeBuilder({ data: { intake_state: "collecting", intake_current_slot: "team_routing" }, error: null });
    // handleTeamRouting DB lookup for client_type
    const clientTypeLookup = makeBuilder({ data: { client_type }, error: null });
    if (client_type === "old") {
      // advanceTo("done") → updateClient(intake_current_slot=done) → finalize
      const updateSlot = makeBuilder({ data: null, error: null });
      // finalize: select inquiry_type, poa_doc_url, email, client_type
      const clientForFinalize = makeBuilder({ data: { inquiry_type: null, poa_doc_url: null, email: null, client_type: "old" }, error: null });
      // finalize: updateClient (mark completed)
      const finalizeUpdate = makeBuilder({ data: null, error: null });
      // finalize: meetings insert
      const meetingsInsert = makeBuilder({ data: null, error: null });
      // persistOutbound (done message)
      const persistMsg = makeBuilder({ data: null, error: null });
      // finalize: conversations update bot_paused
      const convUpdate = makeBuilder({ data: null, error: null });
      setupFrom([botSettings, conv, client, clientTypeLookup, updateSlot, clientForFinalize, finalizeUpdate, meetingsInsert, persistMsg, convUpdate]);
    } else {
      // advanceTo("full_name") → updateClient(intake_current_slot=full_name) → sendTextPrompt
      const updateSlot = makeBuilder({ data: null, error: null });
      const persistMsg = makeBuilder({ data: null, error: null });
      setupFrom([botSettings, conv, client, clientTypeLookup, updateSlot, persistMsg]);
    }
  }

  it("client_type:'new' → advances to full_name and sends name question", async () => {
    setupTeamRoutingSlot("new");
    const result = await handleIntake("conv2", "client2", "chat2@c.us", textPayload("Team Y"));
    expect(result.consumed).toBe(true);
    expect(mockSendMessageWithTyping).toHaveBeenCalledOnce();
    const sentText = mockSendMessageWithTyping.mock.calls[0]?.[1] as string;
    expect(sentText).toContain("שם");
    expect(mockSendInteractiveButtons).not.toHaveBeenCalled();
  });

  it("client_type:null → advances to full_name (treats as new)", async () => {
    setupTeamRoutingSlot(null);
    const result = await handleIntake("conv2", "client2", "chat2@c.us", textPayload("Team Y"));
    expect(result.consumed).toBe(true);
    expect(mockSendMessageWithTyping).toHaveBeenCalledOnce();
    const sentText = mockSendMessageWithTyping.mock.calls[0]?.[1] as string;
    expect(sentText).toContain("שם");
  });

  it("client_type:'old' → goes straight to done (finalize path, no full_name prompt)", async () => {
    setupTeamRoutingSlot("old");
    const result = await handleIntake("conv2", "client2", "chat2@c.us", textPayload("Team Y"));
    expect(result.consumed).toBe(true);
    // done_existing message sent (contains the booking URL, not the name question)
    expect(mockSendMessageWithTyping).toHaveBeenCalledOnce();
    const sentText = mockSendMessageWithTyping.mock.calls[0]?.[1] as string;
    expect(sentText).toContain("https://example.com/book");
    expect(sentText).not.toContain("שם");
  });

  it("client_type:'old' → done message uses done_existing text (לקביעת פגישה)", async () => {
    setupTeamRoutingSlot("old");
    await handleIntake("conv2", "client2", "chat2@c.us", textPayload("Stay"));
    const sentText = mockSendMessageWithTyping.mock.calls[0]?.[1] as string;
    expect(sentText).toContain("לקביעת פגישה");
  });

  it("client_type:'old' → done message does NOT use new-client done text", async () => {
    setupTeamRoutingSlot("old");
    await handleIntake("conv2", "client2", "chat2@c.us", textPayload("Stay"));
    const sentText = mockSendMessageWithTyping.mock.calls[0]?.[1] as string;
    expect(sentText).not.toContain("התקבלו כל הפרטים הנדרשים");
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
  });

  function setupInquirySlot() {
    const botSettings = makeBuilder(BOT_ENABLED);
    const conv = makeBuilder(CONV_ACTIVE);
    const client = makeBuilder({ data: { intake_state: "collecting", intake_current_slot: "inquiry_type" }, error: null });
    // updateClient for inquiry_type
    const updateInquiry = makeBuilder({ data: null, error: null });
    // updateClient inside advanceTo for intake_current_slot
    const updateSlot = makeBuilder({ data: null, error: null });
    // persistOutbound
    const persistMsg = makeBuilder({ data: null, error: null });
    setupFrom([botSettings, conv, client, updateInquiry, updateSlot, persistMsg]);
    return { updateInquiry };
  }

  function setupInquirySlotReprompt() {
    const botSettings = makeBuilder(BOT_ENABLED);
    const conv = makeBuilder(CONV_ACTIVE);
    const client = makeBuilder({ data: { intake_state: "collecting", intake_current_slot: "inquiry_type" }, error: null });
    // persistOutbound after re-sent buttons
    const persistMsg = makeBuilder({ data: null, error: null });
    setupFrom([botSettings, conv, client, persistMsg]);
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

  it("tap 'אחר' (button label) → stored as 'other' and advances", async () => {
    const { updateInquiry } = setupInquirySlot();
    await handleIntake("conv5", "client5", "chat5@c.us", textPayload("אחר"));
    const updateFn = updateInquiry["update"] as ReturnType<typeof vi.fn>;
    expect(updateFn).toHaveBeenCalledOnce();
    expect(updateFn.mock.calls[0]?.[0]).toMatchObject({ inquiry_type: "other" });
    expect(mockSendInteractiveButtons).not.toHaveBeenCalled();
  });

  it("unmatched free text → re-sends buttons, updateClient NOT called, no advance", async () => {
    setupInquirySlotReprompt();
    const result = await handleIntake("conv5", "client5", "chat5@c.us", textPayload("random words"));
    expect(result.consumed).toBe(true);
    expect(mockSendInteractiveButtons).toHaveBeenCalledOnce();
    expect(mockSendMessageWithTyping).not.toHaveBeenCalled();
  });

  it("matched button advances to id_photo (consumed=true, id_photo prompt sent)", async () => {
    setupInquirySlot();
    const result = await handleIntake("conv5", "client5", "chat5@c.us", textPayload("other"));
    expect(result.consumed).toBe(true);
    expect(mockSendMessageWithTyping).toHaveBeenCalledOnce();
    const sentText = mockSendMessageWithTyping.mock.calls[0]?.[1] as string;
    expect(sentText).toContain("תעודת הזהות");
  });

  it("non-text payload re-sends buttons once, updateClient NOT called", async () => {
    setupInquirySlotReprompt();
    const result = await handleIntake("conv5", "client5", "chat5@c.us", imagePayload());
    expect(result.consumed).toBe(true);
    expect(mockSendInteractiveButtons).toHaveBeenCalledOnce();
    expect(mockSendMessageWithTyping).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// sendButtonPrompt (exercised via handleIntake at client_type / team_routing)
// Falls back to plain-text when sendInteractiveButtonsWithTyping throws
// ---------------------------------------------------------------------------

describe("sendButtonPrompt — fallback to plain text on button send failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendMessageWithTyping.mockResolvedValue({ idMessage: "fallback-txt" });
  });

  it("client_type: falls back to plain text list when interactive buttons throw", async () => {
    // Start from welcome slot → advanceTo("client_type") → sendButtonPrompt("client_type") throws
    mockSendInteractiveButtons.mockRejectedValueOnce(new Error("buttons unsupported"));

    const botSettings = makeBuilder(BOT_ENABLED);
    const conv = makeBuilder(CONV_ACTIVE);
    // welcome slot
    const client = makeBuilder({ data: { intake_state: "collecting", intake_current_slot: "welcome" }, error: null });
    // updateClient(clientId, { intake_current_slot: "client_type" })
    const updateSlot = makeBuilder({ data: null, error: null });
    // persistOutbound after fallback sendMessageWithTyping
    const persistMsg = makeBuilder({ data: null, error: null });
    setupFrom([botSettings, conv, client, updateSlot, persistMsg]);

    const result = await handleIntake("conv3", "client3", "chat3@c.us", textPayload("hi"));
    expect(result.consumed).toBe(true);
    expect(mockSendMessageWithTyping).toHaveBeenCalledOnce();
    const fallbackText = mockSendMessageWithTyping.mock.calls[0]?.[1] as string;
    expect(fallbackText).toContain("New client");
    expect(fallbackText).toContain("Old client");
  });

  it("team_routing: falls back to plain text list when interactive buttons throw", async () => {
    // Start from client_type slot → updateClient(client_type) → advanceTo("team_routing") → sendButtonPrompt throws
    mockSendInteractiveButtons.mockRejectedValueOnce(new Error("buttons unsupported"));

    const botSettings = makeBuilder(BOT_ENABLED);
    const conv = makeBuilder(CONV_ACTIVE);
    // client_type slot
    const client = makeBuilder({ data: { intake_state: "collecting", intake_current_slot: "client_type" }, error: null });
    // updateClient for client_type
    const updateClientType = makeBuilder({ data: null, error: null });
    // updateClient inside advanceTo for intake_current_slot
    const updateSlot = makeBuilder({ data: null, error: null });
    // persistOutbound after fallback sendMessageWithTyping
    const persistMsg = makeBuilder({ data: null, error: null });
    setupFrom([botSettings, conv, client, updateClientType, updateSlot, persistMsg]);

    const result = await handleIntake("conv4", "client4", "chat4@c.us", textPayload("New client"));
    expect(result.consumed).toBe(true);
    expect(mockSendMessageWithTyping).toHaveBeenCalledOnce();
    const fallbackText = mockSendMessageWithTyping.mock.calls[0]?.[1] as string;
    expect(fallbackText).toContain("Team Y");
    expect(fallbackText).toContain("Team Z");
    expect(fallbackText).toContain("Contact Didi");
    expect(fallbackText).toContain("Stay");
  });
});
