import crypto from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock factories are hoisted — use vi.hoisted() for shared mock fns
const { mockMaybeSingle, mockFrom } = vi.hoisted(() => {
  const mockMaybeSingle = vi.fn();
  const mockEq = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
  const mockSelect = vi.fn(() => ({ eq: mockEq }));
  const mockFrom = vi.fn(() => ({ select: mockSelect }));
  return { mockMaybeSingle, mockFrom };
});

vi.mock("../../../config/env.js", () => ({
  env: { BACKEND_URL: "http://localhost:3000", NODE_ENV: "test" },
}));

vi.mock("../../../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../../config/supabase.js", () => ({
  supabaseAdmin: { from: mockFrom },
}));

vi.mock("./timeless.client.js", () => ({
  listWebhooks: vi.fn(),
  createWebhook: vi.fn(),
  deleteWebhook: vi.fn(),
  getMeeting: vi.fn(),
  getRecording: vi.fn(),
  getTranscript: vi.fn(),
  getDocument: vi.fn(),
}));

vi.mock("../../ai/ai.service.js", () => ({
  isHebrew: vi.fn().mockReturnValue(true),
  ensureHebrew: vi.fn().mockResolvedValue("mock hebrew"),
  generateReply: vi.fn().mockResolvedValue("mock reply"),
}));

vi.mock("../../whatsapp/whatsapp.service.js", () => ({
  sendStaffMessage: vi.fn().mockResolvedValue({ idMessage: "mock-id" }),
}));

vi.mock("../../whatsapp/whatsapp.util.js", () => ({
  toChatId: vi.fn().mockReturnValue("972500000000@c.us"),
}));

import { verifySignature, isSameIsraelDay } from "./timeless.service.js";
import { AppError } from "../../../lib/errors.js";

function makeSignature(body: Buffer, secret: string): string {
  const hex = crypto.createHmac("sha256", secret).update(body).digest("hex");
  return `sha256=${hex}`;
}

describe("verifySignature", () => {
  const secret = "supersecretkey123";
  const body = Buffer.from('{"event":"meeting.transcript_ready"}');

  beforeEach(() => {
    vi.clearAllMocks();
    mockMaybeSingle.mockResolvedValue({ data: { value: secret }, error: null });
  });

  it("resolves without error when signature is valid", async () => {
    const sig = makeSignature(body, secret);
    await expect(verifySignature(body, sig)).resolves.toBeUndefined();
  });

  it("throws TIMELESS_SIG_MISMATCH when signature is wrong", async () => {
    const wrongSig = makeSignature(body, "wrongsecret");
    await expect(verifySignature(body, wrongSig)).rejects.toMatchObject({
      code: "TIMELESS_SIG_MISMATCH",
    });
  });

  it("throws TIMELESS_SIG_MISSING when header is absent", async () => {
    await expect(verifySignature(body, undefined)).rejects.toMatchObject({
      code: "TIMELESS_SIG_MISSING",
    });
  });

  it("throws TIMELESS_NO_RAW_BODY when rawBody is undefined", async () => {
    await expect(verifySignature(undefined, "sha256=abc")).rejects.toMatchObject({
      code: "TIMELESS_NO_RAW_BODY",
    });
  });

  it("throws TIMELESS_SIG_INVALID when header lacks sha256= prefix", async () => {
    await expect(verifySignature(body, "md5=badhash")).rejects.toMatchObject({
      code: "TIMELESS_SIG_INVALID",
    });
  });

  it("throws TIMELESS_NOT_CONFIGURED when secret is not in DB", async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    const sig = makeSignature(body, secret);
    await expect(verifySignature(body, sig)).rejects.toMatchObject({
      code: "TIMELESS_NOT_CONFIGURED",
    });
  });

  it("throws AppError instances (not plain Error)", async () => {
    await expect(verifySignature(body, undefined)).rejects.toBeInstanceOf(AppError);
  });
});

describe("isSameIsraelDay", () => {
  it("returns true for same day different hours", () => {
    expect(isSameIsraelDay("2026-06-10T08:00:00Z", "2026-06-10T14:00:00Z")).toBe(true);
  });

  it("returns true for 11:00 vs 13:00 on the same date (core drift scenario)", () => {
    // Both are 2026-06-10 in Israel (UTC+3 in summer)
    expect(isSameIsraelDay("2026-06-10T08:00:00Z", "2026-06-10T10:00:00Z")).toBe(true);
  });

  it("returns false for 23:30 one day vs 00:30 next day in Israel time", () => {
    // 2026-06-10T20:30:00Z = 2026-06-10T23:30+03:00 (Israel summer)
    // 2026-06-10T21:30:00Z = 2026-06-11T00:30+03:00 (Israel summer)
    expect(isSameIsraelDay("2026-06-10T20:30:00Z", "2026-06-10T21:30:00Z")).toBe(false);
  });

  it("returns true for a DST-boundary date where both instants land on the same Israel day", () => {
    // Israel DST spring-forward: last Friday of March 2026 = 2026-03-27T00:00 local → 2026-03-26T22:00Z
    // 08:00 Israel time = 06:00 UTC (before spring-forward); 14:00 Israel time = 11:00 UTC (after)
    expect(isSameIsraelDay("2026-03-27T06:00:00Z", "2026-03-27T11:00:00Z")).toBe(true);
  });

  it("returns true for an instant near UTC midnight that is the same Israel day", () => {
    // 2026-06-10T22:00:00Z = 2026-06-11T01:00+03:00 (Israel summer)
    // 2026-06-10T23:59:00Z = 2026-06-11T02:59+03:00 — same Israel day
    expect(isSameIsraelDay("2026-06-10T22:00:00Z", "2026-06-10T23:59:00Z")).toBe(true);
  });

  it("returns false for clearly different days", () => {
    expect(isSameIsraelDay("2026-06-10T10:00:00Z", "2026-06-11T10:00:00Z")).toBe(false);
  });
});
