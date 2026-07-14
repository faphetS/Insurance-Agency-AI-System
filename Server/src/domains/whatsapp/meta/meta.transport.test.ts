import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const envMock = {
  META_ACCESS_TOKEN: "meta-test-token" as string | undefined,
  META_PHONE_NUMBER_ID: "1252996454555154" as string | undefined,
  META_GRAPH_API_VERSION: "v24.0" as string | undefined,
};

vi.mock("../../../config/env.js", () => ({ get env() { return envMock; } }));

vi.mock("../../../config/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { sendText, sendInteractive, sendImage, sendTypingAndRead, MetaSendError } from "./meta.transport.js";
import { logger } from "../../../config/logger.js";

function mockFetchOk(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

function mockFetchError(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

const WA_ID = "972500000000";
const MESSAGES_RES = { messages: [{ id: "wamid.SENT1" }] };

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  vi.unstubAllGlobals();
  envMock.META_ACCESS_TOKEN = "meta-test-token";
  envMock.META_PHONE_NUMBER_ID = "1252996454555154";
});

describe("sendText", () => {
  it("POSTs to the versioned Graph messages endpoint with a Bearer header", async () => {
    const mockFetch = mockFetchOk(MESSAGES_RES);
    vi.stubGlobal("fetch", mockFetch);

    const result = await sendText(WA_ID, "שלום");

    expect(result.idMessage).toBe("wamid.SENT1");
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://graph.facebook.com/v24.0/1252996454555154/messages");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer meta-test-token");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      messaging_product: "whatsapp",
      to: WA_ID,
      type: "text",
      text: { body: "שלום" },
    });
  });

  it("returns noop idMessage and warns when creds are blank", async () => {
    envMock.META_ACCESS_TOKEN = undefined;
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const result = await sendText(WA_ID, "hi");

    expect(result.idMessage).toMatch(/^noop:/);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(vi.mocked(logger.warn)).toHaveBeenCalled();
  });

  it("parses Graph error JSON into MetaSendError with .code (131047 flagged)", async () => {
    const mockFetch = mockFetchError(400, {
      error: { message: "Re-engagement message", code: 131047 },
    });
    vi.stubGlobal("fetch", mockFetch);

    let caught: unknown;
    try {
      await sendText(WA_ID, "hi");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(MetaSendError);
    expect((caught as MetaSendError).code).toBe(131047);
    expect(vi.mocked(logger.warn)).toHaveBeenCalled();
  });

  it("parses non-131047 Graph errors and logs error-level", async () => {
    const mockFetch = mockFetchError(429, { error: { message: "rate limit hit", code: 130429 } });
    vi.stubGlobal("fetch", mockFetch);

    await expect(sendText(WA_ID, "hi")).rejects.toMatchObject({ code: 130429 });
    expect(vi.mocked(logger.error)).toHaveBeenCalled();
  });
});

describe("sendInteractive — ≤3 buttons → reply buttons", () => {
  it("sends interactive.type=button with intact ids", async () => {
    const mockFetch = mockFetchOk(MESSAGES_RES);
    vi.stubGlobal("fetch", mockFetch);

    const buttons = [
      { buttonId: "existing_client", buttonText: "לקוח קיים" },
      { buttonId: "new_client", buttonText: "לקוח חדש" },
    ];
    const result = await sendInteractive(WA_ID, "בחר", buttons);

    expect(result.idMessage).toBe("wamid.SENT1");
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      type: string;
      interactive: {
        type: string;
        body: { text: string };
        action: { buttons: { type: string; reply: { id: string; title: string } }[] };
      };
    };
    expect(body.type).toBe("interactive");
    expect(body.interactive.type).toBe("button");
    expect(body.interactive.body.text).toBe("בחר");
    expect(body.interactive.action.buttons).toEqual([
      { type: "reply", reply: { id: "existing_client", title: "לקוח קיים" } },
      { type: "reply", reply: { id: "new_client", title: "לקוח חדש" } },
    ]);
  });

  it("throws on a 21-char button title (Meta cap is 20)", async () => {
    const buttons = [{ buttonId: "x", buttonText: "A".repeat(21) }];
    await expect(sendInteractive(WA_ID, "body", buttons)).rejects.toMatchObject({
      statusCode: 400,
      code: "INVALID_BUTTON_TEXT",
    });
  });

  it("throws on empty buttons", async () => {
    await expect(sendInteractive(WA_ID, "body", [])).rejects.toMatchObject({
      statusCode: 400,
      code: "INVALID_BUTTONS",
    });
  });
});

describe("sendInteractive — >3 buttons → list message", () => {
  it("sends interactive.type=list with single section, Hebrew open button and intact row ids", async () => {
    const mockFetch = mockFetchOk(MESSAGES_RES);
    vi.stubGlobal("fetch", mockFetch);

    const buttons = Array.from({ length: 9 }, (_, i) => ({
      buttonId: `opt_${i}`,
      buttonText: `אפשרות ${i}`,
    }));
    await sendInteractive(WA_ID, "תפריט", buttons, "פוטר");

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      interactive: {
        type: string;
        footer?: { text: string };
        action: { button: string; sections: { title: string; rows: { id: string; title: string }[] }[] };
      };
    };
    expect(body.interactive.type).toBe("list");
    expect(body.interactive.action.button).toBe("בחירה מהתפריט");
    expect(body.interactive.action.sections).toHaveLength(1);
    expect(body.interactive.action.sections[0]!.title).toBe("אפשרויות");
    expect(body.interactive.action.sections[0]!.rows).toHaveLength(9);
    expect(body.interactive.action.sections[0]!.rows[0]).toEqual({ id: "opt_0", title: "אפשרות 0" });
    expect(body.interactive.footer).toEqual({ text: "פוטר" });
  });

  it("accepts an exactly-24-char row title", async () => {
    const mockFetch = mockFetchOk(MESSAGES_RES);
    vi.stubGlobal("fetch", mockFetch);

    const buttons = [
      { buttonId: "a", buttonText: "A" },
      { buttonId: "b", buttonText: "B" },
      { buttonId: "c", buttonText: "C" },
      { buttonId: "exact", buttonText: "ב".repeat(24) },
    ];
    await expect(sendInteractive(WA_ID, "body", buttons)).resolves.toMatchObject({
      idMessage: "wamid.SENT1",
    });
  });

  it("throws on a 25-char row title (Meta list cap is 24)", async () => {
    const buttons = [
      { buttonId: "a", buttonText: "A" },
      { buttonId: "b", buttonText: "B" },
      { buttonId: "c", buttonText: "C" },
      { buttonId: "long", buttonText: "ב".repeat(25) },
    ];
    await expect(sendInteractive(WA_ID, "body", buttons)).rejects.toMatchObject({
      statusCode: 400,
      code: "INVALID_BUTTON_TEXT",
    });
  });

  it("throws on more than 10 rows", async () => {
    const buttons = Array.from({ length: 11 }, (_, i) => ({
      buttonId: `o${i}`,
      buttonText: `O${i}`,
    }));
    await expect(sendInteractive(WA_ID, "body", buttons)).rejects.toMatchObject({
      statusCode: 400,
      code: "INVALID_BUTTONS",
    });
  });
});

describe("sendImage", () => {
  it("sends by media id with caption", async () => {
    const mockFetch = mockFetchOk(MESSAGES_RES);
    vi.stubGlobal("fetch", mockFetch);

    await sendImage(WA_ID, { mediaId: "media-1" }, "כיתוב");

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ type: "image", image: { id: "media-1", caption: "כיתוב" } });
  });

  it("sends by link without caption", async () => {
    const mockFetch = mockFetchOk(MESSAGES_RES);
    vi.stubGlobal("fetch", mockFetch);

    await sendImage(WA_ID, { link: "https://example.com/brand.jpeg" });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { image: Record<string, unknown> };
    expect(body.image).toEqual({ link: "https://example.com/brand.jpeg" });
  });
});

describe("sendTypingAndRead", () => {
  it("POSTs status=read + typing_indicator keyed to the wamid", async () => {
    const mockFetch = mockFetchOk({ success: true });
    vi.stubGlobal("fetch", mockFetch);

    await sendTypingAndRead("wamid.IN1");

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      messaging_product: "whatsapp",
      status: "read",
      message_id: "wamid.IN1",
      typing_indicator: { type: "text" },
    });
  });

  it("never throws — Graph errors are swallowed with a debug log", async () => {
    const mockFetch = mockFetchError(400, { error: { message: "bad wamid", code: 100 } });
    vi.stubGlobal("fetch", mockFetch);

    await expect(sendTypingAndRead("wamid.BAD")).resolves.toBeUndefined();
    expect(vi.mocked(logger.debug)).toHaveBeenCalled();
  });
});
