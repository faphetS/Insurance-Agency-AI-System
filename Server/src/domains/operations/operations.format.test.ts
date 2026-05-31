import { describe, it, expect } from "vitest";
import { TASK_LABELS_HE, formatDueDate } from "./operations.format.js";

describe("TASK_LABELS_HE", () => {
  it("maps forms_check to Hebrew label", () => {
    expect(TASK_LABELS_HE["forms_check"]).toBe("בדיקת טפסים");
  });

  it("maps receipt_check to Hebrew label", () => {
    expect(TASK_LABELS_HE["receipt_check"]).toBe("בדיקת קבלה");
  });

  it("maps policy_check to Hebrew label", () => {
    expect(TASK_LABELS_HE["policy_check"]).toBe("בדיקת פוליסה");
  });

  it("maps deposit_check to Hebrew label", () => {
    expect(TASK_LABELS_HE["deposit_check"]).toBe("בדיקת הפקדה");
  });

  it("maps cross_check to Hebrew label", () => {
    expect(TASK_LABELS_HE["cross_check"]).toBe("הצלבת מסמכים מול Bafi");
  });

  it("returns undefined for unknown keys", () => {
    expect(TASK_LABELS_HE["unknown_task"]).toBeUndefined();
  });
});

describe("formatDueDate", () => {
  it("returns a non-empty Hebrew-locale date string", () => {
    const result = formatDueDate("2025-06-15T00:00:00.000Z");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("contains the year 2025 for a 2025 date", () => {
    const result = formatDueDate("2025-06-15T00:00:00.000Z");
    expect(result).toContain("2025");
  });

  it("produces different strings for different months", () => {
    const jan = formatDueDate("2025-01-10T00:00:00.000Z");
    const jul = formatDueDate("2025-07-10T00:00:00.000Z");
    expect(jan).not.toBe(jul);
  });
});
