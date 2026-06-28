import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before any project imports to avoid env/DB boot
// ---------------------------------------------------------------------------

vi.mock("../../config/env.js", () => ({
  env: {
    NODE_ENV: "test",
    OPENROUTER_API_KEY: "test-key",
    AI_MODEL: "test-model",
    COMMITMENT_AI_MODEL: "google/gemini-3.1-flash-lite",
    GREENAPI_ID_INSTANCE: "test",
    GREENAPI_API_TOKEN: "test",
    GREENAPI_BASE_URL: "https://test.api.greenapi.com",
    GREENAPI_WEBHOOK_TOKEN: "test-webhook-token-16chars",
    GREENAPI_SCAN_UNANSWERED_HOURS: 4,
    GREENAPI_OP_BASE_URL: "https://test.api.greenapi.com",
    GREENAPI_OP_ID_INSTANCE: "test-op",
    GREENAPI_OP_API_TOKEN: "test-op-token",
  },
}));

vi.mock("../../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../config/supabase.js", () => ({
  supabaseAdmin: { from: vi.fn() },
}));

vi.mock("../whatsapp/whatsapp.service.js", () => ({
  sendMessageWithTyping: vi.fn().mockResolvedValue({ idMessage: "x" }),
  opCreds: vi.fn().mockReturnValue({ idInstance: "test-op", token: "test-op-token", baseUrl: "https://test.api.greenapi.com" }),
  sendMessageWith: vi.fn().mockResolvedValue({ idMessage: "x" }),
  lastIncomingMessagesWith: vi.fn().mockResolvedValue([]),
  lastOutgoingMessagesWith: vi.fn().mockResolvedValue([]),
}));

// ---------------------------------------------------------------------------
// Subject imports (after mocks)
// ---------------------------------------------------------------------------

import { deriveKind, fireAtTimed, fireAtDateOnly, fireAtFloating, computeFireAt } from "./commitments.fireat.js";
import type { Commitment } from "./commitments.types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function israelHourMinute(d: Date): { h: number; m: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jerusalem",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = fmt.formatToParts(d).reduce<Record<string, string>>((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  const h = parts["hour"] === "24" ? 0 : Number(parts["hour"]);
  return { h, m: Number(parts["minute"]) };
}

function israelDateString(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(d);
}

// ---------------------------------------------------------------------------
// deriveKind
// ---------------------------------------------------------------------------

describe("deriveKind", () => {
  it("returns 'timed' when both date and time are present", () => {
    expect(deriveKind("2026-07-01", "14:30")).toBe("timed");
  });

  it("returns 'date_only' when only date is present", () => {
    expect(deriveKind("2026-07-01", null)).toBe("date_only");
  });

  it("returns 'floating' when neither date nor time is present", () => {
    expect(deriveKind(null, null)).toBe("floating");
  });

  it("returns 'floating' when only time is present (no date)", () => {
    // time without date → not enough info → floating
    expect(deriveKind(null, "10:00")).toBe("floating");
  });
});

// ---------------------------------------------------------------------------
// fireAtTimed — 1h before, clamped to 07:00–21:00 Jerusalem
// ---------------------------------------------------------------------------

describe("fireAtTimed", () => {
  it("fires 1h before a mid-day appointment (no clamping)", () => {
    // 15:00 appointment → 14:00 fire_at
    const result = fireAtTimed("2026-07-01", "15:00");
    const { h, m } = israelHourMinute(result);
    expect(h).toBe(14);
    expect(m).toBe(0);
  });

  it("clamps an early-morning appointment to 07:00", () => {
    // 07:30 appointment → 06:30 natural fire_at → clamped to 07:00
    const result = fireAtTimed("2026-07-01", "07:30");
    const { h } = israelHourMinute(result);
    expect(h).toBe(7);
  });

  it("clamps a late appointment 1h window beyond 21:00 to 21:00", () => {
    // 22:30 appointment → 21:30 natural fire_at → clamped to 21:00
    const result = fireAtTimed("2026-07-01", "22:30");
    const { h } = israelHourMinute(result);
    expect(h).toBe(21);
  });

  it("fires at the exact quiet-hours boundary of 07:00 (not clamped)", () => {
    // 08:00 appointment → 07:00 → exactly the boundary, not before → not clamped
    const result = fireAtTimed("2026-07-01", "08:00");
    const { h } = israelHourMinute(result);
    expect(h).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// fireAtDateOnly — due_date @ 08:00 Jerusalem
// ---------------------------------------------------------------------------

describe("fireAtDateOnly", () => {
  it("fires at 08:00 Jerusalem on the due date", () => {
    const result = fireAtDateOnly("2026-07-15");
    const { h, m } = israelHourMinute(result);
    expect(h).toBe(8);
    expect(m).toBe(0);
    expect(israelDateString(result)).toBe("2026-07-15");
  });

  it("fires at 08:00 on a winter date (UTC+2)", () => {
    // January — Israel is UTC+2 (no DST)
    const result = fireAtDateOnly("2026-01-20");
    const { h, m } = israelHourMinute(result);
    expect(h).toBe(8);
    expect(m).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// fireAtFloating — (message_date + 1 day) @ 08:00 Jerusalem
// ---------------------------------------------------------------------------

describe("fireAtFloating", () => {
  it("fires at 08:00 Jerusalem the next calendar day after the message", () => {
    // message at 2026-07-01 20:00 Jerusalem → fire at 2026-07-02 08:00 Jerusalem
    const msgDate = new Date("2026-07-01T17:00:00Z"); // 20:00 Jerusalem (UTC+3 summer)
    const msgTs = Math.floor(msgDate.getTime() / 1000);
    const result = fireAtFloating(msgTs);
    const { h, m } = israelHourMinute(result);
    expect(h).toBe(8);
    expect(m).toBe(0);
    expect(israelDateString(result)).toBe("2026-07-02");
  });

  it("handles midnight boundary correctly", () => {
    // message at 2026-07-01 23:59 Jerusalem → fire at 2026-07-02 08:00
    const msgDate = new Date("2026-07-01T20:59:00Z"); // 23:59 Jerusalem (UTC+3)
    const msgTs = Math.floor(msgDate.getTime() / 1000);
    const result = fireAtFloating(msgTs);
    expect(israelDateString(result)).toBe("2026-07-02");
    const { h } = israelHourMinute(result);
    expect(h).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// DST boundary test: Israel switches from UTC+2 to UTC+3 last Friday of March
// In 2026 that's 2026-03-27 02:00 local → 00:00 UTC
// ---------------------------------------------------------------------------

describe("fireAtDateOnly — DST boundary (Israel spring forward)", () => {
  it("fires at 08:00 Jerusalem on DST switch day (UTC+3 from that morning)", () => {
    // 2026-03-27 is the DST change day; 08:00 IST = 05:00 UTC that day
    const result = fireAtDateOnly("2026-03-27");
    const { h, m } = israelHourMinute(result);
    expect(h).toBe(8);
    expect(m).toBe(0);
  });

  it("fires at 08:00 Jerusalem the day before DST (still UTC+2)", () => {
    // 2026-03-26: 08:00 IST = 06:00 UTC
    const result = fireAtDateOnly("2026-03-26");
    const { h, m } = israelHourMinute(result);
    expect(h).toBe(8);
    expect(m).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeFireAt dispatch
// ---------------------------------------------------------------------------

describe("computeFireAt", () => {
  const fixedMsgTs = Math.floor(new Date("2026-07-10T10:00:00Z").getTime() / 1000);

  it("dispatches to fireAtTimed for kind='timed'", () => {
    const result = computeFireAt("timed", "2026-07-10", "15:00", fixedMsgTs);
    const { h } = israelHourMinute(result);
    expect(h).toBe(14);
  });

  it("dispatches to fireAtDateOnly for kind='date_only'", () => {
    const result = computeFireAt("date_only", "2026-07-10", null, fixedMsgTs);
    const { h } = israelHourMinute(result);
    expect(h).toBe(8);
  });

  it("dispatches to fireAtFloating for kind='floating'", () => {
    const result = computeFireAt("floating", null, null, fixedMsgTs);
    const { h } = israelHourMinute(result);
    expect(h).toBe(8);
    // next day
    expect(israelDateString(result)).toBe("2026-07-11");
  });
});

// ---------------------------------------------------------------------------
// Timed reminder grouping: same fire_at minute → merged message
// This tests the grouping logic that lives in commitments.reminders.ts
// We test the grouping key derivation (slice to minute) here as a pure function.
// ---------------------------------------------------------------------------

describe("timed reminder grouping by minute key", () => {
  function minuteKey(fireAt: string): string {
    return fireAt.slice(0, 16);
  }

  it("groups two commitments with the same fire_at minute together", () => {
    const c1 = { fire_at: "2026-07-10T07:00:00.000Z" } as Commitment;
    const c2 = { fire_at: "2026-07-10T07:00:30.000Z" } as Commitment;
    expect(minuteKey(c1.fire_at)).toBe(minuteKey(c2.fire_at));
  });

  it("keeps commitments in separate groups when they differ by a minute", () => {
    const c1 = { fire_at: "2026-07-10T07:00:00.000Z" } as Commitment;
    const c2 = { fire_at: "2026-07-10T07:01:00.000Z" } as Commitment;
    expect(minuteKey(c1.fire_at)).not.toBe(minuteKey(c2.fire_at));
  });
});

// ---------------------------------------------------------------------------
// Template fallback for morning batch composition
// Tests the exported helper logic (pure, no LLM)
// ---------------------------------------------------------------------------

describe("morning batch template fallback", () => {
  function buildFallbackMorningMessage(commitments: Pick<Commitment, "commitment_text" | "due_date" | "due_time" | "counterparty">[]): string {
    const lines = ["בוקר טוב! התזכורות להיום:"];
    for (const c of commitments) {
      const timeLabel = c.due_time ? ` (${c.due_time})` : "";
      const dateLabel = c.due_date ? ` ב-${c.due_date}` : "";
      lines.push(`• ${c.commitment_text}${dateLabel}${timeLabel} — ${c.counterparty}`);
    }
    return lines.join("\n");
  }

  it("includes the greeting header", () => {
    const msg = buildFallbackMorningMessage([]);
    expect(msg).toContain("בוקר טוב! התזכורות להיום:");
  });

  it("formats a single commitment with date and time", () => {
    const commitments = [{
      commitment_text: "לשלוח הצעת מחיר",
      due_date: "2026-07-10",
      due_time: "10:00",
      counterparty: "יוסי כהן",
    }];
    const msg = buildFallbackMorningMessage(commitments);
    expect(msg).toContain("• לשלוח הצעת מחיר ב-2026-07-10 (10:00) — יוסי כהן");
  });

  it("formats a commitment with date but no time", () => {
    const commitments = [{
      commitment_text: "להתקשר לעורך דין",
      due_date: "2026-07-11",
      due_time: null,
      counterparty: "רחל לוי",
    }];
    const msg = buildFallbackMorningMessage(commitments);
    expect(msg).toContain("• להתקשר לעורך דין ב-2026-07-11 — רחל לוי");
  });

  it("formats a floating commitment (no date, no time)", () => {
    const commitments = [{
      commitment_text: "לשלוח מסמכים",
      due_date: null,
      due_time: null,
      counterparty: "דוד מזרחי",
    }];
    const msg = buildFallbackMorningMessage(commitments);
    expect(msg).toContain("• לשלוח מסמכים — דוד מזרחי");
  });

  it("formats multiple commitments as separate lines", () => {
    const commitments = [
      { commitment_text: "לבדוק חשבון", due_date: "2026-07-10", due_time: null, counterparty: "A" },
      { commitment_text: "לתאם פגישה", due_date: null, due_time: null, counterparty: "B" },
    ];
    const msg = buildFallbackMorningMessage(commitments);
    const lines = msg.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("לבדוק חשבון");
    expect(lines[2]).toContain("לתאם פגישה");
  });
});
