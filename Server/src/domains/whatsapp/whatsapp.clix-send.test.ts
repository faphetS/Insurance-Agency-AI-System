import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any imports that use them
// ---------------------------------------------------------------------------

vi.mock("../../config/env.js", () => ({
  env: {
    CLIX_SEND_URL: "https://gateway.example.com/functions/v1/didi-send",
    CLIX_SEND_TOKEN: "test-clix-token",
  },
}));

vi.mock("../../config/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../config/supabase.js", () => ({
  supabaseAdmin: {
    from: vi.fn(),
  },
}));

import { clixSendText, clixSendButtons, clixSendCreds } from "./whatsapp.clix-send.js";
import { resolveGatewayForChat } from "./whatsapp.service.js";
import { clixToInternal } from "./whatsapp.validator.js";
import { supabaseAdmin } from "../../config/supabase.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
    json: () => Promise.resolve(body),
  });
}

// ---------------------------------------------------------------------------
// clixSendCreds
// ---------------------------------------------------------------------------

describe("clixSendCreds", () => {
  it("returns creds when both env vars are set", () => {
    const creds = clixSendCreds();
    expect(creds).not.toBeNull();
    expect(creds!.url).toBe("https://gateway.example.com/functions/v1/didi-send");
    expect(creds!.token).toBe("test-clix-token");
  });
});

// ---------------------------------------------------------------------------
// clixSendText
// ---------------------------------------------------------------------------

describe("clixSendText", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch(200, { ok: true }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs to the Clix send URL with correct headers and body", async () => {
    await clixSendText("639123456789@c.us", "Hello");

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://gateway.example.com/functions/v1/didi-send");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer test-clix-token");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");

    const sentBody = JSON.parse(init.body as string) as { to: string; text: string };
    expect(sentBody.to).toBe("639123456789");
    expect(sentBody.text).toBe("Hello");
  });

  it("strips @c.us suffix from to", async () => {
    await clixSendText("972501234567@c.us", "Hi");
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string) as { to: string };
    expect(sentBody.to).toBe("972501234567");
  });

  it("leaves @g.us (group) address untouched", async () => {
    await clixSendText("120363123456789@g.us", "group msg");
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string) as { to: string };
    expect(sentBody.to).toBe("120363123456789@g.us");
  });

  it("leaves bare phone numbers untouched", async () => {
    await clixSendText("972501234567", "bare");
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string) as { to: string };
    expect(sentBody.to).toBe("972501234567");
  });

  it("throws AppError(502) on non-ok response", async () => {
    vi.stubGlobal("fetch", mockFetch(500, "Internal error"));
    await expect(clixSendText("639123456789", "Fail")).rejects.toMatchObject({
      statusCode: 502,
      code: "CLIX_SEND_ERROR",
    });
  });
});

// ---------------------------------------------------------------------------
// clixSendButtons
// ---------------------------------------------------------------------------

describe("clixSendButtons", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch(200, { ok: true }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps buttons from { buttonId, buttonText } → { id, text }", async () => {
    await clixSendButtons(
      "639123456789",
      "Choose one",
      [
        { buttonId: "opt_a", buttonText: "Option A" },
        { buttonId: "opt_b", buttonText: "Option B" },
      ],
    );

    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string) as {
      to: string;
      body: string;
      buttons: { id: string; text: string }[];
    };
    expect(sentBody.buttons).toEqual([
      { id: "opt_a", text: "Option A" },
      { id: "opt_b", text: "Option B" },
    ]);
    expect(sentBody.body).toBe("Choose one");
  });

  it("clamps buttonText to 25 chars", async () => {
    await clixSendButtons(
      "639123456789",
      "Pick",
      [{ buttonId: "x", buttonText: "A".repeat(30) }],
    );

    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string) as {
      buttons: { id: string; text: string }[];
    };
    expect(sentBody.buttons[0]!.text).toHaveLength(25);
  });

  it("includes optional header and footer when provided", async () => {
    await clixSendButtons(
      "639123456789",
      "Body text",
      [{ buttonId: "y", buttonText: "Yes" }],
      "My header",
      "My footer",
    );

    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sentBody.header).toBe("My header");
    expect(sentBody.footer).toBe("My footer");
  });

  it("omits header/footer when not provided", async () => {
    await clixSendButtons(
      "639123456789",
      "Body",
      [{ buttonId: "z", buttonText: "Z" }],
    );

    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sentBody).not.toHaveProperty("header");
    expect(sentBody).not.toHaveProperty("footer");
  });

  it("strips @c.us from recipient", async () => {
    await clixSendButtons(
      "972501234567@c.us",
      "B",
      [{ buttonId: "a", buttonText: "A" }],
    );

    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string) as { to: string };
    expect(sentBody.to).toBe("972501234567");
  });
});

// ---------------------------------------------------------------------------
// resolveGatewayForChat
// ---------------------------------------------------------------------------

type ChainedBuilder = {
  select: () => ChainedBuilder;
  eq: () => ChainedBuilder;
  maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
};

function makeChain(result: { data: unknown; error: unknown }): ChainedBuilder {
  const chain: ChainedBuilder = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: () => Promise.resolve(result),
  };
  return chain;
}

describe("resolveGatewayForChat", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 'clix' when conversation has a Clix instance and creds are set", async () => {
    (supabaseAdmin.from as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(makeChain({ data: { whatsapp_instance_id: "inst-1" }, error: null }))
      .mockReturnValueOnce(makeChain({ data: { gateway_customer_id: "clix-cust-1" }, error: null }));

    const result = await resolveGatewayForChat("639123456789@c.us");
    expect(result).toBe("clix");
  });

  it("returns 'greenapi' when conversation has no whatsapp_instance_id", async () => {
    (supabaseAdmin.from as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(makeChain({ data: { whatsapp_instance_id: null }, error: null }));

    const result = await resolveGatewayForChat("639123456789@c.us");
    expect(result).toBe("greenapi");
  });

  it("returns 'greenapi' when instance has no gateway_customer_id (GreenAPI instance)", async () => {
    (supabaseAdmin.from as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(makeChain({ data: { whatsapp_instance_id: "inst-2" }, error: null }))
      .mockReturnValueOnce(makeChain({ data: { gateway_customer_id: null }, error: null }));

    const result = await resolveGatewayForChat("639123456789@c.us");
    expect(result).toBe("greenapi");
  });

  it("returns 'greenapi' when conversation is not found", async () => {
    (supabaseAdmin.from as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(makeChain({ data: null, error: null }));

    const result = await resolveGatewayForChat("unknown@c.us");
    expect(result).toBe("greenapi");
  });

  it("returns 'greenapi' on DB error (fail-safe)", async () => {
    (supabaseAdmin.from as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(makeChain({ data: null, error: { message: "DB down" } }));

    const result = await resolveGatewayForChat("639123456789@c.us");
    expect(result).toBe("greenapi");
  });

  it("returns 'greenapi' when an exception is thrown (fail-safe)", async () => {
    (supabaseAdmin.from as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("unexpected crash");
    });

    const result = await resolveGatewayForChat("639123456789@c.us");
    expect(result).toBe("greenapi");
  });
});

// ---------------------------------------------------------------------------
// Button-tap JSON parsing in clixToInternal
// ---------------------------------------------------------------------------

const BASE_BUTTON_TEXT = {
  customerId: "clix-inst-1",
  type: "incoming",
  chatType: "private",
  from: "639123456789",
  pushName: "Tester",
  messageType: "text",
  timestamp: 1718900010,
};

describe("clixToInternal — button-tap JSON parsing", () => {
  it("converts {\"id\":\"opt_a\"} message to plain text opt_a", () => {
    const body = { ...BASE_BUTTON_TEXT, message: '{"id":"opt_a"}' };
    const result = clixToInternal(body);
    expect(result).not.toBeNull();
    const md = result!.payload.messageData as { textMessageData: { textMessage: string } };
    expect(md.textMessageData.textMessage).toBe("opt_a");
  });

  it("passes plain text through unchanged", () => {
    const body = { ...BASE_BUTTON_TEXT, message: "just text" };
    const result = clixToInternal(body);
    const md = result!.payload.messageData as { textMessageData: { textMessage: string } };
    expect(md.textMessageData.textMessage).toBe("just text");
  });

  it("passes non-JSON brace-starting text through unchanged", () => {
    const body = { ...BASE_BUTTON_TEXT, message: "{not valid json" };
    const result = clixToInternal(body);
    const md = result!.payload.messageData as { textMessageData: { textMessage: string } };
    expect(md.textMessageData.textMessage).toBe("{not valid json");
  });

  it("passes JSON without 'id' string field through unchanged", () => {
    const body = { ...BASE_BUTTON_TEXT, message: '{"type":"reply","value":1}' };
    const result = clixToInternal(body);
    const md = result!.payload.messageData as { textMessageData: { textMessage: string } };
    expect(md.textMessageData.textMessage).toBe('{"type":"reply","value":1}');
  });

  it("passes JSON array through unchanged", () => {
    const body = { ...BASE_BUTTON_TEXT, message: '["a","b"]' };
    const result = clixToInternal(body);
    const md = result!.payload.messageData as { textMessageData: { textMessage: string } };
    expect(md.textMessageData.textMessage).toBe('["a","b"]');
  });

  it("extracts id even when additional fields are present", () => {
    const body = { ...BASE_BUTTON_TEXT, message: '{"id":"confirm_yes","extra":"ignored"}' };
    const result = clixToInternal(body);
    const md = result!.payload.messageData as { textMessageData: { textMessage: string } };
    expect(md.textMessageData.textMessage).toBe("confirm_yes");
  });
});

// ---------------------------------------------------------------------------
// base64 vs fileUrl branch — extractPayload via clixToInternal + ClixMediaAttachment
// ---------------------------------------------------------------------------

import { extractPayload } from "./whatsapp.validator.js";
import type { ClixMediaAttachment } from "./whatsapp.validator.js";
import { incomingMessageSchema } from "./whatsapp.validator.js";

const DUMMY_INBOUND_TEXT = {
  typeWebhook: "incomingMessageReceived" as const,
  idMessage: "msg1",
  senderData: { chatId: "639123456789@c.us", senderName: "Test" },
  messageData: {
    typeMessage: "textMessage",
    textMessageData: { textMessage: "[image: id.jpg]" },
  },
};

describe("extractPayload — base64 media branch (Clix path)", () => {
  it("returns image payload with base64 when ClixMediaAttachment is passed", () => {
    const inbound = incomingMessageSchema.parse(DUMMY_INBOUND_TEXT);
    const media: ClixMediaAttachment = {
      kind: "image",
      base64: "SGVsbG8gV29ybGQ=",
      mimetype: "image/jpeg",
      fileName: "id.jpg",
      caption: "My ID",
    };

    const result = extractPayload(inbound, undefined, media);
    expect(result.kind).toBe("image");
    if (result.kind === "image" || result.kind === "document") {
      expect(result.base64).toBe("SGVsbG8gV29ybGQ=");
      expect(result.mimeType).toBe("image/jpeg");
      expect(result.fileName).toBe("id.jpg");
      expect(result.caption).toBe("My ID");
    }
  });

  it("returns document payload with base64 when ClixMediaAttachment kind is document", () => {
    const inbound = incomingMessageSchema.parse({
      ...DUMMY_INBOUND_TEXT,
      messageData: {
        typeMessage: "textMessage",
        textMessageData: { textMessage: "[document: policy.pdf]" },
      },
    });
    const media: ClixMediaAttachment = {
      kind: "document",
      base64: "AAAABBBB",
      mimetype: "application/pdf",
      fileName: "policy.pdf",
    };

    const result = extractPayload(inbound, undefined, media);
    expect(result.kind).toBe("document");
    if (result.kind === "document") {
      expect(result.base64).toBe("AAAABBBB");
    }
  });

  it("maps video kind to image kind", () => {
    const inbound = incomingMessageSchema.parse({
      ...DUMMY_INBOUND_TEXT,
      messageData: {
        typeMessage: "textMessage",
        textMessageData: { textMessage: "[video]" },
      },
    });
    const media: ClixMediaAttachment = {
      kind: "video",
      base64: "VmlkZW8=",
      mimetype: "video/mp4",
    };

    const result = extractPayload(inbound, undefined, media);
    expect(result.kind).toBe("image");
  });

  it("falls through to GreenAPI text extraction when no ClixMediaAttachment", () => {
    const inbound = incomingMessageSchema.parse({
      ...DUMMY_INBOUND_TEXT,
      messageData: {
        typeMessage: "textMessage",
        textMessageData: { textMessage: "plain text" },
      },
    });

    const result = extractPayload(inbound, undefined, null);
    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.text).toBe("plain text");
    }
  });

  it("falls through when clixMedia is undefined (GreenAPI path unchanged)", () => {
    const inbound = incomingMessageSchema.parse({
      ...DUMMY_INBOUND_TEXT,
      messageData: {
        typeMessage: "textMessage",
        textMessageData: { textMessage: "greenapi text" },
      },
    });

    const result = extractPayload(inbound);
    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.text).toBe("greenapi text");
    }
  });
});
