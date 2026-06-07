import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// vi.hoisted shared mock functions
// ---------------------------------------------------------------------------
const {
  mockMessagesSend,
  mockFromImpl,
} = vi.hoisted(() => {
  const mockMessagesSend = vi.fn().mockResolvedValue({ data: { id: "MSG1" } });
  const mockFromImpl = vi.fn();

  return { mockMessagesSend, mockFromImpl };
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock("../../../config/env.js", () => ({
  env: {
    BACKEND_URL: "http://localhost:3000",
    NODE_ENV: "test",
    GOOGLE_OAUTH_CLIENT_ID: "test-client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "test-client-secret",
    GOOGLE_OAUTH_REDIRECT_URI: "http://localhost:3000/api/integrations/gmail/callback",
  },
}));

vi.mock("../../../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../../config/supabase.js", () => ({
  supabaseAdmin: { from: mockFromImpl },
}));

// Mock googleapis entirely so no real network calls occur.
vi.mock("googleapis", () => {
  // The OAuth2 client returned by createOAuth2Client:
  // sendGmailEmail calls getValidAccessToken which calls createOAuth2Client + setCredentials.
  // We need access_token path to short-circuit (use existing token if not expired).
  const mockOAuth2Instance = {
    generateAuthUrl: vi.fn().mockReturnValue("https://accounts.google.com/oauth2"),
    getToken: vi.fn(),
    setCredentials: vi.fn(),
    refreshAccessToken: vi.fn().mockResolvedValue({
      credentials: {
        access_token: "refreshed-token",
        expiry_date: Date.now() + 3_600_000,
      },
    }),
  };

  // Must use a class/function implementation so `new OAuth2Constructor(...)` works
  class OAuth2Constructor {
    generateAuthUrl = mockOAuth2Instance.generateAuthUrl;
    getToken = mockOAuth2Instance.getToken;
    setCredentials = mockOAuth2Instance.setCredentials;
    refreshAccessToken = mockOAuth2Instance.refreshAccessToken;
  }

  const mockGmailClient = {
    users: {
      messages: {
        send: mockMessagesSend,
        list: vi.fn().mockResolvedValue({ data: { messages: [] } }),
        get: vi.fn(),
      },
      getProfile: vi.fn().mockResolvedValue({ data: { emailAddress: "owner@agency.com" } }),
    },
  };

  return {
    google: {
      auth: { OAuth2: OAuth2Constructor },
      gmail: vi.fn().mockReturnValue(mockGmailClient),
    },
  };
});

// ---------------------------------------------------------------------------
// Builder shim helpers
// ---------------------------------------------------------------------------
type Builder = Record<string, unknown>;

function makeBuilder(result: unknown): Builder {
  const terminal = vi.fn().mockResolvedValue(result);
  const builder: Builder = {};
  const chainMethods = [
    "select", "eq", "neq", "is", "not", "in", "gte", "lte",
    "order", "insert", "upsert", "update", "limit",
  ];
  for (const m of chainMethods) {
    builder[m] = vi.fn().mockReturnValue(builder);
  }
  builder["maybeSingle"] = terminal;
  builder["single"] = terminal;
  builder["then"] = (onFulfilled: (v: unknown) => unknown) => Promise.resolve(result).then(onFulfilled);
  return builder;
}

function setupFromSequence(builders: Builder[]): void {
  let callIndex = 0;
  mockFromImpl.mockImplementation(() => {
    const b = builders[callIndex] ?? builders[builders.length - 1];
    callIndex++;
    return b;
  });
}

// ---------------------------------------------------------------------------
// Imports under test
// ---------------------------------------------------------------------------
import { sendGmailEmail, getOwnerGmailIntegration } from "./gmail.service.js";
import type { GmailIntegration } from "./gmail.types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function decodeBase64Url(encoded: string): string {
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf-8");
}

function makeIntegration(overrides: Partial<GmailIntegration> = {}): GmailIntegration {
  return {
    id: "int-1",
    staff_id: "staff-owner",
    email: "owner@agency.com",
    refresh_token: "rtoken",
    // access_token set to a valid future expiry so getValidAccessToken returns it directly
    access_token: "valid-access-token",
    access_token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    scope: "https://www.googleapis.com/auth/gmail.send",
    connected_at: new Date().toISOString(),
    last_synced_at: null,
    last_unread_count: null,
    last_error: null,
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// sendGmailEmail tests
// ---------------------------------------------------------------------------
describe("sendGmailEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMessagesSend.mockResolvedValue({ data: { id: "MSG1" } });
  });

  it("returns { id: 'MSG1' } from the Gmail API response", async () => {
    const integration = makeIntegration();
    const result = await sendGmailEmail(
      integration,
      "client@example.com",
      "סיכום הפגישה שלך",
      "תוכן הסיכום",
    );
    expect(result).toEqual({ id: "MSG1" });
  });

  it("passes raw base64url to messages.send and the decoded RFC822 contains required headers", async () => {
    const integration = makeIntegration();
    const hebrewSubject = "סיכום הפגישה שלך";
    const hebrewBody = "שלום, זה סיכום הפגישה שלך.";
    const toAddress = "recipient@example.com";

    await sendGmailEmail(integration, toAddress, hebrewSubject, hebrewBody);

    expect(mockMessagesSend).toHaveBeenCalledOnce();
    const callArg = mockMessagesSend.mock.calls[0][0] as {
      userId: string;
      requestBody: { raw: string };
    };
    expect(callArg.userId).toBe("me");

    const rawBase64url = callArg.requestBody.raw;
    // Verify it's a valid base64url string (no +, /, or = padding)
    expect(rawBase64url).not.toMatch(/[+/=]/);

    const decoded = decodeBase64Url(rawBase64url);

    // Required headers
    expect(decoded).toContain(`From: ${integration.email}`);
    expect(decoded).toContain(`To: ${toAddress}`);
    expect(decoded).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(decoded).toContain("MIME-Version: 1.0");
    expect(decoded).toContain("Content-Transfer-Encoding: base64");

    // Subject must be UTF-8 base64 encoded (RFC 2047 format)
    const subjectLine = decoded
      .split("\r\n")
      .find((line) => line.startsWith("Subject:")) ?? "";
    expect(subjectLine).toMatch(/^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/]+=*\?=$/);

    // Decode the B-encoded subject and verify it equals the original Hebrew text
    const bEncoded = subjectLine.match(/=\?UTF-8\?B\?([A-Za-z0-9+/]+=*)\?=/)?.[1];
    expect(bEncoded).toBeTruthy();
    const decodedSubject = Buffer.from(bEncoded!, "base64").toString("utf-8");
    expect(decodedSubject).toBe(hebrewSubject);

    // Body section: the last segment after the blank line is base64-encoded body
    const blankLineIdx = decoded.indexOf("\r\n\r\n");
    expect(blankLineIdx).toBeGreaterThan(-1);
    const bodySection = decoded.slice(blankLineIdx + 4).trim();
    const decodedBodyText = Buffer.from(bodySection, "base64").toString("utf-8");
    expect(decodedBodyText).toBe(hebrewBody);
  });

  it("handles empty string body gracefully", async () => {
    const integration = makeIntegration();
    const result = await sendGmailEmail(integration, "to@example.com", "נושא", "");
    expect(result).toEqual({ id: "MSG1" });
    expect(mockMessagesSend).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// getOwnerGmailIntegration tests
// ---------------------------------------------------------------------------
describe("getOwnerGmailIntegration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when no owner staff found", async () => {
    const staffBuilder = makeBuilder({ data: null, error: null });
    setupFromSequence([staffBuilder]);

    const result = await getOwnerGmailIntegration();
    expect(result).toBeNull();
  });

  it("returns null when owner exists but has no active integration", async () => {
    const staffBuilder = makeBuilder({ data: { id: "staff-owner" }, error: null });
    const integrationBuilder = makeBuilder({ data: null, error: null });
    setupFromSequence([staffBuilder, integrationBuilder]);

    const result = await getOwnerGmailIntegration();
    expect(result).toBeNull();
  });

  it("returns the integration row when owner and active integration exist", async () => {
    const fakeIntegration = makeIntegration({ staff_id: "staff-owner" });
    const staffBuilder = makeBuilder({ data: { id: "staff-owner" }, error: null });
    const integrationBuilder = makeBuilder({ data: fakeIntegration, error: null });
    setupFromSequence([staffBuilder, integrationBuilder]);

    const result = await getOwnerGmailIntegration();
    expect(result).toEqual(fakeIntegration);
  });

  it("queries staff table with role=owner and is_active=true", async () => {
    const staffBuilder = makeBuilder({ data: null, error: null });
    setupFromSequence([staffBuilder]);

    await getOwnerGmailIntegration();

    expect(mockFromImpl).toHaveBeenCalledWith("staff");
    const staffSelectFn = staffBuilder["select"] as ReturnType<typeof vi.fn>;
    expect(staffSelectFn).toHaveBeenCalledWith("id");

    const staffEqFn = staffBuilder["eq"] as ReturnType<typeof vi.fn>;
    // First eq call: role = owner
    expect(staffEqFn).toHaveBeenCalledWith("role", "owner");
    // Second eq call: is_active = true
    expect(staffEqFn).toHaveBeenCalledWith("is_active", true);
  });
});
