import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFetchRemoteFile, mockDownloadMetaMedia } = vi.hoisted(() => ({
  mockFetchRemoteFile: vi.fn(),
  mockDownloadMetaMedia: vi.fn(),
}));

vi.mock("../../config/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../lib/storage.js", () => ({ fetchRemoteFile: mockFetchRemoteFile }));
vi.mock("./meta/meta.media.js", () => ({ downloadMetaMedia: mockDownloadMetaMedia }));

import { downloadInboundMedia, resolveInboundMedia } from "./inbound-media.js";
import type { MessagePayload } from "./whatsapp.validator.js";

const BYTES = Buffer.from("file-bytes");

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDownloadMetaMedia.mockResolvedValue({ bytes: BYTES, mimeType: "image/jpeg" });
  mockFetchRemoteFile.mockResolvedValue(BYTES);
});

describe("downloadInboundMedia — one download per payload object", () => {
  it("concurrent and later callers with the same payload share a single download", async () => {
    const gate = deferred<{ bytes: Buffer; mimeType: string }>();
    mockDownloadMetaMedia.mockReturnValueOnce(gate.promise);
    const payload: MessagePayload = { kind: "image", mediaId: "m1", mimeType: "image/jpeg" };

    const mirror = downloadInboundMedia(payload);
    const idStep = resolveInboundMedia(payload);
    gate.resolve({ bytes: BYTES, mimeType: "image/jpeg" });

    await expect(mirror).resolves.toEqual({ bytes: BYTES, mimeType: "image/jpeg" });
    await expect(idStep).resolves.toBe(BYTES);
    // The Drive capture runs after the others are done — still no second download.
    await expect(resolveInboundMedia(payload)).resolves.toBe(BYTES);
    expect(mockDownloadMetaMedia).toHaveBeenCalledOnce();
  });

  it("a failed download is not remembered: the next caller downloads again", async () => {
    mockDownloadMetaMedia.mockResolvedValueOnce(null).mockResolvedValueOnce({ bytes: BYTES, mimeType: "image/jpeg" });
    const payload: MessagePayload = { kind: "image", mediaId: "m1" };

    await expect(downloadInboundMedia(payload)).resolves.toBeNull();
    await expect(downloadInboundMedia(payload)).resolves.toEqual({ bytes: BYTES, mimeType: "image/jpeg" });
    expect(mockDownloadMetaMedia).toHaveBeenCalledTimes(2);
  });

  it("callers that joined a download which then failed all see null; only a later caller retries", async () => {
    const gate = deferred<null>();
    mockDownloadMetaMedia.mockReturnValueOnce(gate.promise);
    const payload: MessagePayload = { kind: "document", mediaId: "d1" };

    const first = downloadInboundMedia(payload);
    const second = downloadInboundMedia(payload);
    gate.resolve(null);

    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toBeNull();
    expect(mockDownloadMetaMedia).toHaveBeenCalledOnce();

    await downloadInboundMedia(payload);
    expect(mockDownloadMetaMedia).toHaveBeenCalledTimes(2);
  });

  it("an unexpected throw counts as a failed download (null, retried later)", async () => {
    mockDownloadMetaMedia.mockRejectedValueOnce(new Error("boom"));
    const payload: MessagePayload = { kind: "image", mediaId: "m1" };

    await expect(downloadInboundMedia(payload)).resolves.toBeNull();
    await expect(downloadInboundMedia(payload)).resolves.not.toBeNull();
  });

  it("different payload objects never share a download", async () => {
    await downloadInboundMedia({ kind: "image", mediaId: "m1" });
    await downloadInboundMedia({ kind: "image", mediaId: "m1" });
    expect(mockDownloadMetaMedia).toHaveBeenCalledTimes(2);
  });
});

describe("downloadInboundMedia — sources and mime type", () => {
  it("GreenAPI fileUrl → fetchRemoteFile; the payload's mime, else image/jpeg for an image", async () => {
    await expect(
      downloadInboundMedia({ kind: "document", fileUrl: "https://green.example/a.pdf", mimeType: "application/pdf" }),
    ).resolves.toEqual({ bytes: BYTES, mimeType: "application/pdf" });
    await expect(downloadInboundMedia({ kind: "image", fileUrl: "https://green.example/a" })).resolves.toEqual({
      bytes: BYTES,
      mimeType: "image/jpeg",
    });
    expect(mockFetchRemoteFile).toHaveBeenCalledWith("https://green.example/a.pdf");
    expect(mockDownloadMetaMedia).not.toHaveBeenCalled();
  });

  it("a GreenAPI document without a mime type → application/octet-stream", async () => {
    await expect(downloadInboundMedia({ kind: "document", fileUrl: "https://green.example/x" })).resolves.toEqual({
      bytes: BYTES,
      mimeType: "application/octet-stream",
    });
  });

  it("a voice note (kind other + mediaId) downloads through Meta, keeping the webhook's mime", async () => {
    mockDownloadMetaMedia.mockResolvedValueOnce({ bytes: BYTES, mimeType: "audio/ogg" });
    const payload: MessagePayload = {
      kind: "other",
      subtype: "audio",
      label: "[הודעה קולית]",
      mediaId: "a1",
      mimeType: "audio/ogg; codecs=opus",
      isVoice: true,
    };

    await expect(downloadInboundMedia(payload)).resolves.toEqual({ bytes: BYTES, mimeType: "audio/ogg; codecs=opus" });
    expect(mockDownloadMetaMedia).toHaveBeenCalledWith("a1");
  });

  it("falls back to the mime Meta returned when the webhook carried none", async () => {
    mockDownloadMetaMedia.mockResolvedValueOnce({ bytes: BYTES, mimeType: "video/mp4" });
    await expect(
      downloadInboundMedia({ kind: "other", subtype: "video", label: "[וידאו]", mediaId: "v1" }),
    ).resolves.toEqual({ bytes: BYTES, mimeType: "video/mp4" });
  });

  it("Meta's octet-stream says nothing: an image still gets image/jpeg", async () => {
    mockDownloadMetaMedia.mockResolvedValueOnce({ bytes: BYTES, mimeType: "application/octet-stream" });
    await expect(downloadInboundMedia({ kind: "image", mediaId: "m1" })).resolves.toEqual({
      bytes: BYTES,
      mimeType: "image/jpeg",
    });
  });

  it("nothing to download → null without any network call", async () => {
    await expect(downloadInboundMedia({ kind: "text", text: "שלום" })).resolves.toBeNull();
    await expect(downloadInboundMedia({ kind: "other", subtype: "location", label: "[מיקום]" })).resolves.toBeNull();
    await expect(downloadInboundMedia({ kind: "image" })).resolves.toBeNull();
    expect(mockDownloadMetaMedia).not.toHaveBeenCalled();
    expect(mockFetchRemoteFile).not.toHaveBeenCalled();
  });
});

describe("resolveInboundMedia — the intake's bytes-only contract", () => {
  it("only images and documents: a voice note is not the intake's business", async () => {
    await expect(
      resolveInboundMedia({ kind: "other", subtype: "audio", label: "[הודעה קולית]", mediaId: "a1" }),
    ).resolves.toBeNull();
    expect(mockDownloadMetaMedia).not.toHaveBeenCalled();
  });

  it("returns null when the download fails", async () => {
    mockDownloadMetaMedia.mockResolvedValueOnce(null);
    await expect(resolveInboundMedia({ kind: "image", mediaId: "m1" })).resolves.toBeNull();
  });
});
