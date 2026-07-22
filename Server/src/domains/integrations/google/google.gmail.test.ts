import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// vi.hoisted shared mock functions
// ---------------------------------------------------------------------------
const { mockMessagesSend, mockGetAuthenticatedClient } = vi.hoisted(() => {
  const mockMessagesSend = vi.fn();
  const mockGetAuthenticatedClient = vi.fn();
  return { mockMessagesSend, mockGetAuthenticatedClient };
});

// ---------------------------------------------------------------------------
// Module mocks (no mock of google.gmail.js — it is the module under test)
// ---------------------------------------------------------------------------
vi.mock("../../../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("googleapis", () => ({
  google: {
    gmail: vi.fn(() => ({
      users: {
        messages: {
          send: mockMessagesSend,
        },
      },
    })),
  },
}));

vi.mock("./google.auth.js", () => ({
  getAuthenticatedClient: mockGetAuthenticatedClient,
}));

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------
import { sendOwnerEmail } from "./google.gmail.js";

function decodeRawArg(): string {
  const arg = mockMessagesSend.mock.calls[0]?.[0] as { requestBody: { raw: string } };
  const base64 = arg.requestBody.raw.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64").toString("utf8");
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAuthenticatedClient.mockResolvedValue({});
  mockMessagesSend.mockResolvedValue({ data: { id: "msg-1" } });
});

describe("sendOwnerEmail — HTML RTL body", () => {
  it("sends an HTML message with dir=rtl and the escaped, line-preserved body", async () => {
    const bodyText = "שלום דידי,\nיש לך פגישה עם לקוח <VIP> & \"חשוב\" ב-15:00.";
    await sendOwnerEmail("owner@example.com", "עדכון", bodyText);

    const raw = decodeRawArg();

    expect(raw).toContain('Content-Type: text/html; charset="UTF-8"');

    // decode the base64 body payload embedded after the headers
    const [, encodedBody] = raw.split("\r\n\r\n");
    const html = Buffer.from(encodedBody!, "base64").toString("utf8");

    expect(html).toContain('dir="rtl"');
    expect(html).toContain("white-space:pre-line");
    expect(html).toContain(
      "שלום דידי,\nיש לך פגישה עם לקוח &lt;VIP&gt; &amp; &quot;חשוב&quot; ב-15:00.",
    );
    expect(html).not.toContain("<VIP>");
  });

  it("returns the sent message id and preserves subject/log behaviour", async () => {
    const result = await sendOwnerEmail("owner@example.com", "נושא", "גוף ההודעה");

    expect(result).toEqual({ id: "msg-1" });
    expect(mockMessagesSend).toHaveBeenCalledOnce();
  });
});
