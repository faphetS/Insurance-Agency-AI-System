import { describe, it, expect } from "vitest";
import { INQUIRY_TYPES, INQUIRY_TYPE_HE } from "./intake.prompts.js";

describe("INQUIRY_TYPE_HE", () => {
  it("has an entry for every value in INQUIRY_TYPES (exhaustiveness)", () => {
    for (const type of INQUIRY_TYPES) {
      expect(INQUIRY_TYPE_HE).toHaveProperty(type);
      expect(typeof INQUIRY_TYPE_HE[type]).toBe("string");
      expect(INQUIRY_TYPE_HE[type].length).toBeGreaterThan(0);
    }
  });

  it("covers all 10 inquiry types with non-empty Hebrew strings", () => {
    expect(Object.keys(INQUIRY_TYPE_HE)).toHaveLength(INQUIRY_TYPES.length);
  });

  it("maps life → ביטוח חיים", () => {
    expect(INQUIRY_TYPE_HE.life).toBe("ביטוח חיים");
  });

  it("maps vehicle → ביטוח רכב", () => {
    expect(INQUIRY_TYPE_HE.vehicle).toBe("ביטוח רכב");
  });

  it("maps general → כללי", () => {
    expect(INQUIRY_TYPE_HE.general).toBe("כללי");
  });

  it("maps pension → ביטוח פנסיוני", () => {
    expect(INQUIRY_TYPE_HE.pension).toBe("ביטוח פנסיוני");
  });
});
