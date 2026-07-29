import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock functions
// ---------------------------------------------------------------------------
const {
  mockOpCreds,
  mockRefreshCommitments,
  mockBuildMorningCommitmentSection,
  mockMarkCommitmentsSent,
  mockBuildCallReminderSection,
  mockPruneCallsOlderThan,
  mockNotifyOwnerOps,
} = vi.hoisted(() => ({
  mockOpCreds: vi.fn(),
  mockRefreshCommitments: vi.fn(),
  mockBuildMorningCommitmentSection: vi.fn(),
  mockMarkCommitmentsSent: vi.fn(),
  mockBuildCallReminderSection: vi.fn(),
  mockPruneCallsOlderThan: vi.fn(),
  mockNotifyOwnerOps: vi.fn(),
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
  supabaseAdmin: { from: vi.fn() },
}));

vi.mock("../whatsapp/whatsapp.service.js", () => ({
  opCreds: mockOpCreds,
  sendMessageWithTyping: vi.fn(),
}));

vi.mock("../commitments/commitments.service.js", () => ({
  refreshCommitments: mockRefreshCommitments,
}));

vi.mock("../commitments/commitments.reminders.js", () => ({
  buildMorningCommitmentSection: mockBuildMorningCommitmentSection,
  markCommitmentsSent: mockMarkCommitmentsSent,
}));

vi.mock("./call-reminder.service.js", () => ({
  buildCallReminderSection: mockBuildCallReminderSection,
}));

vi.mock("./call-events.service.js", () => ({
  pruneCallsOlderThan: mockPruneCallsOlderThan,
}));

vi.mock("./owner-notify.js", () => ({
  notifyOwnerOps: mockNotifyOwnerOps,
}));

// ---------------------------------------------------------------------------
// Subject import (after mocks)
// ---------------------------------------------------------------------------
import { sendMorningDigest } from "./morning-digest.service.js";

const CREDS = { idInstance: "op-id", token: "op-token", baseUrl: "https://test.api.greenapi.com" };

describe("sendMorningDigest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockOpCreds.mockReturnValue(CREDS);
    mockRefreshCommitments.mockResolvedValue(undefined);
    mockBuildMorningCommitmentSection.mockResolvedValue({ text: "commitments text", ids: ["c1"] });
    mockBuildCallReminderSection.mockResolvedValue("calls text");
    mockNotifyOwnerOps.mockResolvedValue(true);
    mockPruneCallsOlderThan.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("Friday: outside op window — refreshCommitments does not run, nothing is sent", async () => {
    // 2026-07-31 is a Friday. 12:00 Israel = 09:00 UTC.
    vi.setSystemTime(new Date("2026-07-31T09:00:00Z"));

    await sendMorningDigest();

    expect(mockRefreshCommitments).not.toHaveBeenCalled();
    expect(mockBuildMorningCommitmentSection).not.toHaveBeenCalled();
    expect(mockBuildCallReminderSection).not.toHaveBeenCalled();
    expect(mockNotifyOwnerOps).not.toHaveBeenCalled();
    expect(mockPruneCallsOlderThan).not.toHaveBeenCalled();
  });

  it("Tuesday 20:00 Israel: in-window weekday but outside business hours — skipped", async () => {
    // 2026-07-28 is a Tuesday. 20:00 Israel = 17:00 UTC.
    vi.setSystemTime(new Date("2026-07-28T17:00:00Z"));

    await sendMorningDigest();

    expect(mockRefreshCommitments).not.toHaveBeenCalled();
    expect(mockBuildMorningCommitmentSection).not.toHaveBeenCalled();
    expect(mockBuildCallReminderSection).not.toHaveBeenCalled();
    expect(mockNotifyOwnerOps).not.toHaveBeenCalled();
    expect(mockPruneCallsOlderThan).not.toHaveBeenCalled();
  });

  it("Tuesday: normal send path runs end to end", async () => {
    // 2026-07-28 is a Tuesday. 09:00 Israel = 06:00 UTC.
    vi.setSystemTime(new Date("2026-07-28T06:00:00Z"));

    await sendMorningDigest();

    expect(mockRefreshCommitments).toHaveBeenCalledOnce();
    expect(mockNotifyOwnerOps).toHaveBeenCalledOnce();
    expect(mockMarkCommitmentsSent).toHaveBeenCalledWith(["c1"]);
    expect(mockPruneCallsOlderThan).toHaveBeenCalledOnce();
  });
});
