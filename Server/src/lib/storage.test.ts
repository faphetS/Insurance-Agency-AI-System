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

  it("the mime type wins over the file name's extension", () => {
    expect(extFor("application/pdf", "scan.jpeg")).toBe("pdf");
  });

  it("an unknown mime falls back to the file name's extension, then to bin", () => {
    expect(extFor("application/x-unknown", "Policy.ODT")).toBe("odt");
    expect(extFor(null, "photo.jpg?token=abc")).toBe("jpg");
    expect(extFor("application/octet-stream", "no-extension")).toBe("bin");
    expect(extFor(undefined, undefined)).toBe("bin");
  });
});
