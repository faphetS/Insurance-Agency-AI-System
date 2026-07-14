import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — must precede subject import
// ---------------------------------------------------------------------------

const envMock = {
  GREENAPI_WEBHOOK_TOKEN: "webhook-tok",
  GREENAPI_OP_ID_INSTANCE: undefined as string | undefined,
  GREENAPI_OP_API_TOKEN: undefined as string | undefined,
  GREENAPI_OP_BASE_URL: undefined as string | undefined,
  GREENAPI_SCAN_ID_INSTANCE: undefined as string | undefined,
  GREENAPI_SCAN_API_TOKEN: undefined as string | undefined,
  GREENAPI_SCAN_BASE_URL: undefined as string | undefined,
  GREENAPI_NOTIFY_ID_INSTANCE: undefined as string | undefined,
  GREENAPI_NOTIFY_API_TOKEN: undefined as string | undefined,
  GREENAPI_NOTIFY_BASE_URL: undefined as string | undefined,
};

vi.mock("../../config/env.js", () => ({ get env() { return envMock; } }));

vi.mock("../../config/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { mockMetaSendText, mockMetaSendInteractive, mockMirrorOutbound } = vi.hoisted(() => ({
  mockMetaSendText: vi.fn(),
  mockMetaSendInteractive: vi.fn(),
  mockMirrorOutbound: vi.fn(),
}));

vi.mock("../chatwoot/chatwoot.service.js", () => ({
  mirrorInbound: vi.fn(),
  mirrorOutbound: mockMirrorOutbound,
}));

// Intercepts the dispatcher's lazy import of the meta transport.
vi.mock("./meta/meta.transport.js", () => ({
  sendText: mockMetaSendText,
  sendInteractive: mockMetaSendInteractive,
  sendImage: vi.fn(),
  sendTypingAndRead: vi.fn(),
  uploadMedia: vi.fn(),
  metaConfigured: vi.fn(),
  MetaSendError: class MetaSendError extends Error {},
}));

// ---------------------------------------------------------------------------
// Subject imports (after mocks)
// ---------------------------------------------------------------------------
import {
  sendMessage,
  sendInteractiveButtons,
  sendTyping,
  sendMessageWithTyping,
  sendInteractiveButtonsWithTyping,
  scanCreds,
  opCreds,
  notifyCreds,
  sendMessageWith,
  sendInteractiveButtonsWith,
  getChatHistoryWith,
  lastIncomingMessagesWith,
  lastOutgoingMessagesWith,
} from "./whatsapp.service.js";

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

function mockFetchOk(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  });
}

// ---------------------------------------------------------------------------
// Senders — always dispatch via the Meta transport
// ---------------------------------------------------------------------------

describe("sendMessage — Meta-only dispatch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("routes to the meta transport", async () => {
    mockMetaSendText.mockResolvedValue({ idMessage: "wamid.TEST" });

    const result = await sendMessage("972500000000@c.us", "שלום");

    expect(result.idMessage).toBe("wamid.TEST");
    expect(mockMetaSendText).toHaveBeenCalledOnce();
    expect(mockMetaSendText).toHaveBeenCalledWith("972500000000", "שלום");
  });

  it("blank Meta creds → the meta transport's own noop (no throw)", async () => {
    mockMetaSendText.mockResolvedValue({ idMessage: "noop:123" });

    const result = await sendMessage("972500000000@c.us", "hi");

    expect(result.idMessage).toMatch(/^noop:/);
  });
});

describe("sendInteractiveButtons — Meta interactive dispatch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("routes to the meta interactive transport with buttons + footer", async () => {
    mockMetaSendInteractive.mockResolvedValue({ idMessage: "wamid.BTN" });

    const buttons = [{ buttonId: "a", buttonText: "A" }];
    const result = await sendInteractiveButtons("972500000000@c.us", "pick", buttons, "foot");

    expect(result.idMessage).toBe("wamid.BTN");
    expect(mockMetaSendInteractive).toHaveBeenCalledWith("972500000000", "pick", buttons, "foot");
  });

  it("accepts 7 buttons (uncapped at this layer — Meta transport enforces its own list cap)", async () => {
    mockMetaSendInteractive.mockResolvedValue({ idMessage: "wamid.BTN7" });

    const buttons = Array.from({ length: 7 }, (_, i) => ({
      buttonId: `opt_${i}`,
      buttonText: `Option ${i}`,
    }));

    const result = await sendInteractiveButtons("972500000000@c.us", "Pick one", buttons);

    expect(result.idMessage).toBe("wamid.BTN7");
    expect(mockMetaSendInteractive).toHaveBeenCalledWith("972500000000", "Pick one", buttons, undefined);
  });
});

describe("sendTyping / sendMessageWithTyping / sendInteractiveButtonsWithTyping", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sendTyping resolves without throwing", async () => {
    await expect(sendTyping("972500000000@c.us")).resolves.toBeUndefined();
  });

  it("sendMessageWithTyping routes to the meta transport", async () => {
    mockMetaSendText.mockResolvedValue({ idMessage: "wamid.TYPED" });

    const result = await sendMessageWithTyping("972500000000@c.us", "hello", 10);

    expect(result.idMessage).toBe("wamid.TYPED");
    expect(mockMetaSendText).toHaveBeenCalledWith("972500000000", "hello");
  });

  it("sendInteractiveButtonsWithTyping routes to the meta interactive transport", async () => {
    mockMetaSendInteractive.mockResolvedValue({ idMessage: "wamid.BTN.TYPED" });

    const buttons = [{ buttonId: "a", buttonText: "A" }];
    const result = await sendInteractiveButtonsWithTyping("972500000000@c.us", "pick", buttons, undefined, 10);

    expect(result.idMessage).toBe("wamid.BTN.TYPED");
    expect(mockMetaSendInteractive).toHaveBeenCalledWith("972500000000", "pick", buttons, undefined);
  });
});

describe("dispatcher — chatwoot mirror suppression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMetaSendText.mockResolvedValue({ idMessage: "wamid.MIRROR" });
  });

  it("default send mirrors the outbound to chatwoot", async () => {
    await sendMessage("972500000000@c.us", "bot reply");
    await new Promise((r) => setImmediate(r));

    expect(mockMirrorOutbound).toHaveBeenCalledWith("972500000000@c.us", "bot reply");
  });

  it("skipMirror suppresses the mirror-back (agent-forwarded replies)", async () => {
    await sendMessage("972500000000@c.us", "agent reply", { skipMirror: true });
    await new Promise((r) => setImmediate(r));

    expect(mockMirrorOutbound).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Explicit-creds resolvers — scanCreds / opCreds / notifyCreds + `…With`
// senders (used by op/notify/scan/timeless/commitments/unanswered-wa) —
// untouched by the Meta-only conversational dispatch change.
// ---------------------------------------------------------------------------

describe("scanCreds / opCreds / notifyCreds", () => {
  const saved = { ...envMock };
  afterEach(() => Object.assign(envMock, saved));

  it("scanCreds returns null when any of the three env vars is missing", () => {
    expect(scanCreds()).toBeNull();
  });

  it("scanCreds returns creds when all three are set", () => {
    envMock.GREENAPI_SCAN_ID_INSTANCE = "scan-id";
    envMock.GREENAPI_SCAN_API_TOKEN = "scan-tok";
    envMock.GREENAPI_SCAN_BASE_URL = "https://scan.api.greenapi.com";

    expect(scanCreds()).toEqual({
      idInstance: "scan-id",
      token: "scan-tok",
      baseUrl: "https://scan.api.greenapi.com",
    });
  });

  it("opCreds returns null when any of the three env vars is missing", () => {
    expect(opCreds()).toBeNull();
  });

  it("opCreds returns creds when all three are set", () => {
    envMock.GREENAPI_OP_ID_INSTANCE = "op-id";
    envMock.GREENAPI_OP_API_TOKEN = "op-tok";
    envMock.GREENAPI_OP_BASE_URL = "https://op.api.greenapi.com";

    expect(opCreds()).toEqual({
      idInstance: "op-id",
      token: "op-tok",
      baseUrl: "https://op.api.greenapi.com",
    });
  });

  it("notifyCreds returns null when any of the three env vars is missing", () => {
    expect(notifyCreds()).toBeNull();
  });

  it("notifyCreds returns creds when all three are set", () => {
    envMock.GREENAPI_NOTIFY_ID_INSTANCE = "notify-id";
    envMock.GREENAPI_NOTIFY_API_TOKEN = "notify-tok";
    envMock.GREENAPI_NOTIFY_BASE_URL = "https://notify.api.greenapi.com";

    expect(notifyCreds()).toEqual({
      idInstance: "notify-id",
      token: "notify-tok",
      baseUrl: "https://notify.api.greenapi.com",
    });
  });
});

const OP_CREDS = { idInstance: "op-id", token: "op-tok", baseUrl: "https://op.api.greenapi.com" };

describe("…With helpers — explicit creds, no env lookup", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sendMessageWith POSTs to sendMessage with the given creds", async () => {
    const mockFetch = mockFetchOk({ idMessage: "with-msg-1" });
    vi.stubGlobal("fetch", mockFetch);

    const result = await sendMessageWith(OP_CREDS, "972500000000@c.us", "hi");

    expect(result.idMessage).toBe("with-msg-1");
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/waInstance${OP_CREDS.idInstance}/sendMessage/${OP_CREDS.token}`);
    const body = JSON.parse(init.body as string) as { chatId: string; message: string };
    expect(body.chatId).toBe("972500000000@c.us");
    expect(body.message).toBe("hi");
  });

  it("sendInteractiveButtonsWith POSTs the GreenAPI buttons shape", async () => {
    const mockFetch = mockFetchOk({ idMessage: "with-btn-1" });
    vi.stubGlobal("fetch", mockFetch);

    const buttons = [{ buttonId: "a", buttonText: "A" }];
    const result = await sendInteractiveButtonsWith(OP_CREDS, "972500000000@c.us", "body", buttons, "footer");

    expect(result.idMessage).toBe("with-btn-1");
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.footer).toBe("footer");
  });

  it("sendInteractiveButtonsWith throws AppError(400) for empty buttons", async () => {
    await expect(
      sendInteractiveButtonsWith(OP_CREDS, "972500000000@c.us", "body", []),
    ).rejects.toMatchObject({ statusCode: 400, code: "INVALID_BUTTONS" });
  });

  it("getChatHistoryWith POSTs getChatHistory with the given creds", async () => {
    const mockFetch = mockFetchOk([]);
    vi.stubGlobal("fetch", mockFetch);

    await getChatHistoryWith(OP_CREDS, "972500000000@c.us", 5);

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/getChatHistory/");
    const body = JSON.parse(init.body as string) as { chatId: string; count: number };
    expect(body).toEqual({ chatId: "972500000000@c.us", count: 5 });
  });

  it("lastIncomingMessagesWith / lastOutgoingMessagesWith hit the journal endpoints", async () => {
    const mockFetch = mockFetchOk([]);
    vi.stubGlobal("fetch", mockFetch);

    await lastIncomingMessagesWith(OP_CREDS, 60);
    await lastOutgoingMessagesWith(OP_CREDS, 60);

    const urls = mockFetch.mock.calls.map((c) => c[0] as string);
    expect(urls[0]).toContain("/lastIncomingMessages/");
    expect(urls[1]).toContain("/lastOutgoingMessages/");
  });
});
