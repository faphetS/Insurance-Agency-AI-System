import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockFromImpl, mockUploadMedia } = vi.hoisted(() => ({
  mockFromImpl: vi.fn(),
  mockUploadMedia: vi.fn(),
}));

const envMock = {
  META_ACCESS_TOKEN: "meta-test-token" as string | undefined,
  META_PHONE_NUMBER_ID: "1252996454555154" as string | undefined,
  META_GRAPH_API_VERSION: "v24.0" as string | undefined,
};

vi.mock("../../../config/env.js", () => ({ get env() { return envMock; } }));

vi.mock("../../../config/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../../config/supabase.js", () => ({
  supabaseAdmin: { from: mockFromImpl },
}));

vi.mock("./meta.transport.js", () => ({
  uploadMedia: mockUploadMedia,
  MetaSendError: class MetaSendError extends Error {},
}));

import { downloadMetaMedia, getBrandImageMediaId, invalidateBrandMediaId } from "./meta.media.js";

function makeBuilder(result: unknown) {
  const b: Record<string, unknown> = {};
  const chain = ["select", "eq", "insert", "upsert", "update", "delete"];
  for (const m of chain) b[m] = vi.fn().mockReturnValue(b);
  const terminal = vi.fn().mockResolvedValue(result);
  b["maybeSingle"] = terminal;
  b["single"] = terminal;
  b["then"] = (resolve: (v: unknown) => void) => Promise.resolve(result).then(resolve);
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

function infoResponse(url: string, mime = "image/jpeg") {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ url, mime_type: mime, id: "media-1" }),
  };
}

function bytesResponse(bytes: Buffer, contentLength?: number) {
  return {
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h === "Content-Length" && contentLength ? String(contentLength) : null) },
    arrayBuffer: () => Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
  };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  vi.unstubAllGlobals();
  envMock.META_ACCESS_TOKEN = "meta-test-token";
});

describe("downloadMetaMedia", () => {
  it("resolves id → CDN URL → Bearer download and returns bytes + mime", async () => {
    const bytes = Buffer.from("image-bytes");
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(infoResponse("https://cdn.meta.example/file1"))
      .mockResolvedValueOnce(bytesResponse(bytes));
    vi.stubGlobal("fetch", mockFetch);

    const result = await downloadMetaMedia("media-1");

    expect(result).not.toBeNull();
    expect(result!.bytes.equals(bytes)).toBe(true);
    expect(result!.mimeType).toBe("image/jpeg");

    const [infoUrl, infoInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(infoUrl).toBe("https://graph.facebook.com/v24.0/media-1");
    expect((infoInit.headers as Record<string, string>).Authorization).toBe("Bearer meta-test-token");

    const [dlUrl, dlInit] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(dlUrl).toBe("https://cdn.meta.example/file1");
    expect((dlInit.headers as Record<string, string>).Authorization).toBe("Bearer meta-test-token");
  });

  it("re-GETs the id once when the first download fails (expired URL)", async () => {
    const bytes = Buffer.from("fresh-bytes");
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(infoResponse("https://cdn.meta.example/expired"))
      .mockResolvedValueOnce({ ok: false, status: 404, headers: { get: () => null } })
      .mockResolvedValueOnce(infoResponse("https://cdn.meta.example/fresh"))
      .mockResolvedValueOnce(bytesResponse(bytes));
    vi.stubGlobal("fetch", mockFetch);

    const result = await downloadMetaMedia("media-1");

    expect(result).not.toBeNull();
    expect(result!.bytes.equals(bytes)).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect((mockFetch.mock.calls[2] as [string])[0]).toBe("https://graph.facebook.com/v24.0/media-1");
  });

  it("gives up (null) when the retry also fails", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(infoResponse("https://cdn.meta.example/a"))
      .mockResolvedValueOnce({ ok: false, status: 404, headers: { get: () => null } })
      .mockResolvedValueOnce(infoResponse("https://cdn.meta.example/b"))
      .mockResolvedValueOnce({ ok: false, status: 404, headers: { get: () => null } });
    vi.stubGlobal("fetch", mockFetch);

    expect(await downloadMetaMedia("media-1")).toBeNull();
  });

  it("rejects files over the 15MB cap via Content-Length", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(infoResponse("https://cdn.meta.example/big"))
      .mockResolvedValueOnce(bytesResponse(Buffer.from("x"), 16 * 1024 * 1024))
      .mockResolvedValueOnce(infoResponse("https://cdn.meta.example/big"))
      .mockResolvedValueOnce(bytesResponse(Buffer.from("x"), 16 * 1024 * 1024));
    vi.stubGlobal("fetch", mockFetch);

    expect(await downloadMetaMedia("media-big")).toBeNull();
  });

  it("returns null without fetching when META_ACCESS_TOKEN is blank", async () => {
    envMock.META_ACCESS_TOKEN = undefined;
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    expect(await downloadMetaMedia("media-1")).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("getBrandImageMediaId", () => {
  it("returns the id stored in system_settings without uploading", async () => {
    await invalidateBrandMediaId().catch(() => undefined);
    vi.clearAllMocks();

    setupFrom([makeBuilder({ data: { value: "stored-media-id" }, error: null })]);

    const id = await getBrandImageMediaId();

    expect(id).toBe("stored-media-id");
    expect(mockUploadMedia).not.toHaveBeenCalled();
  });

  it("memoises — second call skips the DB", async () => {
    const id = await getBrandImageMediaId();
    expect(id).toBe("stored-media-id");
    expect(mockFromImpl).not.toHaveBeenCalled();
  });

  it("invalidateBrandMediaId clears the memo and deletes the settings row", async () => {
    const deleteBuilder = makeBuilder({ data: null, error: null });
    setupFrom([deleteBuilder]);

    await invalidateBrandMediaId();

    expect(deleteBuilder["delete"]).toHaveBeenCalled();
    expect(deleteBuilder["eq"]).toHaveBeenCalledWith("key", "meta_media_id:brand.jpeg");
  });

  it("cache miss → uploads the disk asset and stores the returned id", async () => {
    await invalidateBrandMediaId().catch(() => undefined);
    vi.clearAllMocks();

    const missBuilder = makeBuilder({ data: null, error: null });
    const upsertBuilder = makeBuilder({ data: null, error: null });
    setupFrom([missBuilder, upsertBuilder]);
    mockUploadMedia.mockResolvedValue("fresh-media-id");

    const id = await getBrandImageMediaId();

    expect(id).toBe("fresh-media-id");
    expect(mockUploadMedia).toHaveBeenCalledOnce();
    const [bytes, mime] = mockUploadMedia.mock.calls[0] as [Buffer, string];
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(mime).toBe("image/jpeg");
    expect(upsertBuilder["upsert"]).toHaveBeenCalledWith(
      expect.objectContaining({ key: "meta_media_id:brand.jpeg", value: "fresh-media-id" }),
      { onConflict: "key" },
    );
  });
});
