import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockSendMessage, envMock } = vi.hoisted(() => ({
  mockSendMessage: vi.fn().mockResolvedValue({ idMessage: "msg-dept" }),
  envMock: {
    DEPT_ELEMENTARY_PHONE: undefined as string | undefined,
    DEPT_LIFE_FINANCE_PHONE: undefined as string | undefined,
    NODE_ENV: "test",
  },
}));

vi.mock("../../config/env.js", () => ({ get env() { return envMock; } }));
vi.mock("../../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("./whatsapp.service.js", () => ({
  sendMessage: mockSendMessage,
}));

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

import { notifyDepartmentForInquiry } from "./department-routing.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("notifyDepartmentForInquiry — inquiry→phone mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envMock.DEPT_ELEMENTARY_PHONE = undefined;
    envMock.DEPT_LIFE_FINANCE_PHONE = undefined;
  });

  it("vehicle → DEPT_ELEMENTARY_PHONE when set", async () => {
    envMock.DEPT_ELEMENTARY_PHONE = "055-9762838";
    await notifyDepartmentForInquiry("vehicle", { phone: "972501234567", clientType: "new" });
    expect(mockSendMessage).toHaveBeenCalledOnce();
    const [chatId, text] = mockSendMessage.mock.calls[0] as [string, string];
    expect(chatId).toBe("972559762838@c.us");
    expect(text).toContain("ביטוח רכב");
    expect(text).toContain("972501234567");
    expect(text).toContain("מתעניין");
  });

  it("home → DEPT_ELEMENTARY_PHONE", async () => {
    envMock.DEPT_ELEMENTARY_PHONE = "055-9762838";
    await notifyDepartmentForInquiry("home", { phone: "972501234567", clientType: "old" });
    expect(mockSendMessage).toHaveBeenCalledOnce();
    const [, text] = mockSendMessage.mock.calls[0] as [string, string];
    expect(text).toContain("ביטוח דירה");
    expect(text).toContain("לקוח קיים");
  });

  it("business → DEPT_ELEMENTARY_PHONE", async () => {
    envMock.DEPT_ELEMENTARY_PHONE = "055-9762838";
    await notifyDepartmentForInquiry("business", { phone: "972501234567", clientType: null });
    expect(mockSendMessage).toHaveBeenCalledOnce();
    const [, text] = mockSendMessage.mock.calls[0] as [string, string];
    expect(text).toContain("ביטוח עסקים");
    expect(text).toContain("מתעניין");
  });

  it("life_health_pension → DEPT_LIFE_FINANCE_PHONE when set", async () => {
    envMock.DEPT_LIFE_FINANCE_PHONE = "053-3228285";
    await notifyDepartmentForInquiry("life_health_pension", { phone: "972501234567", clientType: "new" });
    expect(mockSendMessage).toHaveBeenCalledOnce();
    const [chatId, text] = mockSendMessage.mock.calls[0] as [string, string];
    expect(chatId).toBe("972533228285@c.us");
    expect(text).toContain("ביטוח חיים/בריאות/פנסיה");
  });

  it("finance → DEPT_LIFE_FINANCE_PHONE", async () => {
    envMock.DEPT_LIFE_FINANCE_PHONE = "053-3228285";
    await notifyDepartmentForInquiry("finance", { phone: "972501234567", clientType: "old" });
    expect(mockSendMessage).toHaveBeenCalledOnce();
    const [, text] = mockSendMessage.mock.calls[0] as [string, string];
    expect(text).toContain("פיננסים");
  });

  it("travel → no mapping, sendMessage NOT called", async () => {
    envMock.DEPT_ELEMENTARY_PHONE = "055-9762838";
    envMock.DEPT_LIFE_FINANCE_PHONE = "053-3228285";
    await notifyDepartmentForInquiry("travel", { phone: "972501234567", clientType: "new" });
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("other → no mapping, sendMessage NOT called", async () => {
    envMock.DEPT_ELEMENTARY_PHONE = "055-9762838";
    envMock.DEPT_LIFE_FINANCE_PHONE = "053-3228285";
    await notifyDepartmentForInquiry("other", { phone: "972501234567", clientType: "new" });
    expect(mockSendMessage).not.toHaveBeenCalled();
  });
});

describe("notifyDepartmentForInquiry — blank env no-op", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envMock.DEPT_ELEMENTARY_PHONE = undefined;
    envMock.DEPT_LIFE_FINANCE_PHONE = undefined;
  });

  it("vehicle with blank DEPT_ELEMENTARY_PHONE → no send", async () => {
    await notifyDepartmentForInquiry("vehicle", { phone: "972501234567", clientType: "new" });
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("life_health_pension with blank DEPT_LIFE_FINANCE_PHONE → no send", async () => {
    await notifyDepartmentForInquiry("life_health_pension", { phone: "972501234567", clientType: "old" });
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("never throws even if sendMessage rejects", async () => {
    envMock.DEPT_ELEMENTARY_PHONE = "055-9762838";
    mockSendMessage.mockRejectedValueOnce(new Error("send failed"));
    await expect(
      notifyDepartmentForInquiry("vehicle", { phone: "972501234567", clientType: "new" })
    ).resolves.toBeUndefined();
  });
});
