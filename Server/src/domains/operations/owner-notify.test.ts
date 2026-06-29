import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock functions
// ---------------------------------------------------------------------------
const { mockClixSendText, mockClixSendCreds, mockToChatId } = vi.hoisted(() => ({
  mockClixSendText: vi.fn(),
  mockClixSendCreds: vi.fn(),
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

vi.mock("../whatsapp/whatsapp.clix-send.js", () => ({
  clixSendText: mockClixSendText,
  clixSendCreds: mockClixSendCreds,
}));

vi.mock("../whatsapp/whatsapp.util.js", () => ({
  toChatId: mockToChatId,
}));

// ---------------------------------------------------------------------------
// Subject import (after mocks)
// ---------------------------------------------------------------------------
import { notifyOwnerViaClix } from "./owner-notify.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const CHAT_ID = "972501234567@c.us";
const CREDS = { url: "https://clix.example.com/send", token: "tok" };

describe("notifyOwnerViaClix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClixSendText.mockResolvedValue(undefined);
    mockClixSendCreds.mockReturnValue(CREDS);
    mockToChatId.mockReturnValue(CHAT_ID);
  });

  it("returns false and does not call clixSendText when SUMMARY_RECIPIENT_PHONE is unset", async () => {
    mockToChatId.mockReturnValue(null);

    const result = await notifyOwnerViaClix("hello");

    expect(result).toBe(false);
    expect(mockClixSendText).not.toHaveBeenCalled();
  });

  it("returns false and does not call clixSendText when clixSendCreds returns null", async () => {
    mockClixSendCreds.mockReturnValue(null);

    const result = await notifyOwnerViaClix("hello");

    expect(result).toBe(false);
    expect(mockClixSendText).not.toHaveBeenCalled();
  });

  it("calls clixSendText with the correct chatId and text, returns true on success", async () => {
    const result = await notifyOwnerViaClix("test message");

    expect(result).toBe(true);
    expect(mockClixSendText).toHaveBeenCalledOnce();
    expect(mockClixSendText).toHaveBeenCalledWith(CHAT_ID, "test message");
  });

  it("returns false when clixSendText throws", async () => {
    mockClixSendText.mockRejectedValue(new Error("network error"));

    const result = await notifyOwnerViaClix("test message");

    expect(result).toBe(false);
  });
});
