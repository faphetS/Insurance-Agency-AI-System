import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — must precede subject import
// ---------------------------------------------------------------------------

const envWithCreds = {
  GREENAPI_ID_INSTANCE: "7100000001",
  GREENAPI_API_TOKEN: "test-conv-token",
  GREENAPI_BASE_URL: "https://7100.api.greenapi.com",
  GREENAPI_WEBHOOK_TOKEN: "webhook-tok",
  GREENAPI_OP_ID_INSTANCE: undefined as string | undefined,
  GREENAPI_OP_API_TOKEN: undefined as string | undefined,
  GREENAPI_OP_BASE_URL: undefined as string | undefined,
  GREENAPI_SCAN_ID_INSTANCE: undefined as string | undefined,
  GREENAPI_SCAN_API_TOKEN: undefined as string | undefined,
  GREENAPI_SCAN_BASE_URL: undefined as string | undefined,
};

vi.mock("../../config/env.js", () => ({ get env() { return envWithCreds; } }));

vi.mock("../../config/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Subject imports (after mocks)
// ---------------------------------------------------------------------------
import { sendMessage, sendInteractiveButtons, sendTyping } from "./whatsapp.service.js";
import { logger } from "../../config/logger.js";

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
// sendMessage
// ---------------------------------------------------------------------------

describe("sendMessage — GreenAPI conversational instance", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs to sendMessage endpoint with chatId + message", async () => {
    const mockFetch = mockFetchOk({ idMessage: "msg-123" });
    vi.stubGlobal("fetch", mockFetch);

    const result = await sendMessage("972500000000@c.us", "Hello");

    expect(result.idMessage).toBe("msg-123");
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/waInstance7100000001/sendMessage/test-conv-token");
    const body = JSON.parse(init.body as string) as { chatId: string; message: string };
    expect(body.chatId).toBe("972500000000@c.us");
    expect(body.message).toBe("Hello");
  });

  it("returns noop idMessage and logs warn when creds are blank", async () => {
    const saved = { ...envWithCreds };
    envWithCreds.GREENAPI_ID_INSTANCE = undefined as unknown as string;
    envWithCreds.GREENAPI_API_TOKEN = undefined as unknown as string;
    envWithCreds.GREENAPI_BASE_URL = undefined as unknown as string;

    const mockFetch = mockFetchOk({});
    vi.stubGlobal("fetch", mockFetch);

    const result = await sendMessage("972500000000@c.us", "Hi");

    expect(result.idMessage).toMatch(/^noop:/);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(vi.mocked(logger.warn)).toHaveBeenCalled();

    Object.assign(envWithCreds, saved);
  });
});

// ---------------------------------------------------------------------------
// sendInteractiveButtons — uncapped + GreenAPI shape
// ---------------------------------------------------------------------------

describe("sendInteractiveButtons — >3 buttons (uncapped)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("accepts 7 buttons and POSTs to sendInteractiveButtonsReply with correct shape", async () => {
    const mockFetch = mockFetchOk({ idMessage: "btn-msg-1" });
    vi.stubGlobal("fetch", mockFetch);

    const buttons = Array.from({ length: 7 }, (_, i) => ({
      buttonId: `opt_${i}`,
      buttonText: `Option ${i}`,
    }));

    const result = await sendInteractiveButtons("972500000000@c.us", "Pick one", buttons);

    expect(result.idMessage).toBe("btn-msg-1");
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/waInstance7100000001/sendInteractiveButtonsReply/test-conv-token");

    const body = JSON.parse(init.body as string) as {
      chatId: string;
      body: string;
      buttons: { buttonId: string; buttonText: string }[];
    };
    expect(body.chatId).toBe("972500000000@c.us");
    expect(body.body).toBe("Pick one");
    expect(body.buttons).toHaveLength(7);
    expect(body.buttons[0]).toMatchObject({ buttonId: "opt_0", buttonText: "Option 0" });
  });

  it("includes optional footer when provided", async () => {
    const mockFetch = mockFetchOk({ idMessage: "btn-msg-2" });
    vi.stubGlobal("fetch", mockFetch);

    const buttons = [{ buttonId: "a", buttonText: "A" }, { buttonId: "b", buttonText: "B" }];
    await sendInteractiveButtons("972500000000@c.us", "body", buttons, "my footer");

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.footer).toBe("my footer");
  });

  it("omits footer key when not provided", async () => {
    const mockFetch = mockFetchOk({ idMessage: "btn-msg-3" });
    vi.stubGlobal("fetch", mockFetch);

    const buttons = [{ buttonId: "a", buttonText: "A" }];
    await sendInteractiveButtons("972500000000@c.us", "body", buttons);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty("footer");
  });

  it("throws AppError(400) when no buttons provided", async () => {
    await expect(sendInteractiveButtons("972500000000@c.us", "body", [])).rejects.toMatchObject({
      statusCode: 400,
      code: "INVALID_BUTTONS",
    });
  });

  it("throws AppError(400) when a buttonText exceeds 25 chars", async () => {
    const buttons = [{ buttonId: "x", buttonText: "A".repeat(26) }];
    await expect(sendInteractiveButtons("972500000000@c.us", "body", buttons)).rejects.toMatchObject({
      statusCode: 400,
      code: "INVALID_BUTTON_TEXT",
    });
  });

  it("returns noop and logs warn when creds are blank", async () => {
    const saved = { ...envWithCreds };
    envWithCreds.GREENAPI_ID_INSTANCE = undefined as unknown as string;
    envWithCreds.GREENAPI_API_TOKEN = undefined as unknown as string;
    envWithCreds.GREENAPI_BASE_URL = undefined as unknown as string;

    const mockFetch = mockFetchOk({});
    vi.stubGlobal("fetch", mockFetch);

    const buttons = [{ buttonId: "a", buttonText: "A" }];
    const result = await sendInteractiveButtons("972500000000@c.us", "body", buttons);

    expect(result.idMessage).toMatch(/^noop:/);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(vi.mocked(logger.warn)).toHaveBeenCalled();

    Object.assign(envWithCreds, saved);
  });
});

// ---------------------------------------------------------------------------
// sendTyping — no-op when creds are blank
// ---------------------------------------------------------------------------

describe("sendTyping — creds guard", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("skips the fetch and logs warn when creds are blank", async () => {
    const saved = { ...envWithCreds };
    envWithCreds.GREENAPI_ID_INSTANCE = undefined as unknown as string;
    envWithCreds.GREENAPI_API_TOKEN = undefined as unknown as string;
    envWithCreds.GREENAPI_BASE_URL = undefined as unknown as string;

    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    await sendTyping("972500000000@c.us");

    expect(mockFetch).not.toHaveBeenCalled();
    expect(vi.mocked(logger.warn)).toHaveBeenCalled();

    Object.assign(envWithCreds, saved);
  });

  it("fires fetch when creds are set", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    await sendTyping("972500000000@c.us", 1000);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toContain("/sendTyping/test-conv-token");
  });
});
