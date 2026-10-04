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

  it("voice note (audio) → kind:other with the voice label", () => {
    expect(extractMetaPayload(msg({ type: "audio", audio: { id: "m1", voice: true } }))).toEqual({
      kind: "other",
      subtype: "audio",
      label: "[הודעה קולית]",
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
