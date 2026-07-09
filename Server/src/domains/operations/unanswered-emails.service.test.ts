import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock functions
// ---------------------------------------------------------------------------
const {
  mockPoolQuery,
  mockListSentMessageIds,
  mockGetProfileAddress,
  mockGetMessageMeta,
  mockThreadRepliedAfter,
  mockSendOwnerEmail,
} = vi.hoisted(() => ({
  mockPoolQuery: vi.fn(),
  mockListSentMessageIds: vi.fn(),
  mockGetProfileAddress: vi.fn(),
  mockGetMessageMeta: vi.fn(),
  mockThreadRepliedAfter: vi.fn(),
  mockSendOwnerEmail: vi.fn(),
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

vi.mock("../integrations/google/google.gmail.js", () => ({
  listSentMessageIds: mockListSentMessageIds,
  getProfileAddress: mockGetProfileAddress,
  getMessageMeta: mockGetMessageMeta,
  threadRepliedAfter: mockThreadRepliedAfter,
  sendOwnerEmail: mockSendOwnerEmail,
}));

// ---------------------------------------------------------------------------
// Subject import (after mocks)
// ---------------------------------------------------------------------------
import { env } from "../../config/env.js";
import {
  senderDisplayName,
  isEligibleMessage,
  buildUnansweredEmail,
  runUnansweredEmailNotify,
} from "./unanswered-emails.service.js";

const OWN_ADDRESS = "didi@ddins.net";

// ---------------------------------------------------------------------------
// Tests: senderDisplayName (pure helper)
// ---------------------------------------------------------------------------
describe("senderDisplayName", () => {
  it("strips surrounding quotes from a quoted display name", () => {
    expect(senderDisplayName('"שרית עזרא" <s@x.co.il>')).toBe("שרית עזרא");
  });

  it("returns the plain display name when unquoted", () => {
    expect(senderDisplayName("Name <a@b>")).toBe("Name");
  });

  it("returns the bare address when there is no display name", () => {
    expect(senderDisplayName("a@b")).toBe("a@b");
  });
});

// ---------------------------------------------------------------------------
// Tests: isEligibleMessage (pure helper)
// ---------------------------------------------------------------------------
describe("isEligibleMessage", () => {
  it("rejects a message without the CATEGORY_PERSONAL label", () => {
    const meta = { headers: { from: "client@example.com" }, labelIds: ["CATEGORY_UPDATES"] };
    expect(isEligibleMessage(meta, OWN_ADDRESS)).toBe(false);
  });

  it("rejects a message sent by the owner themself", () => {
    const meta = { headers: { from: `Didi <${OWN_ADDRESS}>` }, labelIds: ["CATEGORY_PERSONAL"] };
    expect(isEligibleMessage(meta, OWN_ADDRESS)).toBe(false);
  });

  it("rejects no-reply@ senders", () => {
    const meta = { headers: { from: "no-reply@service.com" }, labelIds: ["CATEGORY_PERSONAL"] };
    expect(isEligibleMessage(meta, OWN_ADDRESS)).toBe(false);
  });

  it("rejects noreply@ senders", () => {
    const meta = { headers: { from: "noreply@service.com" }, labelIds: ["CATEGORY_PERSONAL"] };
    expect(isEligibleMessage(meta, OWN_ADDRESS)).toBe(false);
  });

  it("rejects donotreply@ senders", () => {
    const meta = { headers: { from: "donotreply@service.com" }, labelIds: ["CATEGORY_PERSONAL"] };
    expect(isEligibleMessage(meta, OWN_ADDRESS)).toBe(false);
  });

  it("rejects a message carrying a List-Unsubscribe header", () => {
    const meta = {
      headers: { from: "client@example.com", "list-unsubscribe": "<mailto:x@y.com>" },
      labelIds: ["CATEGORY_PERSONAL"],
    };
    expect(isEligibleMessage(meta, OWN_ADDRESS)).toBe(false);
  });

  it("accepts a normal Primary human email", () => {
    const meta = { headers: { from: "client@example.com" }, labelIds: ["CATEGORY_PERSONAL"] };
    expect(isEligibleMessage(meta, OWN_ADDRESS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: buildUnansweredEmail (pure helper)
// ---------------------------------------------------------------------------
describe("buildUnansweredEmail", () => {
  it("subject is always the fixed Hebrew subject", () => {
    const { subject } = buildUnansweredEmail([{ subject: "Policy", from: "a@b.com" }]);
    expect(subject).toBe("מיילים שלא נענו מאתמול");
  });

  it("renders an exact body for a single row", () => {
    const { body } = buildUnansweredEmail([{ subject: "Policy renewal", from: "Name <a@b.com>" }]);
    expect(body).toBe(
      "היי דידי — אלו המיילים מ־24 השעות האחרונות שעדיין לא הגבת עליהם:\n\n" +
        "• Policy renewal — מאת: Name\n\n" +
        "(מייל אוטומטי מהמערכת)",
    );
  });

  it("renders an exact body for several rows", () => {
    const { body } = buildUnansweredEmail([
      { subject: "Policy renewal", from: "Name <a@b.com>" },
      { subject: "Claim status", from: '"שרית עזרא" <s@x.co.il>' },
    ]);
    expect(body).toBe(
      "היי דידי — אלו המיילים מ־24 השעות האחרונות שעדיין לא הגבת עליהם:\n\n" +
        "• Policy renewal — מאת: Name\n" +
        "• Claim status — מאת: שרית עזרא\n\n" +
        "(מייל אוטומטי מהמערכת)",
    );
  });

  it("renders a null subject as (ללא נושא)", () => {
    const { body } = buildUnansweredEmail([{ subject: null, from: "a@b.com" }]);
    expect(body).toContain("(ללא נושא)");
  });
});

// ---------------------------------------------------------------------------
// Tests: runUnansweredEmailNotify
// ---------------------------------------------------------------------------
describe("runUnansweredEmailNotify", () => {
  const NOW = new Date("2026-07-10T06:00:00.000Z").getTime();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    env.STAFF_EMAIL_NOTIFY_MODE = "log";

    mockPoolQuery.mockImplementation((sql: string) => {
      if (sql.includes("SELECT value FROM public.system_settings")) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    mockGetProfileAddress.mockResolvedValue(OWN_ADDRESS);
    mockThreadRepliedAfter.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("dedupes messages within the same thread, keeping the latest", async () => {
    mockListSentMessageIds.mockResolvedValue(["m1", "m2"]);
    mockGetMessageMeta.mockImplementation((id: string) => {
      if (id === "m1") {
        return Promise.resolve({
          headers: { from: "client@example.com", subject: "First" },
          labelIds: ["CATEGORY_PERSONAL"],
          threadId: "t1",
          internalDate: NOW - 60 * 60 * 1000,
        });
      }
      return Promise.resolve({
        headers: { from: "client@example.com", subject: "Second" },
        labelIds: ["CATEGORY_PERSONAL"],
        threadId: "t1",
        internalDate: NOW - 30 * 60 * 1000,
      });
    });

    const result = await runUnansweredEmailNotify();

    expect(result.scanned).toBe(2);
    expect(result.flagged).toBe(1);
  });

  it("drops a thread that the owner has already replied to", async () => {
    mockListSentMessageIds.mockResolvedValue(["m1"]);
    mockGetMessageMeta.mockResolvedValue({
      headers: { from: "client@example.com", subject: "Question" },
      labelIds: ["CATEGORY_PERSONAL"],
      threadId: "t1",
      internalDate: NOW - 60 * 60 * 1000,
    });
    mockThreadRepliedAfter.mockResolvedValue(true);

    const result = await runUnansweredEmailNotify();

    expect(result.flagged).toBe(0);
    expect(result.sent).toBe(0);
  });

  it("excludes messages older than the watermark window", async () => {
    mockPoolQuery.mockImplementation((sql: string) => {
      if (sql.includes("SELECT value FROM public.system_settings")) {
        return Promise.resolve({ rows: [{ value: new Date(NOW - 2 * 60 * 60 * 1000).toISOString() }] });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    mockListSentMessageIds.mockResolvedValue(["old", "recent"]);
    mockGetMessageMeta.mockImplementation((id: string) => {
      if (id === "old") {
        return Promise.resolve({
          headers: { from: "client@example.com", subject: "Old" },
          labelIds: ["CATEGORY_PERSONAL"],
          threadId: "t-old",
          internalDate: NOW - 3 * 60 * 60 * 1000,
        });
      }
      return Promise.resolve({
        headers: { from: "client@example.com", subject: "Recent" },
        labelIds: ["CATEGORY_PERSONAL"],
        threadId: "t-recent",
        internalDate: NOW - 60 * 60 * 1000,
      });
    });

    const result = await runUnansweredEmailNotify();

    expect(result.scanned).toBe(2);
    expect(result.flagged).toBe(1);
  });

  it("advances the watermark and sends nothing when the final list is empty", async () => {
    mockListSentMessageIds.mockResolvedValue([]);

    const result = await runUnansweredEmailNotify();

    expect(result).toEqual({ scanned: 0, flagged: 0, sent: 0 });
    expect(mockSendOwnerEmail).not.toHaveBeenCalled();

    const upsertCall = mockPoolQuery.mock.calls.find(([sql]) =>
      (sql as string).includes("INSERT INTO public.system_settings"),
    );
    expect(upsertCall).toBeTruthy();
  });

  it("log mode: never calls sendOwnerEmail", async () => {
    env.STAFF_EMAIL_NOTIFY_MODE = "log";
    mockListSentMessageIds.mockResolvedValue(["m1"]);
    mockGetMessageMeta.mockResolvedValue({
      headers: { from: "client@example.com", subject: "Question" },
      labelIds: ["CATEGORY_PERSONAL"],
      threadId: "t1",
      internalDate: NOW - 60 * 60 * 1000,
    });

    const result = await runUnansweredEmailNotify();

    expect(mockSendOwnerEmail).not.toHaveBeenCalled();
    expect(result.sent).toBe(0);
  });

  it("send mode: calls sendOwnerEmail with the owner's own address", async () => {
    env.STAFF_EMAIL_NOTIFY_MODE = "send";
    mockListSentMessageIds.mockResolvedValue(["m1"]);
    mockGetMessageMeta.mockResolvedValue({
      headers: { from: "client@example.com", subject: "Question" },
      labelIds: ["CATEGORY_PERSONAL"],
      threadId: "t1",
      internalDate: NOW - 60 * 60 * 1000,
    });

    const result = await runUnansweredEmailNotify();

    expect(mockSendOwnerEmail).toHaveBeenCalledWith(OWN_ADDRESS, expect.any(String), expect.any(String));
    expect(result.sent).toBe(1);

    env.STAFF_EMAIL_NOTIFY_MODE = "log";
  });
});
