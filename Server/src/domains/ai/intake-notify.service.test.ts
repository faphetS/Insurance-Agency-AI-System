import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — sendOwnerEmail is ALWAYS mocked; no test may reach the real Gmail send.
// ---------------------------------------------------------------------------

const { mockSendOwnerEmail, envMock } = vi.hoisted(() => ({
  mockSendOwnerEmail: vi.fn().mockResolvedValue({ id: "fake-mail" }),
  envMock: {
    STAFF_EMAIL_NOTIFY_MODE: "log" as "log" | "send",
    NODE_ENV: "test",
  },
}));

vi.mock("../../config/env.js", () => ({ get env() { return envMock; } }));
vi.mock("../../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../integrations/google/google.gmail.js", () => ({
  sendOwnerEmail: mockSendOwnerEmail,
}));

import {
  sendStaffLeadEmail,
  sendCallbackRequestEmail,
  buildCallbackAlert,
  buildStallAlert,
} from "./intake-notify.service.js";

const FAKE_PHONE = "972501234567"; // obviously fake test number

beforeEach(() => {
  vi.clearAllMocks();
  envMock.STAFF_EMAIL_NOTIFY_MODE = "log";
});

// ---------------------------------------------------------------------------
// sendStaffLeadEmail — routing + gate
// ---------------------------------------------------------------------------

describe("sendStaffLeadEmail — routing", () => {
  it("travel → no email (dead silence), even in send mode", async () => {
    envMock.STAFF_EMAIL_NOTIFY_MODE = "send";
    await sendStaffLeadEmail("travel", { phone: FAKE_PHONE, waName: "יעל" });
    expect(mockSendOwnerEmail).not.toHaveBeenCalled();
  });

  it("other → no email (dead silence), even in send mode", async () => {
    envMock.STAFF_EMAIL_NOTIFY_MODE = "send";
    await sendStaffLeadEmail("other", { phone: FAKE_PHONE, waName: "יעל" });
    expect(mockSendOwnerEmail).not.toHaveBeenCalled();
  });

  it("unknown inquiry id → no email", async () => {
    envMock.STAFF_EMAIL_NOTIFY_MODE = "send";
    await sendStaffLeadEmail("nonsense", { phone: FAKE_PHONE, waName: "יעל" });
    expect(mockSendOwnerEmail).not.toHaveBeenCalled();
  });

  it("vehicle in SEND mode → single email to Merav, personalised greeting", async () => {
    envMock.STAFF_EMAIL_NOTIFY_MODE = "send";
    await sendStaffLeadEmail("vehicle", { phone: FAKE_PHONE, waName: "יעל כהן" });
    expect(mockSendOwnerEmail).toHaveBeenCalledOnce();
    const [to, subject, body] = mockSendOwnerEmail.mock.calls[0] as [string, string, string];
    expect(to).toBe("merav@shaked-ins.com");
    expect(subject).toBe("פנייה חדשה מהבוט — ביטוח רכב");
    expect(body).toContain("היי מירב,");
    expect(body).toContain("סוג הביטוח: ביטוח רכב");
    expect(body).toContain("טלפון הלקוח: 050-1234567"); // local format
    expect(body).toContain("שם בוואטסאפ: יעל כהן");
    expect(body).toContain("תודה, דידי");
  });

  it("life_health_pension in SEND mode → single email, 4 recipients comma-joined, plain greeting", async () => {
    envMock.STAFF_EMAIL_NOTIFY_MODE = "send";
    await sendStaffLeadEmail("life_health_pension", { phone: FAKE_PHONE, waName: "דוד" });
    expect(mockSendOwnerEmail).toHaveBeenCalledOnce();
    const [to, , body] = mockSendOwnerEmail.mock.calls[0] as [string, string, string];
    expect(to).toBe("rivka@shaked-ins.com, tzivia@shaked-ins.com, ruth@shaked-ins.com, yafa@shaked-ins.com");
    expect(body).toContain("היי,"); // plain greeting for the 4-person dept
    expect(body).not.toContain("היי מירב");
  });

  it("finance in SEND mode → same 4-person team", async () => {
    envMock.STAFF_EMAIL_NOTIFY_MODE = "send";
    await sendStaffLeadEmail("finance", { phone: FAKE_PHONE, waName: null });
    const [to, , body] = mockSendOwnerEmail.mock.calls[0] as [string, string, string];
    expect(to).toBe("rivka@shaked-ins.com, tzivia@shaked-ins.com, ruth@shaked-ins.com, yafa@shaked-ins.com");
    expect(body).toContain("שם בוואטסאפ: לא צוין"); // null name fallback
  });

  it("DRY-RUN gate: mode 'log' never calls sendOwnerEmail", async () => {
    envMock.STAFF_EMAIL_NOTIFY_MODE = "log";
    await sendStaffLeadEmail("vehicle", { phone: FAKE_PHONE, waName: "יעל" });
    expect(mockSendOwnerEmail).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// sendCallbackRequestEmail — Didi self-email for button 7
// ---------------------------------------------------------------------------

describe("sendCallbackRequestEmail", () => {
  it("SEND mode → emails didi@ddins.net, no thank-you signature", async () => {
    envMock.STAFF_EMAIL_NOTIFY_MODE = "send";
    await sendCallbackRequestEmail({ phone: FAKE_PHONE, waName: "יעל כהן" });
    expect(mockSendOwnerEmail).toHaveBeenCalledOnce();
    const [to, subject, body] = mockSendOwnerEmail.mock.calls[0] as [string, string, string];
    expect(to).toBe("didi@ddins.net");
    expect(subject).toContain("בקשת שיחה חוזרת");
    expect(subject).toContain("יעל כהן");
    expect(body).toContain("טלפון הלקוח: 050-1234567");
    expect(body).toContain("שם בוואטסאפ: יעל כהן");
    expect(body).not.toContain("תודה");
  });

  it("null waName → falls back to local phone in subject and לא צוין in body", async () => {
    envMock.STAFF_EMAIL_NOTIFY_MODE = "send";
    await sendCallbackRequestEmail({ phone: FAKE_PHONE, waName: null });
    const [, subject, body] = mockSendOwnerEmail.mock.calls[0] as [string, string, string];
    expect(subject).toContain("050-1234567");
    expect(body).toContain("שם בוואטסאפ: לא צוין");
  });

  it("DRY-RUN gate: mode 'log' never calls sendOwnerEmail", async () => {
    envMock.STAFF_EMAIL_NOTIFY_MODE = "log";
    await sendCallbackRequestEmail({ phone: FAKE_PHONE, waName: "יעל" });
    expect(mockSendOwnerEmail).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Alert builders (emojis kept for staff/Didi messages)
// ---------------------------------------------------------------------------

describe("buildCallbackAlert", () => {
  it("includes the 📞 header, local phone, and WA name", () => {
    const text = buildCallbackAlert(FAKE_PHONE, "יעל כהן");
    expect(text).toContain("📞 בקשת שיחה חוזרת מהבוט");
    expect(text).toContain("טלפון: 050-1234567");
    expect(text).toContain("שם בוואטסאפ: יעל כהן");
  });

  it("falls back to לא צוין for a missing WA name", () => {
    const text = buildCallbackAlert(FAKE_PHONE, null);
    expect(text).toContain("שם בוואטסאפ: לא צוין");
  });
});

describe("buildStallAlert", () => {
  it("consent stall names the consent step", () => {
    const text = buildStallAlert(FAKE_PHONE, "יעל", "consent");
    expect(text).toContain("⚠️ ליד לא השלים את התהליך");
    expect(text).toContain("נעצר בשלב: אישור הסכמה (מאשר)");
  });

  it("id_photo stall names the ID step + לא צוין fallback", () => {
    const text = buildStallAlert(FAKE_PHONE, null, "id_photo");
    expect(text).toContain("נעצר בשלב: שליחת צילום תעודת זהות");
    expect(text).toContain("שם בוואטסאפ: לא צוין");
  });
});
