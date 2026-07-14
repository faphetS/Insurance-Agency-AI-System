import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockMirrorInbound } = vi.hoisted(() => ({
  mockMirrorInbound: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../config/env.js", () => ({ env: {} }));
vi.mock("../../config/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../chatwoot/chatwoot.service.js", () => ({
  mirrorInbound: mockMirrorInbound,
  mirrorOutbound: vi.fn().mockResolvedValue(undefined),
}));

import { mirrorInboundHook } from "./transport.resolve.js";

describe("mirrorInboundHook", () => {
  beforeEach(() => {
    mockMirrorInbound.mockClear();
  });

  it("prefers buttonTitle over the raw button id for the Chatwoot mirror", async () => {
    await mirrorInboundHook(
      "972500000000@c.us",
      { kind: "text", text: "meeting_didi", isButtonReply: true, buttonTitle: "בקשת תיאום פגישה עם דידי" },
    );

    expect(mockMirrorInbound).toHaveBeenCalledWith(
      "972500000000@c.us",
      "בקשת תיאום פגישה עם דידי",
      undefined,
    );
  });

  it("falls back to the raw text when buttonTitle is absent", async () => {
    await mirrorInboundHook("972500000000@c.us", { kind: "text", text: "שלום" });

    expect(mockMirrorInbound).toHaveBeenCalledWith("972500000000@c.us", "שלום", undefined);
  });
});
