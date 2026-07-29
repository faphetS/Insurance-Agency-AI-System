import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const { mockSendMessage, mockFromImpl, mockSendTemplate, mockPostPrivateNote, MockMetaSendError } =
  vi.hoisted(() => {
    class MockMetaSendError extends Error {
      constructor(
        message: string,
        public code?: number,
      ) {
        super(message);
        this.name = "MetaSendError";
      }
    }
    return {
      mockSendMessage: vi.fn().mockResolvedValue({ idMessage: "fwd-1" }),
      mockFromImpl: vi.fn(),
      mockSendTemplate: vi.fn().mockResolvedValue({ idMessage: "tpl-1" }),
      mockPostPrivateNote: vi.fn().mockResolvedValue(undefined),
      MockMetaSendError,
    };
  });

const envMock = {
  CHATWOOT_CALLBACK_SECRET: "hush-hush" as string | undefined,
  CHATWOOT_BOT_USER_ID: "3" as string | undefined,
  NODE_ENV: "test",
};

vi.mock("../../config/env.js", () => ({ get env() { return envMock; } }));

vi.mock("../../config/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../config/supabase.js", () => ({
  supabaseAdmin: { from: mockFromImpl },
}));

vi.mock("../whatsapp/whatsapp.service.js", () => ({
  sendMessage: mockSendMessage,
}));

vi.mock("../whatsapp/meta/meta.transport.js", () => ({
  sendTemplate: mockSendTemplate,
  MetaSendError: MockMetaSendError,
}));

vi.mock("./chatwoot.service.js", () => ({
  postPrivateNote: mockPostPrivateNote,
}));

import { chatwootController } from "./chatwoot.controller.js";
import { MetaSendError } from "../whatsapp/meta/meta.transport.js";

function makeBuilder(result: unknown) {
  const b: Record<string, unknown> = {};
  const chain = ["select", "eq", "in", "insert", "upsert", "update", "delete"];
  for (const m of chain) b[m] = vi.fn().mockReturnValue(b);
  const terminal = vi.fn().mockResolvedValue(result);
  b["maybeSingle"] = terminal;
  b["single"] = terminal;
  b["then"] = (resolve: (v: unknown) => void) => Promise.resolve(result).then(resolve);
  return b;
}

function makeRes(): Response {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
    send: vi.fn(),
    sendStatus: vi.fn(),
  } as unknown as Response;
  (res.status as ReturnType<typeof vi.fn>).mockReturnValue(res);
  return res;
}

function makeReq(secret: string, body: unknown): Request {
  return { params: { secret }, body } as unknown as Request;
}

function agentEvent(overrides: Record<string, unknown> = {}) {
  return {
    event: "message_created",
    message_type: "outgoing",
    private: false,
    content: "תשובה מהסוכן",
    sender: { id: 7, type: "user", name: "Didi" },
    conversation: {
      meta: {
        sender: {
          identifier: "972501112233@c.us",
          phone_number: "+972501112233",
        },
      },
    },
    ...overrides,
  };
}

async function flushImmediates() {
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSendMessage.mockResolvedValue({ idMessage: "fwd-1" });
  mockSendTemplate.mockResolvedValue({ idMessage: "tpl-1" });
  mockPostPrivateNote.mockResolvedValue(undefined);
  mockFromImpl.mockImplementation(() => makeBuilder({ data: null, error: null }));
  envMock.CHATWOOT_CALLBACK_SECRET = "hush-hush";
  envMock.CHATWOOT_BOT_USER_ID = "3";
});

// ---------------------------------------------------------------------------
// Secret gate
// ---------------------------------------------------------------------------

describe("handleCallback — secret gate", () => {
  it("401 on wrong secret, nothing processed", async () => {
    const res = makeRes();
    chatwootController.handleCallback(makeReq("wrong", agentEvent()), res);
    await flushImmediates();

    expect((res.sendStatus as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(401);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("401 when CHATWOOT_CALLBACK_SECRET is blank (even with a matching-looking secret)", async () => {
    envMock.CHATWOOT_CALLBACK_SECRET = undefined;
    const res = makeRes();
    chatwootController.handleCallback(makeReq("hush-hush", agentEvent()), res);
    await flushImmediates();

    expect((res.sendStatus as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(401);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("valid secret always 200, even for ignored events", async () => {
    const res = makeRes();
    chatwootController.handleCallback(
      makeReq("hush-hush", { event: "conversation_updated" }),
      res,
    );
    await flushImmediates();

    expect((res.sendStatus as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(200);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Loop-safe filter matrix
// ---------------------------------------------------------------------------

describe("handleCallback — loop-safe filter", () => {
  async function fire(body: unknown): Promise<Response> {
    const res = makeRes();
    chatwootController.handleCallback(makeReq("hush-hush", body), res);
    await flushImmediates();
    return res;
  }

  it("ignores event != message_created", async () => {
    await fire(agentEvent({ event: "conversation_created" }));
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("ignores message_type incoming", async () => {
    await fire(agentEvent({ message_type: "incoming" }));
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("ignores numeric top-level message_type (nested-shape confusion guard)", async () => {
    await fire(agentEvent({ message_type: 1 }));
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("ignores private notes", async () => {
    await fire(agentEvent({ private: true }));
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("ignores sender without a type key (contact sender on incoming events)", async () => {
    await fire(agentEvent({ sender: { id: 44, name: "Customer" } }));
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("LOOP SAFETY: ignores the Bot Mirror user's own posts (sender.id == CHATWOOT_BOT_USER_ID)", async () => {
    await fire(agentEvent({ sender: { id: 3, type: "user", name: "Bot Mirror" } }));
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("LOOP SAFETY: bot user id matches as a string too", async () => {
    await fire(agentEvent({ sender: { id: "3", type: "user" } }));
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("ignores everything when CHATWOOT_BOT_USER_ID is blank (cannot distinguish bot from human)", async () => {
    envMock.CHATWOOT_BOT_USER_ID = undefined;
    await fire(agentEvent());
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("malformed body → 200 and ignored", async () => {
    const res = await fire(null);
    expect((res.sendStatus as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(200);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Takeover forward + pause
// ---------------------------------------------------------------------------

describe("handleCallback — agent takeover", () => {
  it("forwards the agent reply to the customer and pauses the bot for 1 hour", async () => {
    const pauseBuilder = makeBuilder({ data: null, error: null });
    mockFromImpl.mockReturnValue(pauseBuilder);
    const before = Date.now();

    const res = makeRes();
    chatwootController.handleCallback(makeReq("hush-hush", agentEvent()), res);
    await flushImmediates();

    expect((res.sendStatus as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(200);
    expect(mockSendMessage).toHaveBeenCalledOnce();
    expect(mockSendMessage).toHaveBeenCalledWith("972501112233@c.us", "תשובה מהסוכן", {
      skipMirror: true,
    });

    expect(mockFromImpl).toHaveBeenCalledWith("conversations");
    const updateArg = (pauseBuilder["update"] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      bot_paused: boolean;
      bot_paused_until: string;
    };
    expect(updateArg.bot_paused).toBe(true);
    const until = new Date(updateArg.bot_paused_until).getTime();
    expect(until).toBeGreaterThanOrEqual(before + 359 * 60 * 1000);
    expect(until).toBeLessThanOrEqual(Date.now() + 361 * 60 * 1000);
    expect(pauseBuilder["eq"]).toHaveBeenCalledWith("whatsapp_chat_id", "972501112233@c.us");
  });

  it("falls back to phone_number when identifier is missing", async () => {
    const body = agentEvent({
      conversation: { meta: { sender: { phone_number: "+972549998877" } } },
    });
    const res = makeRes();
    chatwootController.handleCallback(makeReq("hush-hush", body), res);
    await flushImmediates();

    expect(mockSendMessage).toHaveBeenCalledWith("972549998877@c.us", "תשובה מהסוכן", {
      skipMirror: true,
    });
  });

  it("ignores when neither identifier nor phone_number yields a chatId", async () => {
    const body = agentEvent({
      conversation: { meta: { sender: { identifier: "not-a-chat-id" } } },
    });
    const res = makeRes();
    chatwootController.handleCallback(makeReq("hush-hush", body), res);
    await flushImmediates();

    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("ignores agent messages with no text content", async () => {
    const res = makeRes();
    chatwootController.handleCallback(
      makeReq("hush-hush", agentEvent({ content: "   " })),
      res,
    );
    await flushImmediates();

    expect(mockSendMessage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Template pass-through
// ---------------------------------------------------------------------------

describe("handleCallback — template pass-through", () => {
  function templateEvent(overrides: Record<string, unknown> = {}) {
    return agentEvent({
      content: null,
      conversation: {
        id: 55,
        meta: {
          sender: {
            identifier: "972501112233@c.us",
            phone_number: "+972501112233",
          },
        },
      },
      additional_attributes: {
        template_params: {
          name: "reminder_v1",
          category: "UTILITY",
          language: "he",
          processed_params: { body: { "1": "Dana", "2": "14:00" } },
        },
      },
      ...overrides,
    });
  }

  it("sends the template via Meta, skips sendMessage, and pauses the bot 6h", async () => {
    const pauseBuilder = makeBuilder({ data: null, error: null });
    mockFromImpl.mockReturnValue(pauseBuilder);

    const res = makeRes();
    chatwootController.handleCallback(makeReq("hush-hush", templateEvent()), res);
    await flushImmediates();

    expect(mockSendTemplate).toHaveBeenCalledWith("972501112233", {
      name: "reminder_v1",
      language: "he",
      bodyParams: ["Dana", "14:00"],
    });
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockPostPrivateNote).not.toHaveBeenCalled();

    const updateArg = (pauseBuilder["update"] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      bot_paused: boolean;
    };
    expect(updateArg.bot_paused).toBe(true);
  });

  it("on MetaSendError: posts a private note, does not pause the bot, and does not throw", async () => {
    mockSendTemplate.mockRejectedValueOnce(new MetaSendError("Re-engagement message", 131047));
    const pauseBuilder = makeBuilder({ data: null, error: null });
    mockFromImpl.mockReturnValue(pauseBuilder);

    const res = makeRes();
    chatwootController.handleCallback(makeReq("hush-hush", templateEvent()), res);
    await flushImmediates();

    expect((res.sendStatus as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(200);
    expect(mockPostPrivateNote).toHaveBeenCalledWith(
      55,
      expect.stringContaining("שליחת התבנית נכשלה"),
    );
    expect(mockPostPrivateNote.mock.calls[0]?.[1]).toContain("131047");
    expect(mockFromImpl).not.toHaveBeenCalledWith("conversations");
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("payload without template_params keeps the free-form path unchanged", async () => {
    const res = makeRes();
    chatwootController.handleCallback(makeReq("hush-hush", agentEvent()), res);
    await flushImmediates();

    expect(mockSendTemplate).not.toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalledWith("972501112233@c.us", "תשובה מהסוכן", {
      skipMirror: true,
    });
  });
});
