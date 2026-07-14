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
  mockFromImpl,
  mockHandleOpInstanceEvent,
} = vi.hoisted(() => ({
  mockHandleIntake: vi.fn().mockResolvedValue({ consumed: false }),
  mockAssignStaffToMeeting: vi.fn().mockResolvedValue(undefined),
  mockSendMessageWithTyping: vi.fn().mockResolvedValue({ idMessage: "out1" }),
  mockIsStaffChat: vi.fn().mockResolvedValue(null),
  mockFromImpl: vi.fn(),
  mockHandleOpInstanceEvent: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Module mocks — must be declared before importing the subject
// ---------------------------------------------------------------------------

// env is re-assigned per test suite via vi.stubGlobal; default = no allowlist
const envMock = {
  GREENAPI_WEBHOOK_TOKEN: "tok",
  GREENAPI_OP_ID_INSTANCE: undefined as string | undefined,
  GREENAPI_NOTIFY_ID_INSTANCE: undefined as string | undefined,
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

vi.mock("../operations/unanswered-wa.service.js", () => ({
  handleOpInstanceEvent: mockHandleOpInstanceEvent,
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

function makeTemplateButtonBody(chatId: string, selectedId: string): Record<string, unknown> {
  return {
    typeWebhook: "incomingMessageReceived",
    idMessage: `msg-${Math.random().toString(36).slice(2)}`,
    senderData: {
      chatId,
      senderName: "Test User",
      sender: chatId,
    },
    messageData: {
      typeMessage: "templateButtonsReplyMessage",
      templateButtonReplyMessage: { selectedId, selectedDisplayText: "Some label" },
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

  it("keyword 'נציג' no longer escalates — handleIntake is called normally", async () => {
    const convUpsertBuilder = makeBuilder({ data: { id: "conv-esc" }, error: null });
    const msgInsertBuilder = makeBuilder({ data: { id: "msg-esc" }, error: null });
    const convSelectBuilder = makeBuilder({ data: { id: "conv-esc", client_id: "client-esc" }, error: null });

    setupFrom([convUpsertBuilder, msgInsertBuilder, convSelectBuilder]);

    const body = makeTextBody(LEAD_CHAT_ID, "אני רוצה לדבר עם נציג");
    const req = makeReq(body);
    const res = makeRes();

    await whatsappController.handleWebhook(req, res);
    await new Promise<void>((r) => setImmediate(r));

    expect(mockHandleIntake).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Token guard — GreenAPI only
// ---------------------------------------------------------------------------

describe("whatsappController.handleWebhook — token guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("correct Authorization: Bearer token → 200", async () => {
    const req = {
      headers: { authorization: "Bearer tok" },
      query: {},
      body: makeTextBody(OWNER_CHAT_ID, "שלום"),
    } as unknown as Request;
    const res = makeRes();

    await whatsappController.handleWebhook(req, res);

    expect((res.status as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(200);
  });

  it("correct ?token= query param → 200", async () => {
    const req = {
      headers: {},
      query: { token: "tok" },
      body: makeTextBody(OWNER_CHAT_ID, "שלום"),
    } as unknown as Request;
    const res = makeRes();

    await whatsappController.handleWebhook(req, res);

    expect((res.status as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(200);
  });

  it("wrong token → 200 (prevent retry storms)", async () => {
    const req = {
      headers: {},
      query: { token: "wrong-token" },
      body: makeTextBody(LEAD_CHAT_ID, "hello"),
    } as unknown as Request;
    const res = makeRes();

    await whatsappController.handleWebhook(req, res);

    expect((res.status as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(200);
    expect((res.json as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Operational-instance dispatch — token verified FIRST, then handed to
// handleOpInstanceEvent; never reaches the conversational pipeline.
// ---------------------------------------------------------------------------

describe("whatsappController.handleWebhook — operational-instance dispatch", () => {
  const OP_ID_INSTANCE = "7103519997";

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsStaffChat.mockResolvedValue(null);
    mockHandleIntake.mockResolvedValue({ consumed: false });
    envMock.GREENAPI_OP_ID_INSTANCE = OP_ID_INSTANCE;
  });

  afterEach(() => {
    envMock.GREENAPI_OP_ID_INSTANCE = undefined;
  });

  it("valid token + OP instance event: 200, dispatches to handleOpInstanceEvent, never handleIntake", async () => {
    const body = {
      typeWebhook: "incomingMessageReceived",
      instanceData: { idInstance: OP_ID_INSTANCE },
      senderData: { chatId: "972501111111@c.us", senderName: "Someone" },
      messageData: { typeMessage: "textMessage", textMessageData: { textMessage: "hi" } },
    };
    const req = {
      headers: { authorization: "Bearer tok" },
      query: {},
      body,
    } as unknown as Request;
    const res = makeRes();

    await whatsappController.handleWebhook(req, res);

    expect((res.status as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(200);

    await new Promise<void>((r) => setImmediate(r));

    expect(mockHandleOpInstanceEvent).toHaveBeenCalledOnce();
    expect(mockHandleOpInstanceEvent).toHaveBeenCalledWith(body);
    expect(mockHandleIntake).not.toHaveBeenCalled();
  });

  it("bad token + OP instance event: 200, warns, does NOT dispatch to handleOpInstanceEvent", async () => {
    const body = {
      typeWebhook: "incomingMessageReceived",
      instanceData: { idInstance: OP_ID_INSTANCE },
      senderData: { chatId: "972501111111@c.us", senderName: "Someone" },
      messageData: { typeMessage: "textMessage", textMessageData: { textMessage: "hi" } },
    };
    const req = {
      headers: {},
      query: { token: "wrong-token" },
      body,
    } as unknown as Request;
    const res = makeRes();

    await whatsappController.handleWebhook(req, res);

    expect((res.status as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(200);
    expect((res.json as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith({ ok: true });

    await new Promise<void>((r) => setImmediate(r));

    expect(mockHandleOpInstanceEvent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// templateButtonsReplyMessage — normalises to kind:"text" with selectedId
// ---------------------------------------------------------------------------

describe("whatsappController.handleWebhook — templateButtonsReplyMessage normalisation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsStaffChat.mockResolvedValue(null);
    mockHandleIntake.mockResolvedValue({ consumed: true });
  });

  it("assign_staff button tap via templateButtonsReplyMessage routes to assignStaffToMeeting", async () => {
    const body = makeTemplateButtonBody(OWNER_CHAT_ID, "assign_staff:meet-x:staff-y");
    const req = makeReq(body);
    const res = makeRes();

    await whatsappController.handleWebhook(req, res);
    await new Promise<void>((r) => setImmediate(r));

    expect(mockAssignStaffToMeeting).toHaveBeenCalledOnce();
    expect(mockAssignStaffToMeeting).toHaveBeenCalledWith("meet-x", "staff-y", OWNER_CHAT_ID);
    expect(mockHandleIntake).not.toHaveBeenCalled();
  });

  it("intake button tap via templateButtonsReplyMessage dispatches to handleIntake", async () => {
    const convUpsertBuilder = makeBuilder({ data: { id: "conv-t" }, error: null });
    const msgInsertBuilder = makeBuilder({ data: { id: "msg-t" }, error: null });
    const convSelectBuilder = makeBuilder({ data: { id: "conv-t", client_id: "client-t" }, error: null });

    setupFrom([convUpsertBuilder, msgInsertBuilder, convSelectBuilder]);

    const body = makeTemplateButtonBody(LEAD_CHAT_ID, "life_insurance");
    const req = makeReq(body);
    const res = makeRes();

    await whatsappController.handleWebhook(req, res);
    await new Promise<void>((r) => setImmediate(r));

    expect(mockHandleIntake).toHaveBeenCalled();
    const callArgs = mockHandleIntake.mock.calls[0] as [string, string, string, { kind: string; text: string }];
    expect(callArgs[3].kind).toBe("text");
    expect(callArgs[3].text).toBe("life_insurance");
  });
});

// ---------------------------------------------------------------------------
// NOTIFY-instance short-circuit — only incoming assign_staff taps are handled;
// everything else on that instance is 200-acked and ignored.
// (The allowlist / dedup / channel-stamp gate-chain cases live in
// inbound.pipeline.test.ts.)
// ---------------------------------------------------------------------------

describe("whatsappController.handleWebhook — NOTIFY-instance short-circuit", () => {
  const NOTIFY_ID_INSTANCE = "7107677591";

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsStaffChat.mockResolvedValue(null);
    mockHandleIntake.mockResolvedValue({ consumed: false });
    envMock.GREENAPI_NOTIFY_ID_INSTANCE = NOTIFY_ID_INSTANCE;
  });

  afterEach(() => {
    envMock.GREENAPI_NOTIFY_ID_INSTANCE = undefined;
  });

  it("incoming assign_staff tap on the notify line → assignStaffToMeeting, never handleIntake", async () => {
    const body = {
      ...makeButtonBody("972547725826@c.us", "assign_staff:meet-n:staff-n"),
      instanceData: { idInstance: NOTIFY_ID_INSTANCE },
    };
    const req = makeReq(body);
    const res = makeRes();

    await whatsappController.handleWebhook(req, res);

    expect((res.status as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(200);

    await new Promise<void>((r) => setImmediate(r));

    expect(mockAssignStaffToMeeting).toHaveBeenCalledOnce();
    expect(mockAssignStaffToMeeting).toHaveBeenCalledWith("meet-n", "staff-n", "972547725826@c.us");
    expect(mockHandleIntake).not.toHaveBeenCalled();
    expect(mockHandleOpInstanceEvent).not.toHaveBeenCalled();
  });

  it("plain text on the notify line → 200 acked, nothing dispatched", async () => {
    const body = {
      ...makeTextBody("972500000000@c.us", "שלום"),
      instanceData: { idInstance: NOTIFY_ID_INSTANCE },
    };
    const req = makeReq(body);
    const res = makeRes();

    await whatsappController.handleWebhook(req, res);
    await new Promise<void>((r) => setImmediate(r));

    expect((res.status as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(200);
    expect(mockAssignStaffToMeeting).not.toHaveBeenCalled();
    expect(mockHandleIntake).not.toHaveBeenCalled();
    expect(mockHandleOpInstanceEvent).not.toHaveBeenCalled();
  });

  it("non-incoming webhook types on the notify line are ignored", async () => {
    const body = {
      typeWebhook: "outgoingMessageReceived",
      instanceData: { idInstance: NOTIFY_ID_INSTANCE },
      senderData: { chatId: "972500000000@c.us" },
      messageData: { typeMessage: "interactiveButtonsResponseMessage", interactiveButtonsResponse: { selectedId: "assign_staff:m:s" } },
    };
    const req = makeReq(body);
    const res = makeRes();

    await whatsappController.handleWebhook(req, res);
    await new Promise<void>((r) => setImmediate(r));

    expect(mockAssignStaffToMeeting).not.toHaveBeenCalled();
  });
});
