import { describe, it, expect, vi } from "vitest";

vi.mock("../../config/supabase.js", () => ({
  supabaseAdmin: {},
}));

import { toChatId } from "./whatsapp.util.js";

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
