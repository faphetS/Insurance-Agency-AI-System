import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock functions
// ---------------------------------------------------------------------------
const {
  mockOpCreds,
  mockFromImpl,
  mockScanRecentChats,
  mockDetectCommitments,
  mockFireMorningBatch,
} = vi.hoisted(() => ({
  mockOpCreds: vi.fn(),
  mockFromImpl: vi.fn(),
  mockScanRecentChats: vi.fn(),
  mockDetectCommitments: vi.fn(),
  mockFireMorningBatch: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks — declared before project imports
// ---------------------------------------------------------------------------
vi.mock("../../config/env.js", () => ({
  env: { NODE_ENV: "test" },
}));

vi.mock("../../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../config/supabase.js", () => ({
  supabaseAdmin: { from: mockFromImpl },
}));

vi.mock("../whatsapp/whatsapp.service.js", () => ({
  opCreds: mockOpCreds,
}));

vi.mock("./commitments.scan.js", () => ({
  scanRecentChats: mockScanRecentChats,
}));

vi.mock("./commitments.detector.js", () => ({
  detectCommitments: mockDetectCommitments,
}));

vi.mock("./commitments.reminders.js", () => ({
  fireMorningBatch: mockFireMorningBatch,
  fireTimedReminders: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Subject import (after mocks)
// ---------------------------------------------------------------------------
import { refreshCommitments, runMorningCommitments } from "./commitments.service.js";

const CREDS = { idInstance: "op-id", token: "op-token", baseUrl: "https://test.api.greenapi.com" };

function makeEmptySettingsBuilder() {
  const b: Record<string, unknown> = {};
  const chainMethods = ["select", "eq", "upsert"];
  for (const m of chainMethods) b[m] = vi.fn().mockReturnValue(b);
  b["maybeSingle"] = vi.fn().mockResolvedValue({ data: { value: "972500000000@c.us" }, error: null });
  return b;
}

describe("refreshCommitments — op-window gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockOpCreds.mockReturnValue(CREDS);
    mockFromImpl.mockImplementation(() => makeEmptySettingsBuilder());
    mockScanRecentChats.mockResolvedValue([]);
    mockDetectCommitments.mockResolvedValue(undefined);
    mockFireMorningBatch.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("outside op window (Friday): scan/detect are not called", async () => {
    // 2026-07-31 is a Friday. 12:00 Israel = 09:00 UTC.
    vi.setSystemTime(new Date("2026-07-31T09:00:00Z"));

    await refreshCommitments();

    expect(mockScanRecentChats).not.toHaveBeenCalled();
    expect(mockDetectCommitments).not.toHaveBeenCalled();
  });

  it("outside op window (Tuesday 20:00 Israel): scan/detect are not called", async () => {
    // 2026-07-28 is a Tuesday. 20:00 Israel = 17:00 UTC.
    vi.setSystemTime(new Date("2026-07-28T17:00:00Z"));

    await refreshCommitments();

    expect(mockScanRecentChats).not.toHaveBeenCalled();
    expect(mockDetectCommitments).not.toHaveBeenCalled();
  });

  it("inside op window (Tuesday 12:00 Israel): scan/detect run normally", async () => {
    // 2026-07-28 is a Tuesday. 12:00 Israel = 09:00 UTC.
    vi.setSystemTime(new Date("2026-07-28T09:00:00Z"));

    await refreshCommitments();

    expect(mockScanRecentChats).toHaveBeenCalledOnce();
    expect(mockDetectCommitments).toHaveBeenCalledOnce();
  });
});

describe("runMorningCommitments — op-window gating (via refreshCommitments)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockOpCreds.mockReturnValue(CREDS);
    mockFromImpl.mockImplementation(() => makeEmptySettingsBuilder());
    mockScanRecentChats.mockResolvedValue([]);
    mockDetectCommitments.mockResolvedValue(undefined);
    mockFireMorningBatch.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("outside op window: no-ops entirely (scan/detect/fireMorningBatch all skipped)", async () => {
    // 2026-07-31 is a Friday. 12:00 Israel = 09:00 UTC.
    vi.setSystemTime(new Date("2026-07-31T09:00:00Z"));

    await runMorningCommitments();

    expect(mockScanRecentChats).not.toHaveBeenCalled();
    expect(mockDetectCommitments).not.toHaveBeenCalled();
    expect(mockFireMorningBatch).not.toHaveBeenCalled();
  });

  it("inside op window (Tuesday 12:00 Israel): full flow runs, including fireMorningBatch", async () => {
    // 2026-07-28 is a Tuesday. 12:00 Israel = 09:00 UTC.
    vi.setSystemTime(new Date("2026-07-28T09:00:00Z"));

    await runMorningCommitments();

    expect(mockScanRecentChats).toHaveBeenCalledOnce();
    expect(mockDetectCommitments).toHaveBeenCalledOnce();
    expect(mockFireMorningBatch).toHaveBeenCalledOnce();
  });
});
