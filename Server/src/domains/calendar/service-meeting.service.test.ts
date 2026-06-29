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
// Tests
// ---------------------------------------------------------------------------

describe("checkServiceMeetingEligibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("eligible client + successful send: calls sendMessageWithTyping and runs both UPDATEs", async () => {
    // 1st call: SELECT
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ id: "client-1", full_name: "דני כהן", phone: "0501234567" }],
    });
    // 2nd call: UPDATE clients
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    // 3rd call: UPDATE conversations
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    mockSendMessageWithTyping.mockResolvedValueOnce(undefined);

    await checkServiceMeetingEligibility();

    // sendMessageWithTyping called with correct chatId
    expect(mockSendMessageWithTyping).toHaveBeenCalledOnce();
    const [chatId, body] = mockSendMessageWithTyping.mock.calls[0] as [string, string];
    expect(chatId).toBe("0501234567@c.us");

    // Body contains the 2-year line and NOT a reply nudge or 📅
    expect(body).toContain("עברו שנתיים");
    expect(body).not.toContain("📅");
    expect(body).not.toContain("תשיב");
    expect(body).not.toContain("מתי נוח");

    // pool.query called 3 times total
    expect(mockPoolQuery).toHaveBeenCalledTimes(3);

    // 2nd call is the clients UPDATE
    const [clientsUpdateSql] = mockPoolQuery.mock.calls[1] as [string, unknown[]];
    expect(clientsUpdateSql).toContain("last_service_reminder_at = CURRENT_DATE");
    expect(clientsUpdateSql).toContain("intake_state");

    // 3rd call is the conversations UPDATE
    const [convUpdateSql] = mockPoolQuery.mock.calls[2] as [string, unknown[]];
    expect(convUpdateSql).toContain("bot_paused = false");
  });

  it("send fails: no UPDATE queries are issued after the failed send", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ id: "client-2", full_name: "שרה לוי", phone: "0509876543" }],
    });

    mockSendMessageWithTyping.mockRejectedValueOnce(new Error("network error"));

    await checkServiceMeetingEligibility();

    // Only SELECT ran; no UPDATEs
    expect(mockPoolQuery).toHaveBeenCalledOnce();
    expect(mockSendMessageWithTyping).toHaveBeenCalledOnce();
  });

  it("no eligible rows: no sends and no updates", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    await checkServiceMeetingEligibility();

    expect(mockSendMessageWithTyping).not.toHaveBeenCalled();
    // Only the SELECT
    expect(mockPoolQuery).toHaveBeenCalledOnce();
  });
});
