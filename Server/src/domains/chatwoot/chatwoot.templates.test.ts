import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const envMock = {
  META_WABA_ID: "waba-123" as string | undefined,
  META_ACCESS_TOKEN: "meta-token" as string | undefined,
  META_GRAPH_API_VERSION: "v24.0" as string | undefined,
  CHATWOOT_BASE_URL: "https://cw.test" as string | undefined,
  CHATWOOT_ACCOUNT_ID: "1" as string | undefined,
  CHATWOOT_INBOX_ID: "2" as string | undefined,
  CHATWOOT_BOT_TOKEN: "bot-token" as string | undefined,
  CHATWOOT_ADMIN_TOKEN: undefined as string | undefined,
  CHATWOOT_TEMPLATE_HIDE: undefined as string | undefined,
};

vi.mock("../../config/env.js", () => ({ get env() { return envMock; } }));

vi.mock("../../config/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  buildTemplateSpec,
  fetchApprovedTemplates,
  syncTemplatesToChatwoot,
} from "./chatwoot.templates.js";
import { logger } from "../../config/logger.js";

function jsonResponse(status: number, body: unknown) {
  return { ok: status < 400, status, json: () => Promise.resolve(body) };
}

beforeEach(() => {
  vi.clearAllMocks();
  envMock.META_WABA_ID = "waba-123";
  envMock.META_ACCESS_TOKEN = "meta-token";
  envMock.META_GRAPH_API_VERSION = "v24.0";
  envMock.CHATWOOT_BASE_URL = "https://cw.test";
  envMock.CHATWOOT_ACCOUNT_ID = "1";
  envMock.CHATWOOT_INBOX_ID = "2";
  envMock.CHATWOOT_BOT_TOKEN = "bot-token";
  envMock.CHATWOOT_ADMIN_TOKEN = undefined;
  envMock.CHATWOOT_TEMPLATE_HIDE = undefined;
});

afterEach(() => vi.unstubAllGlobals());

// ---------------------------------------------------------------------------
// buildTemplateSpec
// ---------------------------------------------------------------------------

describe("buildTemplateSpec", () => {
  it("orders body params numerically, not lexicographically ('1','2','10')", () => {
    const spec = buildTemplateSpec({
      name: "reminder_v1",
      category: "UTILITY",
      language: "he",
      processed_params: {
        body: { "2": "second", "10": "tenth", "1": "first" },
      },
    });

    expect(spec).toEqual({
      name: "reminder_v1",
      language: "he",
      bodyParams: ["first", "second", "tenth"],
    });
  });

  it("maps header image media", () => {
    const spec = buildTemplateSpec({
      name: "welcome",
      language: "he",
      processed_params: {
        header: { media_url: "https://cdn.test/img.jpg", media_type: "image" },
        body: { "1": "Dana" },
      },
    });

    expect(spec).toEqual({
      name: "welcome",
      language: "he",
      bodyParams: ["Dana"],
      headerMedia: { type: "image", link: "https://cdn.test/img.jpg" },
    });
  });

  it("maps header document media", () => {
    const spec = buildTemplateSpec({
      name: "policy_doc",
      language: "he",
      processed_params: {
        header: { media_url: "https://cdn.test/doc.pdf", media_type: "document" },
      },
    });

    expect(spec?.headerMedia).toEqual({ type: "document", link: "https://cdn.test/doc.pdf" });
    expect(spec?.bodyParams).toBeUndefined();
  });

  it("defaults header media type to image when media_url present but type missing", () => {
    const spec = buildTemplateSpec({
      name: "welcome",
      language: "he",
      processed_params: { header: { media_url: "https://cdn.test/img.jpg" } },
    });

    expect(spec?.headerMedia).toEqual({ type: "image", link: "https://cdn.test/img.jpg" });
  });

  it("zero-params template → spec with no bodyParams/headerMedia arrays", () => {
    const spec = buildTemplateSpec({ name: "incoming_call", language: "he" });

    expect(spec).toEqual({ name: "incoming_call", language: "he" });
    expect(spec?.bodyParams).toBeUndefined();
    expect(spec?.headerMedia).toBeUndefined();
  });

  it("returns null on garbage input", () => {
    expect(buildTemplateSpec(null)).toBeNull();
    expect(buildTemplateSpec("not an object")).toBeNull();
    expect(buildTemplateSpec({ language: "he" })).toBeNull(); // missing name
    expect(buildTemplateSpec({ name: "x" })).toBeNull(); // missing language
  });
});

// ---------------------------------------------------------------------------
// fetchApprovedTemplates
// ---------------------------------------------------------------------------

describe("fetchApprovedTemplates", () => {
  it("filters out non-APPROVED templates", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        data: [
          { name: "a", status: "APPROVED" },
          { name: "b", status: "PENDING" },
          { name: "c", status: "REJECTED" },
        ],
      }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const result = await fetchApprovedTemplates();

    expect(result).toEqual([{ name: "a", status: "APPROVED" }]);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://graph.facebook.com/v24.0/waba-123/message_templates?fields=name,status,category,language,components&limit=100",
    );
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer meta-token");
  });

  it("returns null and warns when META_WABA_ID is unset", async () => {
    envMock.META_WABA_ID = undefined;
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const result = await fetchApprovedTemplates();

    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(vi.mocked(logger.warn)).toHaveBeenCalled();
  });

  it("returns null on HTTP error without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401, { error: "bad token" })));

    await expect(fetchApprovedTemplates()).resolves.toBeNull();
    expect(vi.mocked(logger.warn)).toHaveBeenCalled();
  });

  it("never throws when fetch rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    await expect(fetchApprovedTemplates()).resolves.toBeNull();
    expect(vi.mocked(logger.warn)).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// syncTemplatesToChatwoot
// ---------------------------------------------------------------------------

describe("syncTemplatesToChatwoot", () => {
  it("sends one PATCH with message_templates + agent_reply_time_window under channel.additional_attributes", async () => {
    const approved = [{ name: "a", status: "APPROVED" }];
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: approved }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 2 }));
    vi.stubGlobal("fetch", mockFetch);

    const result = await syncTemplatesToChatwoot();

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const [url, init] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("https://cw.test/api/v1/accounts/1/inboxes/2");
    expect(init.method).toBe("PATCH");
    expect((init.headers as Record<string, string>).api_access_token).toBe("bot-token");
    expect(JSON.parse(init.body as string)).toEqual({
      channel: {
        additional_attributes: {
          message_templates: approved,
          agent_reply_time_window: 24,
        },
      },
    });
  });

  it("uses CHATWOOT_ADMIN_TOKEN when set, in preference to CHATWOOT_BOT_TOKEN", async () => {
    envMock.CHATWOOT_ADMIN_TOKEN = "admin-token";
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ name: "a", status: "APPROVED" }] }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 2 }));
    vi.stubGlobal("fetch", mockFetch);

    await syncTemplatesToChatwoot();

    const [, init] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect((init.headers as Record<string, string>).api_access_token).toBe("admin-token");
  });

  it("CHATWOOT_ADMIN_TOKEN='' (present but blank) → PATCH still sent using CHATWOOT_BOT_TOKEN", async () => {
    envMock.CHATWOOT_ADMIN_TOKEN = "";
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ name: "a", status: "APPROVED" }] }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 2 }));
    vi.stubGlobal("fetch", mockFetch);

    const result = await syncTemplatesToChatwoot();

    expect(result).toBe(true);
    const [, init] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect((init.headers as Record<string, string>).api_access_token).toBe("bot-token");
  });

  it("returns false on a 401 PATCH without throwing", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ name: "a", status: "APPROVED" }] }))
      .mockResolvedValueOnce(jsonResponse(401, { error: "unauthorized" }));
    vi.stubGlobal("fetch", mockFetch);

    await expect(syncTemplatesToChatwoot()).resolves.toBe(false);
    expect(vi.mocked(logger.warn)).toHaveBeenCalled();
  });

  it("returns false without any PATCH when template fetch fails", async () => {
    envMock.META_WABA_ID = undefined;
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    await expect(syncTemplatesToChatwoot()).resolves.toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("hides templates named in CHATWOOT_TEMPLATE_HIDE from the PATCH body", async () => {
    envMock.CHATWOOT_TEMPLATE_HIDE = "ragil,hello_1_copy";
    const fetched = [
      { name: "ragil", status: "APPROVED" },
      { name: "hello_1_copy", status: "APPROVED" },
      { name: "welcome", status: "APPROVED" },
    ];
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: fetched }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 2 }));
    vi.stubGlobal("fetch", mockFetch);

    const result = await syncTemplatesToChatwoot();

    expect(result).toBe(true);
    const [, init] = mockFetch.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.channel.additional_attributes.message_templates).toEqual([
      { name: "welcome", status: "APPROVED" },
    ]);
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      { hidden: 2 },
      expect.stringContaining("2"),
    );
  });

  it("trims whitespace in CHATWOOT_TEMPLATE_HIDE entries", async () => {
    envMock.CHATWOOT_TEMPLATE_HIDE = " ragil , hello_1_copy ";
    const fetched = [
      { name: "ragil", status: "APPROVED" },
      { name: "hello_1_copy", status: "APPROVED" },
      { name: "welcome", status: "APPROVED" },
    ];
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: fetched }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 2 }));
    vi.stubGlobal("fetch", mockFetch);

    await syncTemplatesToChatwoot();

    const [, init] = mockFetch.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.channel.additional_attributes.message_templates).toEqual([
      { name: "welcome", status: "APPROVED" },
    ]);
  });

  it("syncs all templates unchanged when CHATWOOT_TEMPLATE_HIDE is unset/empty", async () => {
    envMock.CHATWOOT_TEMPLATE_HIDE = undefined;
    const fetched = [
      { name: "ragil", status: "APPROVED" },
      { name: "welcome", status: "APPROVED" },
    ];
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: fetched }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 2 }));
    vi.stubGlobal("fetch", mockFetch);

    await syncTemplatesToChatwoot();

    const [, init] = mockFetch.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.channel.additional_attributes.message_templates).toEqual(fetched);
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      { count: fetched.length },
      expect.any(String),
    );
  });

  it("is a harmless no-op when the hidden name isn't in the fetched list", async () => {
    envMock.CHATWOOT_TEMPLATE_HIDE = "does_not_exist";
    const fetched = [{ name: "welcome", status: "APPROVED" }];
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: fetched }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 2 }));
    vi.stubGlobal("fetch", mockFetch);

    await syncTemplatesToChatwoot();

    const [, init] = mockFetch.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.channel.additional_attributes.message_templates).toEqual(fetched);
    expect(vi.mocked(logger.info)).not.toHaveBeenCalledWith(
      expect.objectContaining({ hidden: expect.any(Number) }),
      expect.anything(),
    );
  });
});
