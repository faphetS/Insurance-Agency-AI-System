import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";
import type { Request, Response } from "express";

const { mockProcessInbound, mockFromImpl } = vi.hoisted(() => ({
  mockProcessInbound: vi.fn().mockResolvedValue(undefined),
  mockFromImpl: vi.fn(),
}));

const envMock = {
  META_VERIFY_TOKEN: "verify-me" as string | undefined,
  META_APP_SECRET: "app-secret" as string | undefined,
  NODE_ENV: "test",
};

vi.mock("../../../config/env.js", () => ({ get env() { return envMock; } }));

vi.mock("../../../config/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../../config/supabase.js", () => ({
  supabaseAdmin: { from: mockFromImpl },
}));

vi.mock("../inbound.pipeline.js", () => ({
  processInboundCustomerMessage: mockProcessInbound,
}));

import { metaWebhookController } from "./meta.webhook.controller.js";

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

function sign(raw: Buffer, secret: string): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
}

function makePostReq(body: Record<string, unknown>, opts?: { secret?: string; signature?: string }): Request {
  const raw = Buffer.from(JSON.stringify(body));
  const signature = opts?.signature ?? sign(raw, opts?.secret ?? "app-secret");
  return {
    headers: { "x-hub-signature-256": signature },
    rawBody: raw,
    body,
  } as unknown as Request;
}

function inboundEnvelope(messages: Record<string, unknown>[], contacts?: Record<string, unknown>[]) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              contacts: contacts ?? [{ profile: { name: "Meta Tester" }, wa_id: "972500000000" }],
              messages,
            },
          },
        ],
      },
    ],
  };
}

async function flushImmediates() {
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockProcessInbound.mockResolvedValue(undefined);
  envMock.META_VERIFY_TOKEN = "verify-me";
  envMock.META_APP_SECRET = "app-secret";
});

// ---------------------------------------------------------------------------
// GET handshake
// ---------------------------------------------------------------------------

describe("verifyWebhook — hub.challenge handshake", () => {
  it("echoes hub.challenge with 200 on a matching verify token", () => {
    const req = {
      query: { "hub.mode": "subscribe", "hub.verify_token": "verify-me", "hub.challenge": "challenge-123" },
    } as unknown as Request;
    const res = makeRes();

    metaWebhookController.verifyWebhook(req, res);

    expect((res.status as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(200);
    expect((res.send as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("challenge-123");
  });

  it("403 on a wrong verify token", () => {
    const req = {
      query: { "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "challenge-123" },
    } as unknown as Request;
    const res = makeRes();

    metaWebhookController.verifyWebhook(req, res);

    expect((res.sendStatus as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(403);
    expect((res.send as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("403 when META_VERIFY_TOKEN is unset (even with a matching-looking token)", () => {
    envMock.META_VERIFY_TOKEN = undefined;
    const req = {
      query: { "hub.mode": "subscribe", "hub.verify_token": "", "hub.challenge": "x" },
    } as unknown as Request;
    const res = makeRes();

    metaWebhookController.verifyWebhook(req, res);

    expect((res.sendStatus as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(403);
  });
});

// ---------------------------------------------------------------------------
// POST — signature gate
// ---------------------------------------------------------------------------

describe("handleWebhook — X-Hub-Signature-256 gate", () => {
  it("valid HMAC over the raw body → 200 and pipeline called with the mapped chatId", async () => {
    const body = inboundEnvelope([
      { from: "972500000000", id: "wamid.T1", timestamp: "1720900000", type: "text", text: { body: "שלום" } },
    ]);
    const req = makePostReq(body);
    const res = makeRes();

    metaWebhookController.handleWebhook(req, res);
    await flushImmediates();

    expect((res.sendStatus as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(200);
    expect(mockProcessInbound).toHaveBeenCalledOnce();
    expect(mockProcessInbound).toHaveBeenCalledWith({
      chatId: "972500000000@c.us",
      senderName: "Meta Tester",
      messageId: "wamid.T1",
      payload: { kind: "text", text: "שלום" },
      channel: "meta",
    });
  });

  it("invalid HMAC → 401, pipeline NOT called", async () => {
    const body = inboundEnvelope([
      { from: "972500000000", id: "wamid.T2", type: "text", text: { body: "hi" } },
    ]);
    const req = makePostReq(body, { signature: "sha256=" + "0".repeat(64) });
    const res = makeRes();

    metaWebhookController.handleWebhook(req, res);
    await flushImmediates();

    expect((res.sendStatus as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(401);
    expect(mockProcessInbound).not.toHaveBeenCalled();
  });

  it("unset META_APP_SECRET → 401", async () => {
    envMock.META_APP_SECRET = undefined;
    const body = inboundEnvelope([]);
    const req = makePostReq(body, { secret: "app-secret" });
    const res = makeRes();

    metaWebhookController.handleWebhook(req, res);
    await flushImmediates();

    expect((res.sendStatus as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(401);
    expect(mockProcessInbound).not.toHaveBeenCalled();
  });

  it("missing rawBody → 401", async () => {
    const body = inboundEnvelope([]);
    const req = {
      headers: { "x-hub-signature-256": "sha256=deadbeef" },
      body,
    } as unknown as Request;
    const res = makeRes();

    metaWebhookController.handleWebhook(req, res);

    expect((res.sendStatus as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(401);
  });
});

// ---------------------------------------------------------------------------
// POST — statuses + message batching
// ---------------------------------------------------------------------------

describe("handleWebhook — statuses and batching", () => {
  it("statuses failed → messages.status='failed' by wamid (131047 logged specially)", async () => {
    const failBuilder = makeBuilder({ data: null, error: null });
    mockFromImpl.mockReturnValue(failBuilder);

    const body = {
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                statuses: [
                  {
                    id: "wamid.OUT9",
                    status: "failed",
                    errors: [{ code: 131047, title: "Re-engagement message" }],
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const req = makePostReq(body);
    const res = makeRes();

    metaWebhookController.handleWebhook(req, res);
    await flushImmediates();

    expect(mockFromImpl).toHaveBeenCalledWith("messages");
    expect(failBuilder["update"]).toHaveBeenCalledWith({ status: "failed" });
    expect(failBuilder["eq"]).toHaveBeenCalledWith("whatsapp_message_id", "wamid.OUT9");
  });

  it("statuses read → upgrade only from sent/delivered (never downgrade)", async () => {
    const readBuilder = makeBuilder({ data: null, error: null });
    mockFromImpl.mockReturnValue(readBuilder);

    const body = {
      object: "whatsapp_business_account",
      entry: [
        { changes: [{ field: "messages", value: { statuses: [{ id: "wamid.OUT2", status: "read" }] } }] },
      ],
    };
    const req = makePostReq(body);
    const res = makeRes();

    metaWebhookController.handleWebhook(req, res);
    await flushImmediates();

    expect(readBuilder["update"]).toHaveBeenCalledWith({ status: "read" });
    expect(readBuilder["in"]).toHaveBeenCalledWith("status", ["sent", "delivered"]);
  });

  it("processes every message in a batched messages[] array", async () => {
    const body = inboundEnvelope([
      { from: "972500000000", id: "wamid.B1", type: "text", text: { body: "one" } },
      { from: "972500000000", id: "wamid.B2", type: "text", text: { body: "two" } },
      {
        from: "972500000000",
        id: "wamid.B3",
        type: "interactive",
        interactive: { type: "list_reply", list_reply: { id: "meeting_didi", title: "row" } },
      },
    ]);
    const req = makePostReq(body);
    const res = makeRes();

    metaWebhookController.handleWebhook(req, res);
    await flushImmediates();

    expect(mockProcessInbound).toHaveBeenCalledTimes(3);
    expect(mockProcessInbound.mock.calls[2]![0]).toMatchObject({
      messageId: "wamid.B3",
      payload: { kind: "text", text: "meeting_didi", isButtonReply: true },
    });
  });

  it("reaction messages are skipped, others in the batch still processed", async () => {
    const body = inboundEnvelope([
      { from: "972500000000", id: "wamid.R1", type: "reaction" },
      { from: "972500000000", id: "wamid.R2", type: "text", text: { body: "still here" } },
    ]);
    const req = makePostReq(body);
    const res = makeRes();

    metaWebhookController.handleWebhook(req, res);
    await flushImmediates();

    expect(mockProcessInbound).toHaveBeenCalledOnce();
    expect(mockProcessInbound.mock.calls[0]![0]).toMatchObject({ messageId: "wamid.R2" });
  });

  it("image message → pipeline gets a mediaId payload", async () => {
    const body = inboundEnvelope([
      {
        from: "972500000000",
        id: "wamid.IMG",
        type: "image",
        image: { id: "media-77", mime_type: "image/jpeg", caption: "תעודה" },
      },
    ]);
    const req = makePostReq(body);
    const res = makeRes();

    metaWebhookController.handleWebhook(req, res);
    await flushImmediates();

    expect(mockProcessInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "972500000000@c.us",
        payload: { kind: "image", mediaId: "media-77", mimeType: "image/jpeg", caption: "תעודה" },
        channel: "meta",
      }),
    );
  });
});
