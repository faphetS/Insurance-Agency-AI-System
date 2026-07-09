import { describe, it, expect, vi } from "vitest";

vi.mock("../../config/supabase.js", () => ({
  supabaseAdmin: {},
}));

import { toChatId, toLocalPhone, displayName } from "./whatsapp.util.js";

describe("toChatId", () => {
  it("normalizes 0xx Israeli mobile to 972xx@c.us", () => {
    expect(toChatId("0501234567")).toBe("972501234567@c.us");
  });

  it("keeps 972xx number as-is", () => {
    expect(toChatId("972501234567")).toBe("972501234567@c.us");
  });

  it("prepends 972 to a bare 9-digit number", () => {
    expect(toChatId("501234567")).toBe("972501234567@c.us");
  });

  it("returns null for null input", () => {
    expect(toChatId(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(toChatId(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(toChatId("")).toBeNull();
  });

  it("returns null for junk string with no digits", () => {
    expect(toChatId("abc-xyz")).toBeNull();
  });

  it("returns null when normalized number is shorter than 11 digits", () => {
    // 4 digits — too short after normalization
    expect(toChatId("1234")).toBeNull();
  });

  it("strips non-digit characters before normalising", () => {
    expect(toChatId("+972-50-123-4567")).toBe("972501234567@c.us");
  });

  it("handles 0xx with formatting chars", () => {
    expect(toChatId("050-123-4567")).toBe("972501234567@c.us");
  });
});

describe("toLocalPhone", () => {
  it("converts 972 prefix to local 05X-XXXXXXX", () => {
    expect(toLocalPhone("972501234567")).toBe("050-1234567");
  });

  it("formats a bare 0-prefixed 10-digit number", () => {
    expect(toLocalPhone("0501234567")).toBe("050-1234567");
  });

  it("strips non-digit characters before formatting", () => {
    expect(toLocalPhone("+972-50-123-4567")).toBe("050-1234567");
  });

  it("returns the raw digits when not a 10-digit 0-number", () => {
    expect(toLocalPhone("12345")).toBe("12345");
  });

  it("returns empty string for null/undefined", () => {
    expect(toLocalPhone(null)).toBe("");
    expect(toLocalPhone(undefined)).toBe("");
  });
});

describe("displayName", () => {
  it("returns the trimmed name when it differs from the phone", () => {
    expect(displayName("  יעל כהן  ", "972501234567")).toBe("יעל כהן");
  });

  it("returns null when the name digits equal the phone digits", () => {
    expect(displayName("972501234567", "972501234567")).toBeNull();
    expect(displayName("+972-50-123-4567", "972501234567")).toBeNull();
  });

  it("returns null for empty/missing name", () => {
    expect(displayName("", "972501234567")).toBeNull();
    expect(displayName(null, "972501234567")).toBeNull();
    expect(displayName(undefined, null)).toBeNull();
  });
});
