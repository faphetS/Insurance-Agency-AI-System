import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — declared before subject imports
// ---------------------------------------------------------------------------

vi.mock("../whatsapp/whatsapp.service.js", () => ({
  sendMessageWithTyping: vi.fn().mockResolvedValue({ idMessage: "x" }),
}));

vi.mock("../../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Capture args for assertions — cleared in beforeEach
const insertCalls: unknown[] = [];
const updateCalls: Array<{ flag: string; meetingId: string }> = [];

// Shared fake conversation data
const FAKE_CONV = { whatsapp_chat_id: "972500000000@c.us" };

// Candidate rows returned by the two meetings queries in order.
// `meetingsQueue` is drained FIFO: first await → meetings24h, second → meetings1h.
let meetingsQueue: unknown[][] = [];

vi.mock("../../config/supabase.js", () => {
  function makeBuilder(table: string) {
    const b = {
      _flag: undefined as string | undefined,
      _meetingId: undefined as string | undefined,

      select(_cols?: string) { return this; },
      eq(col: string, val: unknown) {
        if (col === "id") this._meetingId = String(val);
        if (col === "reminder_24h_sent" || col === "reminder_1h_sent") this._flag = col;
        return this;
      },
      gte() { return this; },
      lte() { return this; },
      single() { return Promise.resolve({ data: FAKE_CONV, error: null }); },

      insert(row: unknown) {
        insertCalls.push(row);
        return Promise.resolve({ data: null, error: null });
      },

      update(payload: Record<string, unknown>) {
        const flagKey = Object.keys(payload).find(
          (k) => k === "reminder_24h_sent" || k === "reminder_1h_sent",
        );
        // eslint-disable-next-line @typescript-eslint/no-this-alias -- inner eq() closure needs the builder mock
        const outerSelf = this;
        if (flagKey) outerSelf._flag = flagKey;
        return {
          eq(col: string, val: unknown) {
            if (col === "id") outerSelf._meetingId = String(val);
            updateCalls.push({ flag: outerSelf._flag ?? "unknown", meetingId: outerSelf._meetingId ?? "" });
            return Promise.resolve({ data: null, error: null });
          },
        };
      },

      then(resolve: (v: { data: unknown[]; error: null }) => void) {
        // Pop the next batch from the queue; fall back to empty
        const data = table === "meetings" ? (meetingsQueue.shift() ?? []) : [];
        resolve({ data, error: null });
      },
    };
    return b;
  }

  return {
    supabaseAdmin: {
      from: (table: string) => makeBuilder(table),
    },
  };
});

// ---------------------------------------------------------------------------
// Subject imports (after mocks)
// ---------------------------------------------------------------------------

import {
  checkAndSendReminders,
  clampedSendTime,
  formatLeadTime,
  israelOffsetMs,
  israelTimeOfDayMs,
  israelWallTimeInstant,
} from "./reminder.service.js";
import { sendMessageWithTyping } from "../whatsapp/whatsapp.service.js";

const mockSend = sendMessageWithTyping as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** June 2026: Israel = UTC+3 (DST active). Israel HH:MM = UTC (HH-3):MM */
function israelToUtc(year: number, month: number, day: number, h: number, m: number): Date {
  return new Date(Date.UTC(year, month - 1, day, h - 3, m, 0));
}

function makeMeeting(scheduledAt: Date, id = "m1", convId = "c1") {
  return { id, conversation_id: convId, scheduled_at: scheduledAt.toISOString() };
}

function resetState() {
  insertCalls.length = 0;
  updateCalls.length = 0;
  meetingsQueue = [];
  mockSend.mockClear();
}

// ---------------------------------------------------------------------------
// Pure-function tests (no mocks needed)
// ---------------------------------------------------------------------------

describe("formatLeadTime", () => {
  it("90 min → כשעה ו-30 דקות", () => {
    expect(formatLeadTime(90 * 60_000)).toBe("כשעה ו-30 דקות");
  });
  it("1380 min (23h) → כ-23 שעות", () => {
    expect(formatLeadTime(1380 * 60_000)).toBe("כ-23 שעות");
  });
  it("45 min → כ-45 דקות", () => {
    expect(formatLeadTime(45 * 60_000)).toBe("כ-45 דקות");
  });
  it("120 min → כשעתיים", () => {
    expect(formatLeadTime(120 * 60_000)).toBe("כשעתיים");
  });
  it("1395 min (23h15m) → כ-23 שעות ו-15 דקות", () => {
    expect(formatLeadTime(1395 * 60_000)).toBe("כ-23 שעות ו-15 דקות");
  });
  it("1 min → כדקה", () => {
    expect(formatLeadTime(60_000)).toBe("כדקה");
  });
  it("60 min → כשעה", () => {
    expect(formatLeadTime(60 * 60_000)).toBe("כשעה");
  });
});

describe("israelTimeOfDayMs", () => {
  it("Israel 07:00 → 7 * 3600 * 1000 ms", () => {
    const at = new Date(Date.UTC(2026, 5, 7, 4, 0, 0)); // UTC 04:00 = Israel 07:00
    expect(israelTimeOfDayMs(at)).toBe(7 * 3600_000);
  });
  it("Israel 21:00 → 21 * 3600 * 1000 ms", () => {
    const at = new Date(Date.UTC(2026, 5, 7, 18, 0, 0)); // UTC 18:00 = Israel 21:00
    expect(israelTimeOfDayMs(at)).toBe(21 * 3600_000);
  });
  it("Israel midnight → 0", () => {
    const at = new Date(Date.UTC(2026, 5, 6, 21, 0, 0)); // UTC 21:00 prev day = Israel 00:00
    expect(israelTimeOfDayMs(at)).toBe(0);
  });
});

describe("clampedSendTime", () => {
  const OFFSET_24H = 24 * 60 * 60_000;
  const OFFSET_1H = 60 * 60_000;

  it("clamp-up: meeting at Israel 06:00 Jun 8 → natural fire 06:00 Jun 7 < 07:00 → clamped to 07:00 Jun 7", () => {
    const meeting = israelToUtc(2026, 6, 8, 6, 0);
    const clamped = clampedSendTime(meeting, OFFSET_24H);
    const expected = israelToUtc(2026, 6, 7, 7, 0);
    expect(clamped.getTime()).toBe(expected.getTime());
  });

  it("clamp-down: meeting at Israel 22:00 Jun 8 → natural fire 22:00 Jun 7 > 21:00 → clamped to 21:00 Jun 7", () => {
    const meeting = israelToUtc(2026, 6, 8, 22, 0);
    const clamped = clampedSendTime(meeting, OFFSET_24H);
    const expected = israelToUtc(2026, 6, 7, 21, 0);
    expect(clamped.getTime()).toBe(expected.getTime());
  });

  it("no-clamp: meeting at Israel 15:00 Jun 8 → natural fire 15:00 Jun 7 unchanged", () => {
    const meeting = israelToUtc(2026, 6, 8, 15, 0);
    const natural = new Date(meeting.getTime() - OFFSET_24H);
    const clamped = clampedSendTime(meeting, OFFSET_24H);
    expect(clamped.getTime()).toBe(natural.getTime());
  });

  it("1h clamp-down: meeting at Israel 22:30 → natural 21:30 > 21:00 → clamped to 21:00", () => {
    const meeting = israelToUtc(2026, 6, 7, 22, 30);
    const clamped = clampedSendTime(meeting, OFFSET_1H);
    const expected = israelToUtc(2026, 6, 7, 21, 0);
    expect(clamped.getTime()).toBe(expected.getTime());
  });
});

describe("israelOffsetMs", () => {
  it("returns +3h (10800000 ms) in June 2026 (DST active)", () => {
    const at = new Date(Date.UTC(2026, 5, 7, 12, 0, 0));
    expect(israelOffsetMs(at)).toBe(3 * 3600_000);
  });
});

describe("israelWallTimeInstant", () => {
  it("returns UTC 04:00 for Israel 07:00 on June 7 2026", () => {
    const ref = new Date(Date.UTC(2026, 5, 7, 9, 0, 0)); // Israel noon
    const result = israelWallTimeInstant(ref, 7, 0);
    const expected = new Date(Date.UTC(2026, 5, 7, 4, 0, 0));
    expect(result.getTime()).toBe(expected.getTime());
  });
});

// ---------------------------------------------------------------------------
// checkAndSendReminders — integration-style (mocked DB + WA)
// ---------------------------------------------------------------------------

describe("checkAndSendReminders — 24h normal", () => {
  beforeEach(() => { vi.useFakeTimers(); resetState(); });
  afterEach(() => vi.useRealTimers());

  it("meeting exactly 24h out at Israel noon: sends; body has שעות; reminder_24h_sent set", async () => {
    const now = new Date(Date.UTC(2026, 5, 7, 9, 0, 0));   // Israel 12:00
    vi.setSystemTime(now);
    const scheduled = israelToUtc(2026, 6, 8, 12, 0);       // +24h exactly

    meetingsQueue = [[makeMeeting(scheduled)], []];           // 24h rows, then 1h rows

    await checkAndSendReminders();

    expect(mockSend).toHaveBeenCalledTimes(1);
    const body: string = mockSend.mock.calls[0][1];
    expect(body).toContain("תזכורת");
    expect(body).toMatch(/שעות?|שעתיים|כשעה/);
    expect(updateCalls.some((u) => u.flag === "reminder_24h_sent")).toBe(true);
  });
});

describe("checkAndSendReminders — 24h clamp-up", () => {
  beforeEach(() => { vi.useFakeTimers(); resetState(); });
  afterEach(() => vi.useRealTimers());

  it("at now=Israel 06:30: NO send; flag NOT set (deferred)", async () => {
    const now = new Date(Date.UTC(2026, 5, 7, 3, 30, 0));   // Israel 06:30
    vi.setSystemTime(now);
    const scheduled = israelToUtc(2026, 6, 8, 6, 0);
    // Natural fire = Jun 7 06:00 Israel; clamped to 07:00; now < 07:00 → defer

    meetingsQueue = [[makeMeeting(scheduled)], []];

    await checkAndSendReminders();

    expect(mockSend).not.toHaveBeenCalled();
    expect(updateCalls).toHaveLength(0);
  });

  it("at now=Israel 07:00: sends; lead is ~23h → body contains 23", async () => {
    const now = new Date(Date.UTC(2026, 5, 7, 4, 0, 0));   // Israel 07:00
    vi.setSystemTime(now);
    const scheduled = israelToUtc(2026, 6, 8, 6, 0);        // 23h ahead of now

    meetingsQueue = [[makeMeeting(scheduled)], []];

    await checkAndSendReminders();

    expect(mockSend).toHaveBeenCalledTimes(1);
    const body: string = mockSend.mock.calls[0][1];
    expect(body).toContain("23");
    expect(updateCalls.some((u) => u.flag === "reminder_24h_sent")).toBe(true);
  });
});

describe("checkAndSendReminders — 24h clamp-down", () => {
  beforeEach(() => { vi.useFakeTimers(); resetState(); });
  afterEach(() => vi.useRealTimers());

  it("meeting at Israel 22:00 Jun 8 (+25h from now=21:00 Jun 7): sends; body contains 25", async () => {
    const now = new Date(Date.UTC(2026, 5, 7, 18, 0, 0));   // Israel 21:00 Jun 7
    vi.setSystemTime(now);
    const scheduled = israelToUtc(2026, 6, 8, 22, 0);        // Israel 22:00 Jun 8 (+25h)
    // Natural fire = Jun 7 22:00 Israel, > 21:00 → clamped to Jun 7 21:00 = now → sends

    meetingsQueue = [[makeMeeting(scheduled)], []];

    await checkAndSendReminders();

    expect(mockSend).toHaveBeenCalledTimes(1);
    const body: string = mockSend.mock.calls[0][1];
    expect(body).toContain("25");
  });
});

describe("checkAndSendReminders — 1h normal", () => {
  beforeEach(() => { vi.useFakeTimers(); resetState(); });
  afterEach(() => vi.useRealTimers());

  it("meeting 45 min out at Israel 14:45: sends; body contains 45 דקות", async () => {
    const now = new Date(Date.UTC(2026, 5, 7, 11, 0, 0));   // Israel 14:00
    vi.setSystemTime(now);
    const scheduled = new Date(now.getTime() + 45 * 60_000);

    meetingsQueue = [[], [makeMeeting(scheduled)]];            // no 24h; one 1h

    await checkAndSendReminders();

    expect(mockSend).toHaveBeenCalledTimes(1);
    const body: string = mockSend.mock.calls[0][1];
    expect(body).toContain("45 דקות");
  });
});

describe("checkAndSendReminders — 1h clamp-down", () => {
  beforeEach(() => { vi.useFakeTimers(); resetState(); });
  afterEach(() => vi.useRealTimers());

  it("meeting at Israel 22:30 → natural 21:30 clamped to 21:00: at now=21:00 sends; lead = שעה ו-30 דקות", async () => {
    const now = new Date(Date.UTC(2026, 5, 7, 18, 0, 0));   // Israel 21:00
    vi.setSystemTime(now);
    const scheduled = israelToUtc(2026, 6, 7, 22, 30);

    meetingsQueue = [[], [makeMeeting(scheduled)]];

    await checkAndSendReminders();

    expect(mockSend).toHaveBeenCalledTimes(1);
    const body: string = mockSend.mock.calls[0][1];
    expect(body).toContain("שעה ו-30 דקות");
  });
});

describe("checkAndSendReminders — 1h early-morning skip", () => {
  beforeEach(() => { vi.useFakeTimers(); resetState(); });
  afterEach(() => vi.useRealTimers());

  it("meeting at Israel 06:00 (natural 05:00 → clamp 07:00 >= meeting): NO send; reminder_1h_sent set true", async () => {
    // now = Israel 05:30 (UTC 02:30); meeting at Israel 06:00 (UTC 03:00) is within the +3h window
    const now = new Date(Date.UTC(2026, 5, 7, 2, 30, 0));
    vi.setSystemTime(now);
    const scheduled = israelToUtc(2026, 6, 7, 6, 0);

    meetingsQueue = [[], [makeMeeting(scheduled)]];

    await checkAndSendReminders();

    expect(mockSend).not.toHaveBeenCalled();
    expect(updateCalls.some((u) => u.flag === "reminder_1h_sent")).toBe(true);
  });
});

describe("checkAndSendReminders — defer does not set flag", () => {
  beforeEach(() => { vi.useFakeTimers(); resetState(); });
  afterEach(() => vi.useRealTimers());

  it("24h clamp-up at Israel 06:30: no send AND meetings.update not called", async () => {
    const now = new Date(Date.UTC(2026, 5, 7, 3, 30, 0));   // Israel 06:30
    vi.setSystemTime(now);
    const scheduled = israelToUtc(2026, 6, 8, 6, 0);

    meetingsQueue = [[makeMeeting(scheduled)], []];

    await checkAndSendReminders();

    expect(mockSend).not.toHaveBeenCalled();
    expect(updateCalls).toHaveLength(0);
  });
});
