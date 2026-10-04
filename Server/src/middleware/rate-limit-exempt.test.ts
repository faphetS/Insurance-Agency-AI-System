import { describe, it, expect } from "vitest";
import { isRateLimitExempt } from "./rate-limit-exempt.js";

describe("isRateLimitExempt", () => {
  it.each([
    "/whatsapp/webhook",
    "/whatsapp/meta-webhook",
    "/chatwoot/callback/test-path-secret",
    "/zadarma/call-webhook",
  ])("exempts %s", (path) => {
    expect(isRateLimitExempt(path)).toBe(true);
  });

  it.each(["/whatsapp/send", "/chatwoot", "/chatwoot/callback", "/operations/morning-digest/run", "/zadarma"])(
    "still limits %s",
    (path) => {
      expect(isRateLimitExempt(path)).toBe(false);
    },
  );
});
