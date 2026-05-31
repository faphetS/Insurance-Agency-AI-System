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

vi.mock("../../operations/operations.service.js", () => ({
  createNotification: vi.fn(),
}));
vi.mock("../../operations/operations.staff-notify.js", () => ({
  notifyStaffSummaryReady: vi.fn(),
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

import { verifySignature } from "./timeless.service.js";
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
