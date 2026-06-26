import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response } from "express";

// ---------------------------------------------------------------------------
// vi.hoisted — shared mock functions declared before any vi.mock() factory
// ---------------------------------------------------------------------------
const {
  mockHandleIntake,
  mockAssignStaffToMeeting,
  mockSendMessageWithTyping,
  mockIsStaffChat,
  mockWantsHuman,
  mockHandleHumanEscalation,
  mockFromImpl,
} = vi.hoisted(() => ({
  mockHandleIntake: vi.fn().mockResolvedValue({ consumed: false }),
  mockAssignStaffToMeeting: vi.fn().mockResolvedValue(undefined),
  mockSendMessageWithTyping: vi.fn().mockResolvedValue({ idMessage: "out1" }),
  mockIsStaffChat: vi.fn().mockResolvedValue(null),
  mockWantsHuman: vi.fn().mockReturnValue(false),
  mockHandleHumanEscalation: vi.fn().mockResolvedValue(undefined),
  mockFromImpl: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks — must be declared before importing the subject
// ---------------------------------------------------------------------------

// env is re-assigned per test suite via vi.stubGlobal; default = no allowlist
const envMock = {
  GREENAPI_WEBHOOK_TOKEN: "tok",
  CLIX_WEBHOOK_TOKEN: "clix-secret-token-x1",
  SUMMARY_RECIPIENT_PHONE: "639219909210",
  NODE_ENV: "test",
  FRONTEND_URL: "http://localhost:5173",
  BACKEND_URL: "http://localhost:3000",
  REPLY_ALLOWLIST: [] as string[],
};

vi.mock("../../config/env.js", () => ({ get env() { return envMock; } }));

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

vi.mock("../ai/intake.orchestrator.js", () => ({
  handleIntake: mockHandleIntake,
}));

vi.mock("../meetings/meeting-handoff.service.js", () => ({
  assignStaffToMeeting: mockAssignStaffToMeeting,
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

vi.mock("../operations/call-events.service.js", () => ({
  recordCallEvent: vi.fn().mockResolvedValue(undefined),
}));

// Use REAL whatsapp.validator — do NOT mock

// ---------------------------------------------------------------------------
// Subject imported after mocks
// ---------------------------------------------------------------------------
import { whatsappController } from "./whatsapp.controller.js";

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
  b["then"] = (resolve: (v: unknown) => void) =>
    Promise.resolve(result).then(resolve);
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
      interactiveButtonsResponse: { selectedId: buttonId },
    },
  };
}

function makeReq(body: Record<string, unknown>): Request {
  return {
    headers: { authorization: "Bearer tok" },
    query: {},
    body,
  } as unknown as Request;
}

function makeRes(): Response {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
    sendStatus: vi.fn(),
  } as unknown as Response;
  (res.status as ReturnType<typeof vi.fn>).mockReturnValue(res);
  return res;
}

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
    mockAssignStaffToMeeting.mockResolvedValue(undefined);
  });

  it("owner + assign_staff button: calls assignStaffToMeeting, never handleIntake", async () => {
    const body = makeButtonBody(OWNER_CHAT_ID, "assign_staff:m1:s1");
    const req = makeReq(body);
    const res = makeRes();

    await whatsappController.handleWebhook(req, res);

    expect((res.status as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(200);

    await new Promise<void>((r) => setImmediate(r));

    expect(mockAssignStaffToMeeting).toHaveBeenCalledOnce();
    expect(mockAssignStaffToMeeting).toHaveBeenCalledWith("m1", "s1", OWNER_CHAT_ID);
    expect(mockHandleIntake).not.toHaveBeenCalled();
  });

  it("owner + plain text: no assignStaffToMeeting, no handleIntake; responds 200", async () => {
    const body = makeTextBody(OWNER_CHAT_ID, "שלום");
    const req = makeReq(body);
    const res = makeRes();

    await whatsappController.handleWebhook(req, res);

    await new Promise<void>((r) => setImmediate(r));

    expect((res.status as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(200);
    expect(mockAssignStaffToMeeting).not.toHaveBeenCalled();
    expect(mockHandleIntake).not.toHaveBeenCalled();
  });

  it("normal lead + plain text: handleIntake is called", async () => {
    const convUpsertBuilder = makeBuilder({ data: { id: "conv1" }, error: null });
    const msgInsertBuilder = makeBuilder({ data: { id: "msg1" }, error: null });
    const convSelectBuilder = makeBuilder({ data: { id: "conv1", client_id: null }, error: null });
    const clientSelectBuilder = makeBuilder({ data: null, error: null });
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

    await new Promise<void>((r) => setImmediate(r));

    expect(mockHandleIntake).toHaveBeenCalled();
  });

  it("staff number: handleIntake is NOT called", async () => {
    mockIsStaffChat.mockResolvedValueOnce({ staffId: "staff-99", fullName: "Alice" });

    const STAFF_CHAT_ID = "972501111111@c.us";
    const body = makeTextBody(STAFF_CHAT_ID, "שלום");
    const req = makeReq(body);
    const res = makeRes();

    await whatsappController.handleWebhook(req, res);

    await new Promise<void>((r) => setImmediate(r));

    expect(mockHandleIntake).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Clix token guard
// ---------------------------------------------------------------------------

function makeClixTextBody(): Record<string, unknown> {
  return {
    customerId: "clix-inst-1",
    type: "incoming",
    chatType: "private",
    from: "639123456789",
    pushName: "Clix User",
    message: "Hello from Clix",
    messageType: "text",
    timestamp: 1718900000,
  };
}

describe("whatsappController.handleWebhook — Clix token guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("Clix-shaped body with wrong token → 401", async () => {
    const req = {
      headers: {},
      query: { token: "wrong-token" },
      body: makeClixTextBody(),
    } as unknown as Request;
    const res = makeRes();

    await whatsappController.handleWebhook(req, res);

    expect((res.status as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(401);
    expect((res.json as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false }),
    );
  });

  it("Clix-shaped body with correct token → 200", async () => {
    // clixToInternal will parse and normalise, then instance lookup runs;
    // mock supabase to return an unknown (inactive) instance so it short-circuits
    // after the token check with a 200.
    const instanceBuilder = makeBuilder({ data: null, error: null });
    setupFrom([instanceBuilder]);

    const req = {
      headers: {},
      query: { token: "clix-secret-token-x1" },
      body: makeClixTextBody(),
    } as unknown as Request;
    const res = makeRes();

    await whatsappController.handleWebhook(req, res);

    expect((res.status as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(200);
  });
});

// ---------------------------------------------------------------------------
// Reply allowlist gate
// ---------------------------------------------------------------------------

describe("whatsappController.handleWebhook — reply allowlist", () => {
  const ALLOWED_PHONE = "972501111111";
  const BLOCKED_PHONE = "972502222222";
  const ALLOWED_CHAT_ID = `${ALLOWED_PHONE}@c.us`;
  const BLOCKED_CHAT_ID = `${BLOCKED_PHONE}@c.us`;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsStaffChat.mockResolvedValue(null);
    mockWantsHuman.mockReturnValue(false);
    mockHandleIntake.mockResolvedValue({ consumed: true });
    envMock.REPLY_ALLOWLIST = [ALLOWED_PHONE];
  });

  afterEach(() => {
    envMock.REPLY_ALLOWLIST = [];
  });

  it("allowlisted sender dispatches intake", async () => {
    const convUpsertBuilder = makeBuilder({ data: { id: "conv-allow" }, error: null });
    const msgInsertBuilder = makeBuilder({ data: { id: "msg-allow" }, error: null });
    const convSelectBuilder = makeBuilder({ data: { id: "conv-allow", client_id: "client-allow" }, error: null });

    setupFrom([convUpsertBuilder, msgInsertBuilder, convSelectBuilder]);

    const body = makeTextBody(ALLOWED_CHAT_ID, "hello");
    const req = makeReq(body);
    const res = makeRes();

    await whatsappController.handleWebhook(req, res);
    await new Promise<void>((r) => setImmediate(r));

    expect((res.status as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(200);
    expect(mockHandleIntake).toHaveBeenCalled();
  });

  it("non-allowlisted sender returns 200 but does NOT dispatch intake", async () => {
    const convUpsertBuilder = makeBuilder({ data: { id: "conv-block" }, error: null });
    const msgInsertBuilder = makeBuilder({ data: { id: "msg-block" }, error: null });

    setupFrom([convUpsertBuilder, msgInsertBuilder]);

    const body = makeTextBody(BLOCKED_CHAT_ID, "hello");
    const req = makeReq(body);
    const res = makeRes();

    await whatsappController.handleWebhook(req, res);
    await new Promise<void>((r) => setImmediate(r));

    expect((res.status as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(200);
    expect(mockHandleIntake).not.toHaveBeenCalled();
  });

  it("empty allowlist (default) does not block any sender", async () => {
    envMock.REPLY_ALLOWLIST = [];

    const convUpsertBuilder = makeBuilder({ data: { id: "conv-open" }, error: null });
    const msgInsertBuilder = makeBuilder({ data: { id: "msg-open" }, error: null });
    const convSelectBuilder = makeBuilder({ data: { id: "conv-open", client_id: "client-open" }, error: null });

    setupFrom([convUpsertBuilder, msgInsertBuilder, convSelectBuilder]);

    const body = makeTextBody(BLOCKED_CHAT_ID, "hello");
    const req = makeReq(body);
    const res = makeRes();

    await whatsappController.handleWebhook(req, res);
    await new Promise<void>((r) => setImmediate(r));

    expect(mockHandleIntake).toHaveBeenCalled();
  });

  it("allowlist matching strips non-digit chars from both sides", async () => {
    // Entry has dashes/spaces; phone from chatId is digits only
    envMock.REPLY_ALLOWLIST = ["+972-50-1111111"];

    const convUpsertBuilder = makeBuilder({ data: { id: "conv-fmt" }, error: null });
    const msgInsertBuilder = makeBuilder({ data: { id: "msg-fmt" }, error: null });
    const convSelectBuilder = makeBuilder({ data: { id: "conv-fmt", client_id: "client-fmt" }, error: null });

    setupFrom([convUpsertBuilder, msgInsertBuilder, convSelectBuilder]);

    const body = makeTextBody(ALLOWED_CHAT_ID, "hello");
    const req = makeReq(body);
    const res = makeRes();

    await whatsappController.handleWebhook(req, res);
    await new Promise<void>((r) => setImmediate(r));

    expect(mockHandleIntake).toHaveBeenCalled();
  });
});
