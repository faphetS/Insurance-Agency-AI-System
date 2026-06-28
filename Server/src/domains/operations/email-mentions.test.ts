import { describe, it, expect, vi } from "vitest";

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
  pool: { query: vi.fn() },
}));

vi.mock("../integrations/google/google.gmail.js", () => ({
  listSentMessageIds: vi.fn(),
  getSentMessage: vi.fn(),
  sendOwnerEmail: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Subject import (after mocks)
// ---------------------------------------------------------------------------
import { matchStaffInEmail } from "./email-mentions.service.js";
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
