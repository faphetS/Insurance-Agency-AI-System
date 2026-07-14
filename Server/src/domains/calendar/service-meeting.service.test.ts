import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock functions
// ---------------------------------------------------------------------------
const { mockPoolQuery, mockSendMessageWithTyping } = vi.hoisted(() => ({
  mockPoolQuery: vi.fn(),
  mockSendMessageWithTyping: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks — declared before project imports
// ---------------------------------------------------------------------------
vi.mock("../../config/env.js", () => ({
  env: {
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://test",
    DATABASE_POOL_MAX: 5,
  },
}));

vi.mock("../../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../lib/db.js", () => ({
  pool: { query: mockPoolQuery },
}));

vi.mock("../whatsapp/whatsapp.service.js", () => ({
  sendMessageWithTyping: mockSendMessageWithTyping,
}));

// toChatId: real implementation strips non-digits and appends @c.us
vi.mock("../whatsapp/whatsapp.util.js", () => ({
  toChatId: (phone: string | null) => {
    if (!phone) return null;
    const digits = phone.replace(/\D/g, "");
    return digits ? `${digits}@c.us` : null;
  },
}));

// ---------------------------------------------------------------------------
// Subject import (after mocks)
// ---------------------------------------------------------------------------
import { checkServiceMeetingEligibility } from "./service-meeting.service.js";

// ---------------------------------------------------------------------------
// Tests — the biennial reminder send is DISABLED (2026-07-15): the SELECT
// still runs, but sendServiceDueToClient no-ops before any WhatsApp send or
// UPDATE.
// ---------------------------------------------------------------------------

describe("checkServiceMeetingEligibility — disabled send (no-op)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("eligible client: no send, no UPDATEs — only the SELECT runs", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ id: "client-1", full_name: "דני כהן", phone: "0501234567" }],
    });

    await checkServiceMeetingEligibility();

    expect(mockSendMessageWithTyping).not.toHaveBeenCalled();
    expect(mockPoolQuery).toHaveBeenCalledOnce();
  });

  it("no eligible rows: no sends and no updates", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    await checkServiceMeetingEligibility();

    expect(mockSendMessageWithTyping).not.toHaveBeenCalled();
    expect(mockPoolQuery).toHaveBeenCalledOnce();
  });

  it("multiple eligible clients: still no sends, no updates for any of them", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { id: "client-1", full_name: "דני כהן", phone: "0501234567" },
        { id: "client-2", full_name: "שרה לוי", phone: "0509876543" },
      ],
    });

    await checkServiceMeetingEligibility();

    expect(mockSendMessageWithTyping).not.toHaveBeenCalled();
    expect(mockPoolQuery).toHaveBeenCalledOnce();
  });
});
