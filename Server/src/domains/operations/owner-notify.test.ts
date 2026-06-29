import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock functions
// ---------------------------------------------------------------------------
const { mockSendMessage, mockToChatId } = vi.hoisted(() => ({
  mockSendMessage: vi.fn(),
  mockToChatId: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock("../../config/env.js", () => ({
  env: {
    NODE_ENV: "test",
    SUMMARY_RECIPIENT_PHONE: "0501234567",
  },
}));

vi.mock("../../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../whatsapp/whatsapp.service.js", () => ({
  sendMessage: mockSendMessage,
}));

vi.mock("../whatsapp/whatsapp.util.js", () => ({
  toChatId: mockToChatId,
}));

// ---------------------------------------------------------------------------
// Subject import (after mocks)
// ---------------------------------------------------------------------------
import { notifyOwner } from "./owner-notify.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const CHAT_ID = "972501234567@c.us";

describe("notifyOwner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendMessage.mockResolvedValue({ idMessage: "msg-1" });
    mockToChatId.mockReturnValue(CHAT_ID);
  });

  it("returns false and does not call sendMessage when SUMMARY_RECIPIENT_PHONE is unset", async () => {
    mockToChatId.mockReturnValue(null);

    const result = await notifyOwner("hello");

    expect(result).toBe(false);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("calls sendMessage with the correct chatId and text, returns true on success", async () => {
    const result = await notifyOwner("test message");

    expect(result).toBe(true);
    expect(mockSendMessage).toHaveBeenCalledOnce();
    expect(mockSendMessage).toHaveBeenCalledWith(CHAT_ID, "test message");
  });

  it("returns true when sendMessage returns a noop idMessage (blank creds)", async () => {
    mockSendMessage.mockResolvedValue({ idMessage: "noop:12345" });

    const result = await notifyOwner("test message");

    expect(result).toBe(true);
  });

  it("returns false when sendMessage throws", async () => {
    mockSendMessage.mockRejectedValue(new Error("network error"));

    const result = await notifyOwner("test message");

    expect(result).toBe(false);
  });
});
