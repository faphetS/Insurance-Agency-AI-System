import { describe, it, expect, vi } from "vitest";

vi.mock("../../config/env.js", () => ({
  env: {
    NODE_ENV: "test",
  },
}));

vi.mock("../../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../config/supabase.js", () => ({
  supabaseAdmin: { from: vi.fn() },
}));

vi.mock("../whatsapp/whatsapp.service.js", () => ({
  sendMessageWithTyping: vi.fn(),
}));

import { isOpWeekday, isWithinOpWindow, isIsraelSunday } from "./op-hours.js";

// Israel is UTC+3 (IDT) in July 2026 — Israel HH:MM = UTC (HH-3):MM.
function israelToUtc(year: number, month: number, day: number, h: number, m: number): Date {
  return new Date(Date.UTC(year, month - 1, day, h - 3, m, 0));
}

describe("isOpWeekday / isWithinOpWindow", () => {
  it("Thursday 18:00 Israel is inside the window", () => {
    // 2026-07-30 is a Thursday.
    const d = israelToUtc(2026, 7, 30, 18, 0);
    expect(isOpWeekday(d)).toBe(true);
    expect(isWithinOpWindow(d)).toBe(true);
  });

  it("Thursday 18:01 Israel is outside the window (after close)", () => {
    const d = israelToUtc(2026, 7, 30, 18, 1);
    expect(isOpWeekday(d)).toBe(true);
    expect(isWithinOpWindow(d)).toBe(false);
  });

  it("Friday 12:00 Israel is outside the window and not a weekday (weekend)", () => {
    // 2026-07-31 is a Friday.
    const d = israelToUtc(2026, 7, 31, 12, 0);
    expect(isOpWeekday(d)).toBe(false);
    expect(isWithinOpWindow(d)).toBe(false);
  });

  it("Sunday 08:59 Israel is a weekday but outside the window (before open)", () => {
    // 2026-08-02 is a Sunday.
    const d = israelToUtc(2026, 8, 2, 8, 59);
    expect(isOpWeekday(d)).toBe(true);
    expect(isWithinOpWindow(d)).toBe(false);
  });

  it("Sunday 09:00 Israel is inside the window (open)", () => {
    const d = israelToUtc(2026, 8, 2, 9, 0);
    expect(isOpWeekday(d)).toBe(true);
    expect(isWithinOpWindow(d)).toBe(true);
  });

  it("UNANSWERED_WINDOW_DISABLED short-circuits BOTH isOpWeekday and isWithinOpWindow on a Friday", async () => {
    const { env } = await import("../../config/env.js");
    (env as Record<string, unknown>)["UNANSWERED_WINDOW_DISABLED"] = "1";

    try {
      const friday = israelToUtc(2026, 7, 31, 12, 0);
      expect(isWithinOpWindow(friday)).toBe(true);
      expect(isOpWeekday(friday)).toBe(true);
    } finally {
      (env as Record<string, unknown>)["UNANSWERED_WINDOW_DISABLED"] = undefined;
    }
  });

  it("isIsraelSunday is NOT bypassed by UNANSWERED_WINDOW_DISABLED — it's lookback arithmetic, not policy", async () => {
    const { env } = await import("../../config/env.js");
    (env as Record<string, unknown>)["UNANSWERED_WINDOW_DISABLED"] = "1";

    try {
      const friday = israelToUtc(2026, 7, 31, 12, 0);
      const sunday = israelToUtc(2026, 8, 2, 10, 0);
      expect(isIsraelSunday(friday)).toBe(false);
      expect(isIsraelSunday(sunday)).toBe(true);
    } finally {
      (env as Record<string, unknown>)["UNANSWERED_WINDOW_DISABLED"] = undefined;
    }
  });
});

describe("isIsraelSunday", () => {
  it("returns true on Sunday", () => {
    // 2026-08-02 is a Sunday.
    expect(isIsraelSunday(israelToUtc(2026, 8, 2, 10, 0))).toBe(true);
  });

  it("returns false on a weekday", () => {
    // 2026-07-30 is a Thursday.
    expect(isIsraelSunday(israelToUtc(2026, 7, 30, 10, 0))).toBe(false);
  });

  it("returns false on the weekend (Saturday)", () => {
    // 2026-08-01 is a Saturday.
    expect(isIsraelSunday(israelToUtc(2026, 8, 1, 10, 0))).toBe(false);
  });
});
