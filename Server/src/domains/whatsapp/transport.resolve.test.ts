import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatwootAttachment } from "../chatwoot/chatwoot.service.js";
import type { MessagePayload } from "./whatsapp.validator.js";

const { mockMirrorInbound, mockMirrorInboundAttachment, mockDownloadInboundMedia } = vi.hoisted(() => ({
  mockMirrorInbound: vi.fn().mockResolvedValue(undefined),
  mockMirrorInboundAttachment: vi.fn().mockResolvedValue(undefined),
  mockDownloadInboundMedia: vi.fn(),
}));

vi.mock("../../config/env.js", () => ({ env: {} }));
vi.mock("../../config/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../chatwoot/chatwoot.service.js", () => ({
  mirrorInbound: mockMirrorInbound,
  mirrorInboundAttachment: mockMirrorInboundAttachment,
  mirrorOutbound: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./inbound-media.js", () => ({ downloadInboundMedia: mockDownloadInboundMedia }));

import { mirrorInboundHook } from "./transport.resolve.js";

const CHAT = "972500000000@c.us";
const BYTES = Buffer.from("file-bytes");
// "<prefix>-YYYY-MM-DD_HH-mm-ss.<ext>" in Israel time
const stamped = (prefix: string, ext: string) => new RegExp(`^${prefix}-\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2}\\.${ext}$`);

beforeEach(() => {
  vi.clearAllMocks();
  mockMirrorInbound.mockResolvedValue(undefined);
  mockMirrorInboundAttachment.mockResolvedValue(undefined);
});

/** Runs mirrorInboundHook and returns what it handed to mirrorInboundAttachment. */
async function attachmentCall(payload: MessagePayload, mime: string, senderName?: string | null) {
  mockDownloadInboundMedia.mockResolvedValue({ bytes: BYTES, mimeType: mime });
  await mirrorInboundHook(CHAT, payload, senderName);
  expect(mockMirrorInbound).not.toHaveBeenCalled();
  expect(mockMirrorInboundAttachment).toHaveBeenCalledOnce();
  const [chatId, loader, caption, fallbackText, name] = mockMirrorInboundAttachment.mock.calls[0] as [
    string,
    () => Promise<ChatwootAttachment | null>,
    string | undefined,
    string,
    string | undefined,
  ];
  return { chatId, caption, fallbackText, name, attachment: await loader() };
}

describe("mirrorInboundHook — text path", () => {
  it("prefers buttonTitle over the raw button id for the Chatwoot mirror", async () => {
    await mirrorInboundHook(
      "972500000000@c.us",
      { kind: "text", text: "meeting_didi", isButtonReply: true, buttonTitle: "בקשת תיאום פגישה עם דידי" },
    );

    expect(mockMirrorInbound).toHaveBeenCalledWith(
      "972500000000@c.us",
      "בקשת תיאום פגישה עם דידי",
      undefined,
    );
  });

  it("falls back to the raw text when buttonTitle is absent", async () => {
    await mirrorInboundHook("972500000000@c.us", { kind: "text", text: "שלום" });

    expect(mockMirrorInbound).toHaveBeenCalledWith("972500000000@c.us", "שלום", undefined);
  });

  it("mirrors the placeholder label for unsupported message types", async () => {
    await mirrorInboundHook("972500000000@c.us", { kind: "other", subtype: "audio", label: "[הודעה קולית]" });

    expect(mockMirrorInbound).toHaveBeenCalledWith("972500000000@c.us", "[הודעה קולית]", undefined);
  });

  it("a location (no file) stays on the text path", async () => {
    await mirrorInboundHook(CHAT, { kind: "other", subtype: "location", label: "[מיקום]" }, "Dana");

    expect(mockMirrorInbound).toHaveBeenCalledWith(CHAT, "[מיקום]", "Dana");
    expect(mockMirrorInboundAttachment).not.toHaveBeenCalled();
    expect(mockDownloadInboundMedia).not.toHaveBeenCalled();
  });

  it("an image message without any file reference stays on the text path", async () => {
    await mirrorInboundHook(CHAT, { kind: "image", caption: "x" });

    expect(mockMirrorInbound).toHaveBeenCalledWith(CHAT, "[תמונה]\nx", undefined);
    expect(mockMirrorInboundAttachment).not.toHaveBeenCalled();
  });
});

describe("mirrorInboundHook — attachment path", () => {
  it("voice note → audio/ogg file named voice-note-<stamp>.ogg, voice flag, the label as fallback", async () => {
    const payload: MessagePayload = {
      kind: "other",
      subtype: "audio",
      label: "[הודעה קולית]",
      mediaId: "a1",
      mimeType: "audio/ogg; codecs=opus",
      isVoice: true,
    };

    const call = await attachmentCall(payload, "audio/ogg; codecs=opus", "Dana");

    expect(call.chatId).toBe(CHAT);
    expect(call.caption).toBeUndefined();
    expect(call.fallbackText).toBe("[הודעה קולית]");
    expect(call.name).toBe("Dana");
    expect(call.attachment).toMatchObject({ bytes: BYTES, contentType: "audio/ogg", isVoice: true });
    expect(call.attachment!.fileName).toMatch(stamped("voice-note", "ogg"));
    expect(mockDownloadInboundMedia).toHaveBeenCalledWith(payload);
  });

  it("audio that is not a voice note → audio-<stamp>, no voice flag", async () => {
    const call = await attachmentCall(
      { kind: "other", subtype: "audio", label: "[הודעה קולית]", mediaId: "a2", mimeType: "audio/mpeg" },
      "audio/mpeg",
    );

    expect(call.attachment!.fileName).toMatch(stamped("audio", "mp3"));
    expect(call.attachment).not.toHaveProperty("isVoice");
  });

  it("video with a caption → caption as the text, label + caption as the fallback", async () => {
    const call = await attachmentCall(
      { kind: "other", subtype: "video", label: "[וידאו]", mediaId: "v1", mimeType: "video/mp4", caption: "הנזק לרכב" },
      "video/mp4",
    );

    expect(call.caption).toBe("הנזק לרכב");
    expect(call.fallbackText).toBe("[וידאו]\nהנזק לרכב");
    expect(call.attachment).toMatchObject({ contentType: "video/mp4" });
    expect(call.attachment!.fileName).toMatch(stamped("video", "mp4"));
  });

  it("sticker → image/webp, sticker-<stamp>.webp", async () => {
    const call = await attachmentCall(
      { kind: "other", subtype: "sticker", label: "[סטיקר]", mediaId: "s1", mimeType: "image/webp" },
      "image/webp",
    );

    expect(call.attachment).toMatchObject({ contentType: "image/webp" });
    expect(call.attachment!.fileName).toMatch(stamped("sticker", "webp"));
  });

  it("Meta photo with a caption → image-<stamp>.jpg, base mime, caption + '[תמונה]' fallback", async () => {
    const call = await attachmentCall({ kind: "image", mediaId: "m1", mimeType: "image/jpeg", caption: "תעודת זהות" }, "IMAGE/JPEG");

    expect(call.caption).toBe("תעודת זהות");
    expect(call.fallbackText).toBe("[תמונה]\nתעודת זהות");
    expect(call.attachment).toMatchObject({ contentType: "image/jpeg" });
    expect(call.attachment!.fileName).toMatch(stamped("image", "jpg"));
  });

  it("GreenAPI-style fileUrl images take the attachment path too", async () => {
    const call = await attachmentCall({ kind: "image", fileUrl: "https://green.example/x" }, "image/png");

    expect(call.attachment!.fileName).toMatch(stamped("image", "png"));
  });

  it("a document keeps the lead's own file name (Hebrew included)", async () => {
    const call = await attachmentCall(
      { kind: "document", mediaId: "d1", mimeType: "application/pdf", fileName: "פוליסת רכב 2026.pdf" },
      "application/pdf",
    );

    expect(call.fallbackText).toBe("[מסמך]");
    expect(call.attachment).toMatchObject({ contentType: "application/pdf", fileName: "פוליסת רכב 2026.pdf" });
  });

  it("a document name loses path separators, control and bidi-override characters", async () => {
    const call = await attachmentCall(
      { kind: "document", mediaId: "d1", mimeType: "application/octet-stream", fileName: " ../a\\b\u0000\n\u202Etxt.exe " },
      "application/octet-stream",
    );

    expect(call.attachment!.fileName).toBe(".._a_btxt.exe");
  });

  it("a document name without an extension gets one from the mime type (never .bin)", async () => {
    const pdf = await attachmentCall(
      { kind: "document", mediaId: "d1", mimeType: "application/pdf", fileName: "חוזה." },
      "application/pdf",
    );
    expect(pdf.attachment!.fileName).toBe("חוזה.pdf");

    vi.clearAllMocks();
    const unknown = await attachmentCall(
      { kind: "document", mediaId: "d2", mimeType: "application/octet-stream", fileName: "חוזה" },
      "application/octet-stream",
    );
    expect(unknown.attachment!.fileName).toBe("חוזה");
  });

  it.each([
    ["Policy v2.0", "Policy v2.0.pdf"],
    ["דוח 10.2026", "דוח 10.2026.pdf"],
    ["scan.0", "scan.0.pdf"],
  ])("a digits-only suffix is not an extension: %s → %s", async (fileName, expected) => {
    const call = await attachmentCall(
      { kind: "document", mediaId: "d1", mimeType: "application/pdf", fileName },
      "application/pdf",
    );

    expect(call.attachment!.fileName).toBe(expected);
  });

  it.each([
    ["x.3gp", "video/3gpp"],
    ["x.7z", "application/x-7z-compressed"],
    ["x.mp4", "video/mp4"],
  ])("a real extension with digits is kept: %s", async (fileName, mime) => {
    const call = await attachmentCall({ kind: "document", mediaId: "d1", mimeType: mime, fileName }, mime);

    expect(call.attachment!.fileName).toBe(fileName);
  });

  it("the lead's own extension wins even when the mime type disagrees", async () => {
    const call = await attachmentCall(
      { kind: "document", mediaId: "d1", mimeType: "application/pdf", fileName: "scan.jpeg" },
      "application/pdf",
    );

    expect(call.attachment).toMatchObject({ fileName: "scan.jpeg", contentType: "application/pdf" });
  });

  it("a very long document name is capped at 150 characters, keeps its extension and never splits an emoji", async () => {
    const call = await attachmentCall(
      {
        kind: "document",
        mediaId: "d1",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        fileName: `${"א".repeat(144)}😀😀😀.docx`,
      },
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );

    expect(call.attachment!.fileName).toBe(`${"א".repeat(144)}😀.docx`);
  });

  it("a document without a usable name → document-<stamp>.<ext>", async () => {
    const noName = await attachmentCall(
      { kind: "document", mediaId: "d1", mimeType: "application/vnd.ms-excel" },
      "application/vnd.ms-excel",
    );
    expect(noName.attachment!.fileName).toMatch(stamped("document", "xls"));

    vi.clearAllMocks();
    const blankName = await attachmentCall(
      { kind: "document", mediaId: "d2", mimeType: "application/zip", fileName: " \u0007 " },
      "application/zip",
    );
    expect(blankName.attachment!.fileName).toMatch(stamped("document", "zip"));
  });

  it("the download failed → the loader yields null (Chatwoot then posts the fallback text)", async () => {
    mockDownloadInboundMedia.mockResolvedValue(null);
    await mirrorInboundHook(CHAT, { kind: "image", mediaId: "m1", caption: "cap" });

    const [, loader, caption, fallbackText] = mockMirrorInboundAttachment.mock.calls[0] as [
      string,
      () => Promise<ChatwootAttachment | null>,
      string | undefined,
      string,
    ];
    expect(caption).toBe("cap");
    expect(fallbackText).toBe("[תמונה]\ncap");
    await expect(loader()).resolves.toBeNull();
  });

  it("hands the attachment over synchronously (mirror order = arrival order) and downloads only inside the loader", () => {
    void mirrorInboundHook(CHAT, { kind: "image", mediaId: "m1" });

    expect(mockMirrorInboundAttachment).toHaveBeenCalledOnce();
    expect(mockDownloadInboundMedia).not.toHaveBeenCalled();
  });
});
