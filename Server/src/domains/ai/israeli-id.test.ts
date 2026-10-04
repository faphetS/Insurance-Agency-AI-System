import { describe, it, expect } from "vitest";
import { normalizeIsraeliId } from "./israeli-id.js";

// Check digit: weights 1,2,1,2,…; a product above 9 loses 9; the sum must divide by 10.
// 123456782 → 1+4+3+8+5+3+7+7+2 = 40 ✓   123456789 → 47 ✗   012345674 → 30 ✓
describe("normalizeIsraeliId", () => {
  it("accepts a valid 9-digit ת\"ז", () => {
    expect(normalizeIsraeliId("123456782")).toBe("123456782");
  });

  it("left-pads a valid 8-digit ת\"ז to 9 digits", () => {
    expect(normalizeIsraeliId("12345674")).toBe("012345674");
  });

  it("keeps leading zeros", () => {
    expect(normalizeIsraeliId("000000018")).toBe("000000018");
  });

  it("strips spaces and dashes before checking", () => {
    expect(normalizeIsraeliId("12-345 6782")).toBe("123456782");
  });

  it("accepts a JSON number", () => {
    expect(normalizeIsraeliId(123456782)).toBe("123456782");
  });

  it("rejects a failing check digit", () => {
    expect(normalizeIsraeliId("123456789")).toBeNull();
  });

  it("rejects letters (foreign ids are not Israeli ת\"ז)", () => {
    expect(normalizeIsraeliId("A01-2345678")).toBeNull();
  });

  it("rejects a date-looking value", () => {
    expect(normalizeIsraeliId("01-01-1990")).toBeNull();
  });

  it("rejects all zeros (passes the checksum, but is a placeholder)", () => {
    expect(normalizeIsraeliId("000000000")).toBeNull();
    expect(normalizeIsraeliId("00000000")).toBeNull();
  });

  it("rejects too short and too long", () => {
    expect(normalizeIsraeliId("1234567")).toBeNull();
    expect(normalizeIsraeliId("1234567890")).toBeNull();
  });

  it("rejects null, undefined and objects", () => {
    expect(normalizeIsraeliId(null)).toBeNull();
    expect(normalizeIsraeliId(undefined)).toBeNull();
    expect(normalizeIsraeliId({})).toBeNull();
  });
});
