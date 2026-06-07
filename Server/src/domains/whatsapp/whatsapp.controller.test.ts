import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

// ---------------------------------------------------------------------------
// vi.hoisted — shared mock functions declared before any vi.mock() factory
// ---------------------------------------------------------------------------
const {
  mockHandleIncomingMessage,
  mockHandleIntake,
  mockAssignStaffToMeeting,
  mockFinalizeSummary,
  mockHandleClientConfirm,
  mockSendMessageWithTyping,
  mockIsStaffChat,
  mockWantsHuman,
  mockHandleHumanEscalation,
  mockFromImpl,
} = vi.hoisted(() => ({
  mockHandleIncomingMessage: vi.fn().mockResolvedValue(undefined),
  mockHandleIntake: vi.fn().mockResolvedValue({ consumed: false }),
  mockAssignStaffToMeeting: vi.fn().mockResolvedValue(undefined),
  mockFinalizeSummary: vi.fn().mockResolvedValue(undefined),
  mockHandleClientConfirm: vi.fn().mockResolvedValue(undefined),
  mockSendMessageWithTyping: vi.fn().mockResolvedValue({ idMessage: "out1" }),
  mockIsStaffChat: vi.fn().mockResolvedValue(null),
  mockWantsHuman: vi.fn().mockReturnValue(false),
  mockHandleHumanEscalation: vi.fn().mockResolvedValue(undefined),
  mockFromImpl: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks — must be declared before importing the subject
// ---------------------------------------------------------------------------

vi.mock("../../config/env.js", () => ({
  env: {
    GREENAPI_WEBHOOK_TOKEN: "tok",
    SUMMARY_RECIPIENT_PHONE: "639219909210",
    NODE_ENV: "test",
    FRONTEND_URL: "http://localhost:5173",
    BACKEND_URL: "http://localhost:3000",
  },
}));

vi.mock("../../config/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../../config/supabase.js", () => ({
  supabaseAdmin: { from: mockFromImpl },
}));

vi.mock("../ai/ai.orchestrator.js", () => ({
  handleIncomingMessage: mockHandleIncomingMessage,
}));

vi.mock("../ai/intake.orchestrator.js", () => ({
  handleIntake: mockHandleIntake,
}));

vi.mock("../operations/operations.service.js", () => ({
  assignStaffToMeeting: mockAssignStaffToMeeting,
  finalizeSummary: mockFinalizeSummary,
  handleClientConfirm: mockHandleClientConfirm,
}));

vi.mock("./whatsapp.service.js", () => ({
  sendMessageWithTyping: mockSendMessageWithTyping,
  sendMessage: vi.fn().mockResolvedValue({ idMessage: "out2" }),
  sendInteractiveButtonsWithTyping: vi.fn().mockResolvedValue({ idMessage: "out3" }),
  sendTyping: vi.fn().mockResolvedValue(undefined),
  getState: vi.fn().mockResolvedValue({ stateInstance: "authorized" }),
  getQrCode: vi.fn().mockResolvedValue({ qrCode: "" }),
}));

// Use REAL extractButtonId and toChatId; mock only isStaffChat
vi.mock("./whatsapp.util.js", async () => {
  const actual = await vi.importActual<typeof import("./whatsapp.util.js")>("./whatsapp.util.js");
  return {
    extractButtonId: actual.extractButtonId,
    toChatId: actual.toChatId,
    isStaffChat: mockIsStaffChat,
  };
});

vi.mock("./whatsapp.escalation.js", () => ({
  wantsHuman: mockWantsHuman,
  handleHumanEscalation: mockHandleHumanEscalation,
}));

// Use REAL whatsapp.validator — do NOT mock

// ---------------------------------------------------------------------------
// Subject imported after mocks
// ---------------------------------------------------------------------------
import { whatsappController } from "./whatsapp.controller.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generic chainable builder: every chain method returns itself; awaiting it
 * resolves to `result`. Used to stub supabaseAdmin.from(...).select(...).eq(...)...
 */
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
  // make the builder itself thenable so `await supabaseAdmin.from(...).insert(...)` works
  b["then"] = (resolve: (v: unknown) => void) =>
    Promise.resolve(result).then(resolve);
  return b;
}

/**
 * Configure mockFromImpl to return builders in sequence, cycling on the last one.
 */
function setupFrom(builders: ReturnType<typeof makeBuilder>[]) {
  let i = 0;
  mockFromImpl.mockImplementation(() => {
    const b = builders[i] ?? builders[builders.length - 1]!;
    i++;
    return b;
  });
}

/** Minimum valid GreenAPI incomingMessageReceived body for a text message */
function makeTextBody(chatId: string, text: string): Record<string, unknown> {
  return {
    typeWebhook: "incomingMessageReceived",
    idMessage: `msg-${Math.random().toString(36).slice(2)}`,
    senderData: {
      chatId,
      senderName: "Test User",
      sender: chatId,
    },
    messageData: {
      typeMessage: "textMessage",
      textMessageData: { textMessage: text },
    },
  };
}

/** Minimum valid GreenAPI incomingMessageReceived body with an interactive button reply */
function makeButtonBody(chatId: string, buttonId: string): Record<string, unknown> {
  return {
    typeWebhook: "incomingMessageReceived",
    idMessage: `msg-${Math.random().toString(36).slice(2)}`,
    senderData: {
      chatId,
      senderName: "Test User",
      sender: chatId,
    },
    messageData: {
      typeMessage: "interactiveButtonsResponseMessage",
      // extractButtonId reads messageData.interactiveButtonsResponse?.selectedId
      interactiveButtonsResponse: { selectedId: buttonId },
    },
  };
}

/** Express-like request */
function makeReq(body: Record<string, unknown>): Request {
  return {
    headers: { authorization: "Bearer tok" },
    query: {},
    body,
  } as unknown as Request;
}

/** Chainable Express-like response */
function makeRes(): Response {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
    sendStatus: vi.fn(),
  } as unknown as Response;
  (res.status as ReturnType<typeof vi.fn>).mockReturnValue(res);
  return res;
}

// The owner chatId as the controller will compute it:
// toChatId("639219909210") → "639219909210@c.us"
const OWNER_CHAT_ID = "639219909210@c.us";
const LEAD_CHAT_ID = "972500000000@c.us";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("whatsappController.handleWebhook — owner operational-only routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsStaffChat.mockResolvedValue(null);
    mockWantsHuman.mockReturnValue(false);
    mockHandleIntake.mockResolvedValue({ consumed: false });
    mockHandleIncomingMessage.mockResolvedValue(undefined);
    mockAssignStaffToMeeting.mockResolvedValue(undefined);
  });

  // -------------------------------------------------------------------------
  // Case 1: Owner + assign_staff button
  // -------------------------------------------------------------------------
  it("owner + assign_staff button: calls assignStaffToMeeting, never handleIntake or handleIncomingMessage", async () => {
    const body = makeButtonBody(OWNER_CHAT_ID, "assign_staff:m1:s1");
    const req = makeReq(body);
    const res = makeRes();

    await whatsappController.handleWebhook(req, res);

    // Response must be 200 immediately
    expect((res.status as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(200);

    // assignStaffToMeeting runs inside setImmediate — flush the queue
    await new Promise<void>((r) => setImmediate(r));

    expect(mockAssignStaffToMeeting).toHaveBeenCalledOnce();
    expect(mockAssignStaffToMeeting).toHaveBeenCalledWith("m1", "s1", OWNER_CHAT_ID);

    expect(mockHandleIntake).not.toHaveBeenCalled();
    expect(mockHandleIncomingMessage).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Case 2: Owner + plain text — silent, no lead flow
  // -------------------------------------------------------------------------
  it("owner + plain text: no assignStaffToMeeting, no handleIntake, no handleIncomingMessage; responds 200", async () => {
    const body = makeTextBody(OWNER_CHAT_ID, "שלום");
    const req = makeReq(body);
    const res = makeRes();

    await whatsappController.handleWebhook(req, res);

    // Flush setImmediate in case anything was queued
    await new Promise<void>((r) => setImmediate(r));

    expect((res.status as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(200);
    expect(mockAssignStaffToMeeting).not.toHaveBeenCalled();
    expect(mockHandleIntake).not.toHaveBeenCalled();
    expect(mockHandleIncomingMessage).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Case 3: Normal lead + plain text — lead flow runs
  // -------------------------------------------------------------------------
  it("normal lead + plain text: at least one of handleIntake / handleIncomingMessage is called", async () => {
    // The lead flow requires several supabase calls (upsert conversation, insert message,
    // select conversation, select/insert client, link client). Provide generic builders
    // that resolve successfully so the controller progresses to the async dispatch.
    const convUpsertBuilder = makeBuilder({ data: { id: "conv1" }, error: null });
    const msgInsertBuilder = makeBuilder({ data: { id: "msg1" }, error: null });
    const convSelectBuilder = makeBuilder({ data: { id: "conv1", client_id: null }, error: null });
    const clientSelectBuilder = makeBuilder({ data: null, error: null }); // no existing client
    const staffSelectBuilder = makeBuilder({ data: { id: "staff1" }, error: null });
    const clientInsertBuilder = makeBuilder({ data: { id: "client1" }, error: null });
    const convLinkBuilder = makeBuilder({ data: null, error: null });

    setupFrom([
      convUpsertBuilder,
      msgInsertBuilder,
      convSelectBuilder,
      clientSelectBuilder,
      staffSelectBuilder,
      clientInsertBuilder,
      convLinkBuilder,
    ]);

    const body = makeTextBody(LEAD_CHAT_ID, "Hello, I need insurance");
    const req = makeReq(body);
    const res = makeRes();

    await whatsappController.handleWebhook(req, res);

    // Flush setImmediate where AI dispatch happens
    await new Promise<void>((r) => setImmediate(r));

    const leadFlowRan =
      mockHandleIntake.mock.calls.length > 0 ||
      mockHandleIncomingMessage.mock.calls.length > 0;

    expect(leadFlowRan).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Case 4: Staff number — no handleIntake / handleIncomingMessage
  // -------------------------------------------------------------------------
  it("staff number: isStaffChat returns a staff object, so handleIntake and handleIncomingMessage are NOT called", async () => {
    // Override for this test: isStaffChat returns a staff object
    mockIsStaffChat.mockResolvedValueOnce({ staffId: "staff-99", fullName: "Alice" });

    // Staff intercept also does a supabase query (meetings lookup for edit session)
    const staffMeetingBuilder = makeBuilder({ data: null, error: null });
    setupFrom([staffMeetingBuilder, staffMeetingBuilder, staffMeetingBuilder]);

    const STAFF_CHAT_ID = "972501111111@c.us";
    const body = makeTextBody(STAFF_CHAT_ID, "שלום");
    const req = makeReq(body);
    const res = makeRes();

    await whatsappController.handleWebhook(req, res);

    // Flush setImmediate where staff handler runs
    await new Promise<void>((r) => setImmediate(r));

    expect(mockHandleIntake).not.toHaveBeenCalled();
    expect(mockHandleIncomingMessage).not.toHaveBeenCalled();
  });
});
