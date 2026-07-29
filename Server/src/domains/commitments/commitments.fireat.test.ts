import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — declared before project imports to avoid the real env/DB boot
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
  sendMessageWithTyping: vi.fn(),
}));

import { fireAtTimed } from "./commitments.fireat.js";

/** Israel is UTC+3 (IDT) in July 2026 — Israel HH:MM = UTC (HH-3):MM. */
function israelToUtc(year: number, month: number, day: number, h: number, m: number): Date {
  return new Date(Date.UTC(year, month - 1, day, h - 3, m, 0));
}

describe("fireAtTimed — business-hours clamp (09:00-17:00 Israel)", () => {
  it("appointment at Tue 19:30 Israel: natural fire (18:30) is clamped down to 17:00 Israel same day", () => {
    // 2026-07-28 is a Tuesday.
    const fireAt = fireAtTimed("2026-07-28", "19:30");
    expect(fireAt).not.toBeNull();
    const expected = israelToUtc(2026, 7, 28, 17, 0);
    expect(fireAt!.getTime()).toBe(expected.getTime());
  });

  it("appointment at Tue 10:00 Israel: natural fire (09:00) is unclamped", () => {
    const fireAt = fireAtTimed("2026-07-28", "10:00");
    expect(fireAt).not.toBeNull();
    const expected = israelToUtc(2026, 7, 28, 9, 0);
    expect(fireAt!.getTime()).toBe(expected.getTime());
  });

  it("appointment at Tue 09:30 Israel: natural fire (08:30) is clamped up to 09:00 Israel", () => {
    const fireAt = fireAtTimed("2026-07-28", "09:30");
    expect(fireAt).not.toBeNull();
    const expected = israelToUtc(2026, 7, 28, 9, 0);
    expect(fireAt!.getTime()).toBe(expected.getTime());
  });
});

describe("fireAtTimed — early-morning appointment returns null (F3)", () => {
  it("appointment at Tue 08:00 Israel: natural fire (07:00) clamps up to 09:00, which is AFTER the meeting — returns null", () => {
    // 2026-07-28 is a Tuesday. Clamped fire (09:00) >= appointment instant (08:00).
    const fireAt = fireAtTimed("2026-07-28", "08:00");
    expect(fireAt).toBeNull();
  });

  it("appointment at Tue 07:30 Israel: natural fire (06:30) clamps up to 09:00, which is AFTER the meeting — returns null", () => {
    const fireAt = fireAtTimed("2026-07-28", "07:30");
    expect(fireAt).toBeNull();
  });

  it("appointment at Tue 09:00 Israel exactly: natural fire (08:00) clamps up to 09:00, which EQUALS the meeting instant — returns null", () => {
    // clamped.getTime() >= apptInstant.getTime() — equality also counts as "at/after".
    const fireAt = fireAtTimed("2026-07-28", "09:00");
    expect(fireAt).toBeNull();
  });

  it("appointment at Tue 09:01 Israel: clamped fire (09:00) is now strictly before the meeting — returns a Date", () => {
    const fireAt = fireAtTimed("2026-07-28", "09:01");
    expect(fireAt).not.toBeNull();
  });
});
