import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock functions
// ---------------------------------------------------------------------------
const { mockFromImpl, mockOpCreds, mockLastIncoming, mockLastOutgoing } = vi.hoisted(() => ({
  mockFromImpl: vi.fn(),
  mockOpCreds: vi.fn(),
  mockLastIncoming: vi.fn(),
  mockLastOutgoing: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks — declared before project imports
// ---------------------------------------------------------------------------
vi.mock("../../config/env.js", () => ({
  env: {
    NODE_ENV: "test",
    OP_EXCLUDED_PHONES: [] as string[],
  },
}));

vi.mock("../../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../config/supabase.js", () => ({
  supabaseAdmin: { from: mockFromImpl },
}));

vi.mock("../whatsapp/whatsapp.service.js", () => ({
  opCreds: mockOpCreds,
  lastIncomingMessagesWith: mockLastIncoming,
  lastOutgoingMessagesWith: mockLastOutgoing,
}));

// ---------------------------------------------------------------------------
// Subject import (after mocks)
// ---------------------------------------------------------------------------
import { scanRecentChats } from "./commitments.scan.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEmptySettingsBuilder() {
  const b: Record<string, unknown> = {};
  const chainMethods = ["select", "eq"];
  for (const m of chainMethods) b[m] = vi.fn().mockReturnValue(b);
  b["maybeSingle"] = vi.fn().mockResolvedValue({ data: null, error: null });
  return b;
}

describe("scanRecentChats — OP_EXCLUDED_PHONES", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockFromImpl.mockImplementation(() => makeEmptySettingsBuilder());
    mockOpCreds.mockReturnValue({ idInstance: "op-id", token: "op-token", baseUrl: "https://test.api.greenapi.com" });
    const { env } = await import("../../config/env.js");
    (env as Record<string, unknown>)["OP_EXCLUDED_PHONES"] = [];
  });

  it("excludes messages from a chat listed in OP_EXCLUDED_PHONES", async () => {
    const { env } = await import("../../config/env.js");
    (env as Record<string, unknown>)["OP_EXCLUDED_PHONES"] = ["0508946380"];

    const now = Math.floor(Date.now() / 1000);
    mockLastIncoming.mockResolvedValue([
      {
        chatId: "972508946380@c.us",
        type: "incoming",
        textMessage: "hi",
        timestamp: now,
        senderName: "Personal",
      },
      {
        chatId: "972501111111@c.us",
        type: "incoming",
        textMessage: "hello",
        timestamp: now,
        senderName: "Client",
      },
    ]);
    mockLastOutgoing.mockResolvedValue([]);

    const transcripts = await scanRecentChats();

    expect(transcripts.map((t) => t.chatId)).toEqual(["972501111111@c.us"]);
  });
});
