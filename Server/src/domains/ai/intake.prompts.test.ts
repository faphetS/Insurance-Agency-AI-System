import { describe, it, expect } from "vitest";
import { INQUIRY_TYPES, INQUIRY_TYPE_HE } from "./intake.prompts.js";

describe("INQUIRY_TYPE_HE", () => {
  it("has an entry for every value in INQUIRY_TYPES (exhaustiveness)", () => {
    for (const type of INQUIRY_TYPES) {
      expect(INQUIRY_TYPE_HE).toHaveProperty(type);
      expect(typeof INQUIRY_TYPE_HE[type]).toBe("string");
      expect(INQUIRY_TYPE_HE[type]!.length).toBeGreaterThan(0);
    }
  });

  it("covers exactly the 7 new button ids", () => {
    expect(Object.keys(INQUIRY_TYPE_HE)).toHaveLength(INQUIRY_TYPES.length);
  });

  it("maps vehicle → ביטוח רכב", () => {
    expect(INQUIRY_TYPE_HE.vehicle).toBe("ביטוח רכב");
  });

  it("maps home → ביטוח דירה", () => {
    expect(INQUIRY_TYPE_HE.home).toBe("ביטוח דירה");
  });

  it("maps life_health_pension → ביטוח חיים/בריאות/פנסיה", () => {
    expect(INQUIRY_TYPE_HE.life_health_pension).toBe("ביטוח חיים/בריאות/פנסיה");
  });

  it("maps other → אחר", () => {
    expect(INQUIRY_TYPE_HE.other).toBe("אחר");
  });
});
