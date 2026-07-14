import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock functions
// ---------------------------------------------------------------------------
const { mockSendMessage, mockToChatId, mockNotifyCreds, mockSendMessageWith } = vi.hoisted(() => ({
  mockSendMessage: vi.fn(),
  mockToChatId: vi.fn(),
  mockNotifyCreds: vi.fn(),
  mockSendMessageWith: vi.fn(),
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
  notifyCreds: mockNotifyCreds,
  sendMessageWith: mockSendMessageWith,
}));

vi.mock("../whatsapp/whatsapp.util.js", () => ({
  toChatId: mockToChatId,
}));

// ---------------------------------------------------------------------------
// Subject import (after mocks)
// ---------------------------------------------------------------------------
import { notifyOwner, notifyOwnerOps } from "./owner-notify.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const CHAT_ID = "972501234567@c.us";
const NOTIFY_CREDS = { idInstance: "notify-id", token: "notify-token", baseUrl: "https://notify.api.greenapi.com" };

// notifyOwner delegates to the NOTIFY line (notifyOwnerOps) — the owner never
// messages the conversational bot, so on Meta that line is out-of-window.
describe("notifyOwner (delegates to notify line)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendMessageWith.mockResolvedValue({ idMessage: "msg-1" });
    mockToChatId.mockReturnValue(CHAT_ID);
    mockNotifyCreds.mockReturnValue(NOTIFY_CREDS);
  });

  it("returns false and does not send when SUMMARY_RECIPIENT_PHONE is unset", async () => {
    mockToChatId.mockReturnValue(null);

    const result = await notifyOwner("hello");

    expect(result).toBe(false);
    expect(mockSendMessageWith).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("returns false and does not send when notify creds are blank", async () => {
    mockNotifyCreds.mockReturnValue(null);

    const result = await notifyOwner("hello");

    expect(result).toBe(false);
    expect(mockSendMessageWith).not.toHaveBeenCalled();
  });

  it("sends via the NOTIFY line with the correct chatId and text, returns true", async () => {
    const result = await notifyOwner("test message");

    expect(result).toBe(true);
    expect(mockSendMessageWith).toHaveBeenCalledOnce();
    expect(mockSendMessageWith).toHaveBeenCalledWith(NOTIFY_CREDS, CHAT_ID, "test message");
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("returns false when the send throws", async () => {
    mockSendMessageWith.mockRejectedValue(new Error("network error"));

    const result = await notifyOwner("test message");

    expect(result).toBe(false);
  });
});

describe("notifyOwnerOps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendMessageWith.mockResolvedValue({ idMessage: "msg-1" });
    mockToChatId.mockReturnValue(CHAT_ID);
    mockNotifyCreds.mockReturnValue(NOTIFY_CREDS);
  });

  it("returns false and does not call sendMessageWith when SUMMARY_RECIPIENT_PHONE is unset", async () => {
    mockToChatId.mockReturnValue(null);

    const result = await notifyOwnerOps("hello");

    expect(result).toBe(false);
    expect(mockSendMessageWith).not.toHaveBeenCalled();
  });

  it("returns false and does not call sendMessageWith when notify creds are blank", async () => {
    mockNotifyCreds.mockReturnValue(null);

    const result = await notifyOwnerOps("hello");

    expect(result).toBe(false);
    expect(mockSendMessageWith).not.toHaveBeenCalled();
  });

  it("calls sendMessageWith with the notify creds, chatId and text, returns true on success", async () => {
    const result = await notifyOwnerOps("test message");

    expect(result).toBe(true);
    expect(mockSendMessageWith).toHaveBeenCalledOnce();
    expect(mockSendMessageWith).toHaveBeenCalledWith(NOTIFY_CREDS, CHAT_ID, "test message");
  });

  it("returns false when sendMessageWith throws", async () => {
    mockSendMessageWith.mockRejectedValue(new Error("network error"));

    const result = await notifyOwnerOps("test message");

    expect(result).toBe(false);
  });
});
