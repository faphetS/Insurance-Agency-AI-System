/**
 * Unit tests for the new front-of-flow slots:
 *  - handleClientType: advances client_type → team_routing on any payload
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
// handleClientType — advances client_type → team_routing on any payload
// ---------------------------------------------------------------------------

describe("handleClientType — advances to team_routing regardless of payload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendInteractiveButtons.mockResolvedValue({ idMessage: "btn-team" });
    mockSendMessageWithTyping.mockResolvedValue({ idMessage: "txt-team" });
  });

  function setupClientTypeSlot() {
    const botSettings = makeBuilder(BOT_ENABLED);
    const conv = makeBuilder(CONV_ACTIVE);
    const client = makeBuilder({ data: { intake_state: "collecting", intake_current_slot: "client_type" }, error: null });
    const updateSlot = makeBuilder({ data: null, error: null });
    const persistMsg = makeBuilder({ data: null, error: null });
    setupFrom([botSettings, conv, client, updateSlot, persistMsg]);
  }

  it("text payload advances to team_routing", async () => {
    setupClientTypeSlot();
    const result = await handleIntake("conv1", "client1", "chat1@c.us", textPayload("New client"));
    expect(result.consumed).toBe(true);
    expect(mockSendInteractiveButtons).toHaveBeenCalledOnce();
    const call = mockSendInteractiveButtons.mock.calls[0];
    expect(call?.[1]).toContain("צוות");
  });

  it("image payload also advances to team_routing", async () => {
    setupClientTypeSlot();
    const result = await handleIntake("conv1", "client1", "chat1@c.us", imagePayload());
    expect(result.consumed).toBe(true);
    expect(mockSendInteractiveButtons).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// handleTeamRouting — advances team_routing → full_name on any payload
// ---------------------------------------------------------------------------

describe("handleTeamRouting — advances to full_name regardless of payload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendMessageWithTyping.mockResolvedValue({ idMessage: "txt-name" });
  });

  function setupTeamRoutingSlot() {
    const botSettings = makeBuilder(BOT_ENABLED);
    const conv = makeBuilder(CONV_ACTIVE);
    const client = makeBuilder({ data: { intake_state: "collecting", intake_current_slot: "team_routing" }, error: null });
    const updateSlot = makeBuilder({ data: null, error: null });
    const persistMsg = makeBuilder({ data: null, error: null });
    setupFrom([botSettings, conv, client, updateSlot, persistMsg]);
  }

  it("text payload advances to full_name and sends name question", async () => {
    setupTeamRoutingSlot();
    const result = await handleIntake("conv2", "client2", "chat2@c.us", textPayload("Team Y"));
    expect(result.consumed).toBe(true);
    expect(mockSendMessageWithTyping).toHaveBeenCalledOnce();
    const sentText = mockSendMessageWithTyping.mock.calls[0]?.[1] as string;
    expect(sentText).toContain("שם");
  });

  it("image payload also advances to full_name", async () => {
    setupTeamRoutingSlot();
    const result = await handleIntake("conv2", "client2", "chat2@c.us", imagePayload());
    expect(result.consumed).toBe(true);
    expect(mockSendMessageWithTyping).toHaveBeenCalledOnce();
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
    // Start from client_type slot → advanceTo("team_routing") → sendButtonPrompt("team_routing") throws
    mockSendInteractiveButtons.mockRejectedValueOnce(new Error("buttons unsupported"));

    const botSettings = makeBuilder(BOT_ENABLED);
    const conv = makeBuilder(CONV_ACTIVE);
    // client_type slot
    const client = makeBuilder({ data: { intake_state: "collecting", intake_current_slot: "client_type" }, error: null });
    // updateClient(clientId, { intake_current_slot: "team_routing" })
    const updateSlot = makeBuilder({ data: null, error: null });
    // persistOutbound after fallback sendMessageWithTyping
    const persistMsg = makeBuilder({ data: null, error: null });
    setupFrom([botSettings, conv, client, updateSlot, persistMsg]);

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
