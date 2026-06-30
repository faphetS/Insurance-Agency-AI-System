import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const { mockPoolQuery } = vi.hoisted(() => ({
  mockPoolQuery: vi.fn(),
}));

vi.mock("../../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../lib/db.js", () => ({
  pool: { query: mockPoolQuery },
}));

// ---------------------------------------------------------------------------
// Subject import (after mocks)
// ---------------------------------------------------------------------------
import { zadarmaController } from "./zadarma.controller.js";

// ---------------------------------------------------------------------------
// Minimal req/res helpers
// ---------------------------------------------------------------------------

function makeRes() {
  const res = {
    _status: 200,
    _body: undefined as unknown,
    _type: undefined as string | undefined,
    status(code: number) {
      this._status = code;
      return this;
    },
    json(body: unknown) {
      this._body = body;
      return this;
    },
    type(t: string) {
      this._type = t;
      return this;
    },
    send(body: unknown) {
      this._body = body;
      return this;
    },
  };
  return res;
}

function makeReq(overrides: { query?: Record<string, unknown>; body?: unknown } = {}) {
  return {
    query: overrides.query ?? {},
    body: overrides.body ?? {},
  } as unknown as import("express").Request;
}

// ---------------------------------------------------------------------------
// handleVerification
// ---------------------------------------------------------------------------

describe("zadarmaController.handleVerification", () => {
  it("echoes zd_echo exactly as text/plain", () => {
    const req = makeReq({ query: { zd_echo: "abc123" } });
    const res = makeRes();

    zadarmaController.handleVerification(req, res as unknown as import("express").Response);

    expect(res._type).toBe("text/plain");
    expect(res._body).toBe("abc123");
  });

  it("echoes an arbitrary token without modification", () => {
    const token = "xK9-mN2_pQ7!rT4";
    const req = makeReq({ query: { zd_echo: token } });
    const res = makeRes();

    zadarmaController.handleVerification(req, res as unknown as import("express").Response);

    expect(res._body).toBe(token);
  });

  it("returns 200 JSON when zd_echo is absent", () => {
    const req = makeReq({ query: {} });
    const res = makeRes();

    zadarmaController.handleVerification(req, res as unknown as import("express").Response);

    expect(res._status).toBe(200);
    expect(res._body).toEqual({ ok: true });
    expect(res._type).toBeUndefined();
  });

  it("returns 200 JSON when zd_echo is not a string (array case)", () => {
    const req = makeReq({ query: { zd_echo: ["a", "b"] } });
    const res = makeRes();

    zadarmaController.handleVerification(req, res as unknown as import("express").Response);

    expect(res._status).toBe(200);
    expect(res._body).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// handleCallWebhook — zd_echo on POST (defensive re-verify)
// ---------------------------------------------------------------------------

describe("zadarmaController.handleCallWebhook — POST with zd_echo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("echoes zd_echo as text/plain when present on POST", async () => {
    const req = makeReq({ query: { zd_echo: "verify99" }, body: {} });
    const res = makeRes();

    await zadarmaController.handleCallWebhook(req, res as unknown as import("express").Response);

    expect(res._type).toBe("text/plain");
    expect(res._body).toBe("verify99");
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it("returns 200 JSON for a normal call event POST (no zd_echo)", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });

    const req = makeReq({
      query: {},
      body: {
        event: "NOTIFY_END",
        pbx_call_id: "in_abc",
        caller_id: "+972501234567",
        call_start: "2026-06-30 15:26:41",
        disposition: "cancel",
      },
    });
    const res = makeRes();

    await zadarmaController.handleCallWebhook(req, res as unknown as import("express").Response);

    expect(res._status).toBe(200);
    expect(res._body).toEqual({ ok: true });
  });
});
