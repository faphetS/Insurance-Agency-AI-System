import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock functions
// ---------------------------------------------------------------------------
const { mockPoolQuery, mockSendOwnerEmail, mockSleep } = vi.hoisted(() => ({
  mockPoolQuery: vi.fn(),
  mockSendOwnerEmail: vi.fn(),
  mockSleep: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks — declared before any project imports so Vitest hoists them
// ---------------------------------------------------------------------------
vi.mock("../../config/env.js", () => ({
  env: {
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://test",
    DATABASE_POOL_MAX: 5,
    STAFF_EMAIL_NOTIFY_MODE: "log",
  },
}));

vi.mock("../../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../lib/db.js", () => ({
  pool: { query: mockPoolQuery },
}));

vi.mock("../../lib/sleep.js", () => ({
  sleep: mockSleep,
}));

vi.mock("../integrations/google/google.gmail.js", () => ({
  listSentMessageIds: vi.fn(),
  getSentMessage: vi.fn(),
  sendOwnerEmail: mockSendOwnerEmail,
}));

// ---------------------------------------------------------------------------
// Subject import (after mocks)
// ---------------------------------------------------------------------------
import { env } from "../../config/env.js";
import {
  matchStaffInEmail,
  staffFirstName,
  buildStaffReminderEmail,
  notifyStaffMentions,
} from "./email-mentions.service.js";
import type { StaffMatch } from "./email-mentions.service.js";

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------
const AGENT_STAFF = [
  { id: "uuid-1", name: "Moshe Cohen", email: "moshe@shaked-ins.com", localpart: "moshe" },
  { id: "uuid-2", name: "Sara Levi", email: "sara@shaked-ins.com", localpart: "sara" },
];

// ---------------------------------------------------------------------------
// Tests: matchStaffInEmail (pure helper — no DB/network)
// ---------------------------------------------------------------------------
describe("matchStaffInEmail", () => {
  it("detects staff email in To header (to_cc)", () => {
    const headers = { to: "moshe@shaked-ins.com", cc: "", subject: "Follow up" };
    const matches = matchStaffInEmail(headers, AGENT_STAFF);
    expect(matches).toHaveLength(1);
    expect(matches[0].staff.id).toBe("uuid-1");
    expect(matches[0].detected_via).toBe("to_cc");
  });

  it("detects staff email in CC header (to_cc)", () => {
    const headers = { to: "client@example.com", cc: "sara@shaked-ins.com", subject: "Policy details" };
    const matches = matchStaffInEmail(headers, AGENT_STAFF);
    expect(matches).toHaveLength(1);
    expect(matches[0].staff.id).toBe("uuid-2");
    expect(matches[0].detected_via).toBe("to_cc");
  });

  it("detects staff email via localpart match against a different domain (to_cc)", () => {
    // localpart "moshe" + "@" is a substring of "moshe@ddins.net"
    const headers = { to: "moshe@ddins.net", cc: "", subject: "Forwarded" };
    const matches = matchStaffInEmail(headers, AGENT_STAFF);
    expect(matches).toHaveLength(1);
    expect(matches[0].staff.id).toBe("uuid-1");
    expect(matches[0].detected_via).toBe("to_cc");
  });

  it("does NOT match a staff email that appears only in the body (quoted-thread noise)", () => {
    // A staff address buried in the body (e.g. a quoted "From: sara@..." line) must NOT match —
    // only actual To/CC recipients count. matchStaffInEmail no longer takes the body at all.
    const headers = { to: "client@gmail.com", cc: "", subject: "Intro" };
    const matches = matchStaffInEmail(headers, AGENT_STAFF);
    expect(matches).toHaveLength(0);
  });

  it("returns empty when no staff email appears in To/CC", () => {
    const headers = { to: "client@gmail.com", cc: "", subject: "General" };
    const matches = matchStaffInEmail(headers, AGENT_STAFF);
    expect(matches).toHaveLength(0);
  });

  it("returns no matches for an empty staff list (owner excluded)", () => {
    const headers = { to: "didi@ddins.net", cc: "", subject: "Owner mail" };
    // Empty list simulates loadStaffMatchers() excluding the owner (role != agent)
    const matches = matchStaffInEmail(headers, []);
    expect(matches).toHaveLength(0);
  });

  it("matches multiple staff in the same email", () => {
    const headers = { to: "moshe@shaked-ins.com", cc: "sara@shaked-ins.com", subject: "Both" };
    const matches = matchStaffInEmail(headers, AGENT_STAFF);
    const ids = matches.map((m: StaffMatch) => m.staff.id).sort();
    expect(ids).toEqual(["uuid-1", "uuid-2"]);
    expect(matches.every((m: StaffMatch) => m.detected_via === "to_cc")).toBe(true);
  });

  it("is case-insensitive for email detection", () => {
    const headers = { to: "MOSHE@SHAKED-INS.COM", cc: "", subject: "Caps" };
    const matches = matchStaffInEmail(headers, AGENT_STAFF);
    expect(matches).toHaveLength(1);
    expect(matches[0].staff.id).toBe("uuid-1");
  });
});

// ---------------------------------------------------------------------------
// Tests: staffFirstName (pure helper)
// ---------------------------------------------------------------------------
describe("staffFirstName", () => {
  it("returns the first token of a two-word name", () => {
    expect(staffFirstName("Moshe Cohen")).toBe("Moshe");
  });

  it("returns the first token of a Hebrew multi-word name", () => {
    expect(staffFirstName("משה   כהן לוי")).toBe("משה");
  });

  it("returns the whole string when there is only one token", () => {
    expect(staffFirstName("Moshe")).toBe("Moshe");
  });

  it("returns empty string for a blank name", () => {
    expect(staffFirstName("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Tests: buildStaffReminderEmail (pure helper)
// ---------------------------------------------------------------------------
describe("buildStaffReminderEmail", () => {
  it("subject is always תזכורת", () => {
    const { subject } = buildStaffReminderEmail("Moshe Cohen", [{ subject: "Policy renewal" }]);
    expect(subject).toBe("תזכורת");
  });

  it("renders singular wording for exactly one subject row", () => {
    const { body } = buildStaffReminderEmail("Moshe Cohen", [{ subject: "Policy renewal" }]);
    expect(body).toBe(
      "היי Moshe — זוהי תזכורת למייל שקיבלת מדידי בנושא Policy renewal.\n\nתודה, דידי",
    );
  });

  it("renders plural wording with bullet list for multiple subject rows", () => {
    const { body } = buildStaffReminderEmail("Sara Levi", [
      { subject: "Policy renewal" },
      { subject: "Client follow-up" },
    ]);
    expect(body).toBe(
      "היי Sara — זוהי תזכורת למיילים שקיבלת מדידי בנושאים:\n• Policy renewal\n• Client follow-up\n\nתודה, דידי",
    );
  });

  it("renders a null subject as (ללא נושא)", () => {
    const { body } = buildStaffReminderEmail("Moshe Cohen", [{ subject: null }]);
    expect(body).toContain("(ללא נושא)");
  });

  it("renders a null subject as (ללא נושא) inside the plural bullet list", () => {
    const { body } = buildStaffReminderEmail("Moshe Cohen", [
      { subject: "Real subject" },
      { subject: null },
    ]);
    expect(body).toContain("• (ללא נושא)");
  });
});

// ---------------------------------------------------------------------------
// Tests: notifyStaffMentions — send-mode pacing (30s gap) vs log-mode (no delay)
// ---------------------------------------------------------------------------
describe("notifyStaffMentions — pacing", () => {
  const TWO_STAFF_ROWS = [
    { id: "m1", staff_id: "uuid-1", staff_email: "moshe@shaked-ins.com", staff_name: "Moshe Cohen", subject: "A", sent_at: "2026-07-01T08:00:00Z" },
    { id: "m2", staff_id: "uuid-2", staff_email: "sara@shaked-ins.com", staff_name: "Sara Levi", subject: "B", sent_at: "2026-07-01T09:00:00Z" },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockSleep.mockResolvedValue(undefined);
    mockSendOwnerEmail.mockResolvedValue(undefined);
    mockPoolQuery.mockImplementation((sql: string) => {
      if (sql.includes("SELECT id, staff_id")) {
        return Promise.resolve({ rows: TWO_STAFF_ROWS });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
  });

  it("log mode: sends no real emails and never sleeps between staff", async () => {
    env.STAFF_EMAIL_NOTIFY_MODE = "log";

    const result = await notifyStaffMentions();

    expect(result.notified).toBe(2);
    expect(mockSendOwnerEmail).not.toHaveBeenCalled();
    expect(mockSleep).not.toHaveBeenCalled();
  });

  it("send mode: waits between per-staff emails (sleep called once for 2 staff)", async () => {
    env.STAFF_EMAIL_NOTIFY_MODE = "send";

    const result = await notifyStaffMentions();

    expect(result.notified).toBe(2);
    expect(mockSendOwnerEmail).toHaveBeenCalledTimes(2);
    expect(mockSleep).toHaveBeenCalledTimes(1);
    expect(mockSleep).toHaveBeenCalledWith(30_000);

    env.STAFF_EMAIL_NOTIFY_MODE = "log";
  });

  it("send mode: does not sleep before the first send", async () => {
    env.STAFF_EMAIL_NOTIFY_MODE = "send";

    // sleep should be called AFTER the first email, before the second — verify ordering
    const callOrder: string[] = [];
    mockSendOwnerEmail.mockImplementation(() => {
      callOrder.push("send");
      return Promise.resolve(undefined);
    });
    mockSleep.mockImplementation(() => {
      callOrder.push("sleep");
      return Promise.resolve(undefined);
    });

    await notifyStaffMentions();

    expect(callOrder).toEqual(["send", "sleep", "send"]);

    env.STAFF_EMAIL_NOTIFY_MODE = "log";
  });
});
