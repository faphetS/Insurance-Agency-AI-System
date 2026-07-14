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

  it("sticker → null", () => {
    expect(extractMetaPayload(msg({ type: "sticker" }))).toBeNull();
  });

  it("unsupported → null", () => {
    expect(extractMetaPayload(msg({ type: "unsupported" }))).toBeNull();
  });

  it("unknown type → null", () => {
    expect(extractMetaPayload(msg({ type: "order" }))).toBeNull();
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
