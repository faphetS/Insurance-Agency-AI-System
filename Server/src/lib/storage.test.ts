import { describe, it, expect, vi } from "vitest";

vi.mock("../config/env.js", () => ({ env: { NODE_ENV: "test" } }));
vi.mock("../config/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { extFor } from "./storage.js";

describe("extFor", () => {
  it.each([
    ["image/jpeg", "jpg"],
    ["image/png", "png"],
    ["image/webp", "webp"],
    ["image/heic", "heic"],
    ["image/heif", "heif"],
    ["image/gif", "gif"],
    ["application/pdf", "pdf"],
    ["audio/ogg", "ogg"],
    ["audio/opus", "opus"],
    ["audio/mpeg", "mp3"],
    ["audio/mp4", "m4a"],
    ["audio/aac", "aac"],
    ["audio/amr", "amr"],
    ["video/mp4", "mp4"],
    ["video/3gpp", "3gp"],
    ["video/quicktime", "mov"],
    ["text/plain", "txt"],
    ["text/csv", "csv"],
    ["application/msword", "doc"],
    ["application/vnd.ms-excel", "xls"],
    ["application/vnd.ms-powerpoint", "ppt"],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
    ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"],
    ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "pptx"],
    ["application/zip", "zip"],
  ])("%s → %s", (mime, ext) => {
    expect(extFor(mime)).toBe(ext);
  });

  it("ignores mime parameters and case (WhatsApp voice notes are 'audio/ogg; codecs=opus')", () => {
    expect(extFor("audio/ogg; codecs=opus")).toBe("ogg");
    expect(extFor("Video/MP4")).toBe("mp4");
  });

  it("the original six mime types still win over the file name's extension", () => {
    expect(extFor("application/pdf", "scan.jpeg")).toBe("pdf");
    expect(extFor("image/jpeg", "photo.png")).toBe("jpg");
    expect(extFor("image/png", "x.gif")).toBe("png");
    expect(extFor("image/webp", "sticker.bin")).toBe("webp");
    expect(extFor("image/heic", "IMG_1.JPG")).toBe("heic");
    expect(extFor("image/heif", "IMG_2.jpg")).toBe("heif");
  });

  it("the lead's own extension wins over the newer mappings, so Drive names are unchanged", () => {
    expect(extFor("application/vnd.ms-excel", "leads.csv")).toBe("csv");
    expect(extFor("text/plain", "server.LOG")).toBe("log");
    expect(extFor("audio/mp4", "memo.aac")).toBe("aac");
    expect(extFor("application/zip", "backup.7z")).toBe("7z");
    expect(extFor("image/gif", "anim.GIF")).toBe("gif");
  });

  it("the newer mappings only replace what used to be bin", () => {
    expect(extFor("application/vnd.ms-excel", "leads")).toBe("xls");
    expect(extFor("video/mp4", "clip.")).toBe("mp4");
    expect(extFor("audio/ogg; codecs=opus", null)).toBe("ogg");
  });

  it("an unknown mime falls back to the file name's extension, then to bin", () => {
    expect(extFor("application/x-unknown", "Policy.ODT")).toBe("odt");
    expect(extFor(null, "photo.jpg?token=abc")).toBe("jpg");
    expect(extFor("application/octet-stream", "no-extension")).toBe("bin");
    expect(extFor(undefined, undefined)).toBe("bin");
  });
});
