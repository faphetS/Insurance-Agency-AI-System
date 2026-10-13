import { describe, it, expect } from "vitest";
import {
  extractMetaPayload,
  metaWebhookSchema,
  waIdToChatId,
  chatIdToWaId,
  type MetaMessage,
} from "./meta.validator.js";

function msg(overrides: Record<string, unknown>): MetaMessage {
  return { from: "972500000000", id: "wamid.ABC", type: "text", ...overrides } as MetaMessage;
}

describe("waId <-> chatId mapping", () => {
  it("waIdToChatId appends @c.us", () => {
    expect(waIdToChatId("972500000000")).toBe("972500000000@c.us");
  });

  it("chatIdToWaId strips the suffix", () => {
    expect(chatIdToWaId("972500000000@c.us")).toBe("972500000000");
  });

  it("chatIdToWaId passes through a bare id", () => {
    expect(chatIdToWaId("972500000000")).toBe("972500000000");
  });

  it("round-trips", () => {
    expect(chatIdToWaId(waIdToChatId("639219909210"))).toBe("639219909210");
  });
});

describe("extractMetaPayload", () => {
  it("text → kind:text", () => {
    const payload = extractMetaPayload(msg({ type: "text", text: { body: "שלום" } }));
    expect(payload).toEqual({ kind: "text", text: "שלום" });
  });

  it("list_reply → kind:text with the row id + isButtonReply", () => {
    const payload = extractMetaPayload(
      msg({
        type: "interactive",
        interactive: { type: "list_reply", list_reply: { id: "meeting_didi", title: "בקשת תיאום פגישה עם דידי" } },
      }),
    );
    expect(payload).toEqual({
      kind: "text",
      text: "meeting_didi",
      isButtonReply: true,
      buttonTitle: "בקשת תיאום פגישה עם דידי",
    });
  });

  it("button_reply → kind:text with the button id + isButtonReply", () => {
    const payload = extractMetaPayload(
      msg({
        type: "interactive",
        interactive: { type: "button_reply", button_reply: { id: "consent_approve", title: "מאשר" } },
      }),
    );
    expect(payload).toEqual({
      kind: "text",
      text: "consent_approve",
      isButtonReply: true,
      buttonTitle: "מאשר",
    });
  });

  it("image → kind:image with mediaId (no fileUrl)", () => {
    const payload = extractMetaPayload(
      msg({
        type: "image",
        image: { id: "media-123", mime_type: "image/jpeg", caption: "תז" },
      }),
    );
    expect(payload).toEqual({
      kind: "image",
      mediaId: "media-123",
      mimeType: "image/jpeg",
      caption: "תז",
    });
  });

  it("document → kind:document with fileName from document.filename", () => {
    const payload = extractMetaPayload(
      msg({
        type: "document",
        document: { id: "media-456", mime_type: "application/pdf", filename: "id.pdf" },
      }),
    );
    expect(payload).toEqual({
      kind: "document",
      mediaId: "media-456",
      mimeType: "application/pdf",
      fileName: "id.pdf",
      caption: undefined,
    });
  });

  it("reaction → null (explicit ignore)", () => {
    expect(extractMetaPayload(msg({ type: "reaction" }))).toBeNull();
  });

  it("sticker → kind:other with the sticker label", () => {
    expect(extractMetaPayload(msg({ type: "sticker" }))).toEqual({
      kind: "other",
      subtype: "sticker",
      label: "[סטיקר]",
    });
  });

  it("voice note (audio, voice:true) → kind:other with the voice label, media id, mime and isVoice", () => {
    expect(
      extractMetaPayload(
        msg({ type: "audio", audio: { id: "m1", mime_type: "audio/ogg; codecs=opus", sha256: "abc", voice: true } }),
      ),
    ).toEqual({
      kind: "other",
      subtype: "audio",
      label: "[הודעה קולית]",
      mediaId: "m1",
      mimeType: "audio/ogg; codecs=opus",
      isVoice: true,
    });
  });

  it("audio that is not a voice note → no isVoice", () => {
    expect(extractMetaPayload(msg({ type: "audio", audio: { id: "m2", mime_type: "audio/mpeg", voice: false } }))).toEqual({
      kind: "other",
      subtype: "audio",
      label: "[הודעה קולית]",
      mediaId: "m2",
      mimeType: "audio/mpeg",
    });
  });

  it("video with a caption → media id, mime and caption", () => {
    expect(
      extractMetaPayload(msg({ type: "video", video: { id: "v1", mime_type: "video/mp4", caption: "הרכב אחרי התאונה" } })),
    ).toEqual({
      kind: "other",
      subtype: "video",
      label: "[וידאו]",
      mediaId: "v1",
      mimeType: "video/mp4",
      caption: "הרכב אחרי התאונה",
    });
  });

  it("video with an empty / blank caption → no caption field", () => {
    expect(extractMetaPayload(msg({ type: "video", video: { id: "v1", mime_type: "video/mp4", caption: "" } }))).not.toHaveProperty(
      "caption",
    );
    expect(extractMetaPayload(msg({ type: "video", video: { id: "v1", caption: "   " } }))).not.toHaveProperty("caption");
  });

  it("sticker with an id → media id + image/webp, never a caption or isVoice", () => {
    expect(
      extractMetaPayload(msg({ type: "sticker", sticker: { id: "s1", mime_type: "image/webp", animated: false, caption: "x" } })),
    ).toEqual({
      kind: "other",
      subtype: "sticker",
      label: "[סטיקר]",
      mediaId: "s1",
      mimeType: "image/webp",
    });
  });

  it("audio / video / sticker without a usable id → exactly the label-only payload", () => {
    const labelOnly = (subtype: string, label: string) => ({ kind: "other", subtype, label });
    expect(extractMetaPayload(msg({ type: "audio", audio: { mime_type: "audio/ogg", voice: true } }))).toEqual(
      labelOnly("audio", "[הודעה קולית]"),
    );
    expect(extractMetaPayload(msg({ type: "video", video: { id: "", caption: "hi" } }))).toEqual(labelOnly("video", "[וידאו]"));
    expect(extractMetaPayload(msg({ type: "sticker", sticker: { id: "   " } }))).toEqual(labelOnly("sticker", "[סטיקר]"));
    expect(extractMetaPayload(msg({ type: "audio", audio: { id: 12345, voice: true } }))).toEqual(
      labelOnly("audio", "[הודעה קולית]"),
    );
  });

  it("odd field types next to a valid id are dropped, not trusted", () => {
    expect(
      extractMetaPayload(msg({ type: "audio", audio: { id: "m3", mime_type: 7, voice: "true" } })),
    ).toEqual({ kind: "other", subtype: "audio", label: "[הודעה קולית]", mediaId: "m3" });
    expect(extractMetaPayload(msg({ type: "video", video: { id: "v3", caption: { text: "x" } } }))).toEqual({
      kind: "other",
      subtype: "video",
      label: "[וידאו]",
      mediaId: "v3",
    });
  });

  it("video / location / contacts → their labels", () => {
    expect(extractMetaPayload(msg({ type: "video" }))).toMatchObject({ kind: "other", label: "[וידאו]" });
    expect(extractMetaPayload(msg({ type: "location" }))).toMatchObject({ kind: "other", label: "[מיקום]" });
    expect(extractMetaPayload(msg({ type: "contacts" }))).toMatchObject({ kind: "other", label: "[איש קשר]" });
  });

  it("unsupported and unknown types → the generic label", () => {
    expect(extractMetaPayload(msg({ type: "unsupported" }))).toEqual({
      kind: "other",
      subtype: "unsupported",
      label: "[הודעה לא נתמכת]",
    });
    expect(extractMetaPayload(msg({ type: "order" }))).toMatchObject({ kind: "other", subtype: "order" });
  });

  it("request_welcome → null (an 'opened the chat' event, not a message)", () => {
    expect(extractMetaPayload(msg({ type: "request_welcome" }))).toBeNull();
  });

  it("system → null (a number / identity change notice, not a message)", () => {
    expect(extractMetaPayload(msg({ type: "system", system: { type: "user_changed_number" } }))).toBeNull();
    expect(extractMetaPayload(msg({ type: "system", system: { type: "customer_identity_changed" } }))).toBeNull();
  });

  it("template quick-reply (type button) → a button tap with the payload as id", () => {
    expect(
      extractMetaPayload(msg({ type: "button", button: { payload: "callback_didi", text: "אשמח שדידי יחזור אליי" } })),
    ).toEqual({ kind: "text", text: "callback_didi", isButtonReply: true, buttonTitle: "אשמח שדידי יחזור אליי" });
  });

  it("template quick-reply without payload falls back to the visible text", () => {
    expect(extractMetaPayload(msg({ type: "button", button: { text: "מאשר" } }))).toEqual({
      kind: "text",
      text: "מאשר",
      isButtonReply: true,
      buttonTitle: "מאשר",
    });
  });

  it("template quick-reply with an EMPTY payload also falls back to the visible text", () => {
    expect(extractMetaPayload(msg({ type: "button", button: { payload: "", text: "מאשר" } }))).toMatchObject({
      kind: "text",
      text: "מאשר",
      isButtonReply: true,
    });
  });

  it("template quick-reply with neither payload nor text → placeholder, never silently dropped", () => {
    expect(extractMetaPayload(msg({ type: "button", button: {} }))).toEqual({
      kind: "other",
      subtype: "button",
      label: "[הודעה לא נתמכת]",
    });
  });

  it("an inherited object key as the type gets the generic label, not a prototype value", () => {
    expect(extractMetaPayload(msg({ type: "constructor" }))).toEqual({
      kind: "other",
      subtype: "constructor",
      label: "[הודעה לא נתמכת]",
    });
  });
});

describe("metaWebhookSchema", () => {
  it("parses a real-shaped inbound envelope", () => {
    const body = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "1527714045703086",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "15551887018", phone_number_id: "1252996454555154" },
                contacts: [{ profile: { name: "Test User" }, wa_id: "972500000000" }],
                messages: [
                  { from: "972500000000", id: "wamid.X", timestamp: "1720900000", type: "text", text: { body: "hi" } },
                ],
              },
            },
          ],
        },
      ],
    };
    const parsed = metaWebhookSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.entry?.[0]?.changes?.[0]?.value.messages?.[0]?.id).toBe("wamid.X");
    }
  });

  function envelope(messages: unknown[]) {
    return {
      object: "whatsapp_business_account",
      entry: [{ id: "1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", messages } }] }],
    };
  }

  it("parses real-shaped voice note, video and sticker messages and keeps their media fields", () => {
    const parsed = metaWebhookSchema.safeParse(
      envelope([
        {
          from: "972500000000",
          id: "wamid.A",
          type: "audio",
          audio: { id: "m1", mime_type: "audio/ogg; codecs=opus", sha256: "h", voice: true },
        },
        { from: "972500000000", id: "wamid.V", type: "video", video: { id: "v1", mime_type: "video/mp4", sha256: "h", caption: "צילום" } },
        { from: "972500000000", id: "wamid.S", type: "sticker", sticker: { id: "s1", mime_type: "image/webp", sha256: "h", animated: true } },
      ]),
    );

    expect(parsed.success).toBe(true);
    const messages = parsed.success ? parsed.data.entry![0]!.changes![0]!.value.messages! : [];
    expect(messages.map(extractMetaPayload)).toEqual([
      { kind: "other", subtype: "audio", label: "[הודעה קולית]", mediaId: "m1", mimeType: "audio/ogg; codecs=opus", isVoice: true },
      { kind: "other", subtype: "video", label: "[וידאו]", mediaId: "v1", mimeType: "video/mp4", caption: "צילום" },
      { kind: "other", subtype: "sticker", label: "[סטיקר]", mediaId: "s1", mimeType: "image/webp" },
    ]);
  });

  it("odd audio / video / sticker shapes never fail the whole webhook — they fall back to the label", () => {
    const odd = [
      { from: "972500000000", id: "wamid.1", type: "audio", audio: "not-an-object" },
      { from: "972500000000", id: "wamid.2", type: "video", video: null },
      { from: "972500000000", id: "wamid.3", type: "sticker", sticker: [1, 2] },
      { from: "972500000000", id: "wamid.4", type: "audio", audio: { id: 42, mime_type: ["x"], voice: "yes" } },
      { from: "972500000000", id: "wamid.5", type: "video", video: { caption: 9 } },
      { from: "972500000000", id: "wamid.6", type: "text", text: { body: "still delivered" } },
    ];

    const parsed = metaWebhookSchema.safeParse(envelope(odd));

    expect(parsed.success).toBe(true);
    const messages = parsed.success ? parsed.data.entry![0]!.changes![0]!.value.messages! : [];
    expect(messages.map(extractMetaPayload)).toEqual([
      { kind: "other", subtype: "audio", label: "[הודעה קולית]" },
      { kind: "other", subtype: "video", label: "[וידאו]" },
      { kind: "other", subtype: "sticker", label: "[סטיקר]" },
      { kind: "other", subtype: "audio", label: "[הודעה קולית]" },
      { kind: "other", subtype: "video", label: "[וידאו]" },
      { kind: "text", text: "still delivered" },
    ]);
  });

  it("parses a statuses-only envelope", () => {
    const body = {
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                statuses: [
                  {
                    id: "wamid.OUT",
                    status: "failed",
                    recipient_id: "972500000000",
                    errors: [{ code: 131047, title: "Re-engagement message" }],
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const parsed = metaWebhookSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.entry?.[0]?.changes?.[0]?.value.statuses?.[0]?.errors?.[0]?.code).toBe(131047);
    }
  });
});
