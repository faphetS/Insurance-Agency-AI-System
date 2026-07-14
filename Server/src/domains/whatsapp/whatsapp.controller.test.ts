import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response } from "express";

// ---------------------------------------------------------------------------
// vi.hoisted — shared mock functions declared before any vi.mock() factory
// ---------------------------------------------------------------------------
const { mockAssignStaffToMeeting, mockHandleOpInstanceEvent } = vi.hoisted(() => ({
  mockAssignStaffToMeeting: vi.fn().mockResolvedValue(undefined),
  mockHandleOpInstanceEvent: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Module mocks — must be declared before importing the subject
// ---------------------------------------------------------------------------

const envMock = {
  GREENAPI_WEBHOOK_TOKEN: "tok",
  GREENAPI_OP_ID_INSTANCE: undefined as string | undefined,
  GREENAPI_NOTIFY_ID_INSTANCE: undefined as string | undefined,
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
  supabaseAdmin: { from: vi.fn() },
}));

vi.mock("../meetings/meeting-handoff.service.js", () => ({
  assignStaffToMeeting: mockAssignStaffToMeeting,
}));

vi.mock("../operations/unanswered-wa.service.js", () => ({
  handleOpInstanceEvent: mockHandleOpInstanceEvent,
}));

vi.mock("./whatsapp.service.js", () => ({
  sendMessage: vi.fn().mockResolvedValue({ idMessage: "out2" }),
}));

// ---------------------------------------------------------------------------
// Subject imported after mocks
// ---------------------------------------------------------------------------
import { whatsappController } from "./whatsapp.controller.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
// Token guard — checked before any instance dispatch
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

  it("correct token + no recognised instance → 200, acknowledged and ignored", async () => {
    const req = {
      headers: { authorization: "Bearer tok" },
      query: {},
      body: makeTextBody(LEAD_CHAT_ID, "hello"),
    } as unknown as Request;
    const res = makeRes();

    await whatsappController.handleWebhook(req, res);

    expect((res.status as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(200);
    expect((res.json as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith({ ok: true });
    expect(mockAssignStaffToMeeting).not.toHaveBeenCalled();
    expect(mockHandleOpInstanceEvent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Operational-instance dispatch — token verified FIRST, then handed to
// handleOpInstanceEvent.
// ---------------------------------------------------------------------------

describe("whatsappController.handleWebhook — operational-instance dispatch", () => {
  const OP_ID_INSTANCE = "7103519997";

  beforeEach(() => {
    vi.clearAllMocks();
    envMock.GREENAPI_OP_ID_INSTANCE = OP_ID_INSTANCE;
  });

  afterEach(() => {
    envMock.GREENAPI_OP_ID_INSTANCE = undefined;
  });

  it("valid token + OP instance event: 200, dispatches to handleOpInstanceEvent", async () => {
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
// NOTIFY-instance short-circuit — only incoming assign_staff taps are handled;
// everything else on that instance is 200-acked and ignored.
// ---------------------------------------------------------------------------

describe("whatsappController.handleWebhook — NOTIFY-instance short-circuit", () => {
  const NOTIFY_ID_INSTANCE = "7107677591";

  beforeEach(() => {
    vi.clearAllMocks();
    envMock.GREENAPI_NOTIFY_ID_INSTANCE = NOTIFY_ID_INSTANCE;
  });

  afterEach(() => {
    envMock.GREENAPI_NOTIFY_ID_INSTANCE = undefined;
  });

  it("incoming assign_staff tap on the notify line → assignStaffToMeeting", async () => {
    const body = {
      ...makeButtonBody("972547725826@c.us", "assign_staff:meet-n:staff-n"),
      instanceData: { idInstance: NOTIFY_ID_INSTANCE },
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

    expect(mockAssignStaffToMeeting).toHaveBeenCalledOnce();
    expect(mockAssignStaffToMeeting).toHaveBeenCalledWith("meet-n", "staff-n", "972547725826@c.us");
    expect(mockHandleOpInstanceEvent).not.toHaveBeenCalled();
  });

  it("plain text on the notify line → 200 acked, nothing dispatched", async () => {
    const body = {
      ...makeTextBody("972500000000@c.us", "שלום"),
      instanceData: { idInstance: NOTIFY_ID_INSTANCE },
    };
    const req = {
      headers: { authorization: "Bearer tok" },
      query: {},
      body,
    } as unknown as Request;
    const res = makeRes();

    await whatsappController.handleWebhook(req, res);
    await new Promise<void>((r) => setImmediate(r));

    expect((res.status as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(200);
    expect(mockAssignStaffToMeeting).not.toHaveBeenCalled();
    expect(mockHandleOpInstanceEvent).not.toHaveBeenCalled();
  });

  it("non-incoming webhook types on the notify line are ignored", async () => {
    const body = {
      typeWebhook: "outgoingMessageReceived",
      instanceData: { idInstance: NOTIFY_ID_INSTANCE },
      senderData: { chatId: "972500000000@c.us" },
      messageData: { typeMessage: "interactiveButtonsResponseMessage", interactiveButtonsResponse: { selectedId: "assign_staff:m:s" } },
    };
    const req = {
      headers: { authorization: "Bearer tok" },
      query: {},
      body,
    } as unknown as Request;
    const res = makeRes();

    await whatsappController.handleWebhook(req, res);
    await new Promise<void>((r) => setImmediate(r));

    expect(mockAssignStaffToMeeting).not.toHaveBeenCalled();
  });
});
