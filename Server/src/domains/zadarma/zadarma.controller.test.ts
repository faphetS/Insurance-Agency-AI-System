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
import { zadarmaController, isZadarmaIp, resolveClientIp } from "./zadarma.controller.js";

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

function makeReq(overrides: {
  query?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string>;
} = {}) {
  return {
    query: overrides.query ?? {},
    body: overrides.body ?? {},
    headers: overrides.headers ?? {},
  } as unknown as import("express").Request;
}

// A Zadarma IP in the documented /30 block
const ZADARMA_IP = "185.45.152.42";
// An IP outside the block
const OUTSIDE_IP = "1.2.3.4";

// ---------------------------------------------------------------------------
// isZadarmaIp unit tests
// ---------------------------------------------------------------------------

describe("isZadarmaIp", () => {
  it("accepts .40 (block start)", () => expect(isZadarmaIp("185.45.152.40")).toBe(true));
  it("accepts .41", () => expect(isZadarmaIp("185.45.152.41")).toBe(true));
  it("accepts .42", () => expect(isZadarmaIp("185.45.152.42")).toBe(true));
  it("accepts .43 (block end)", () => expect(isZadarmaIp("185.45.152.43")).toBe(true));
  it("rejects .39 (one below start)", () => expect(isZadarmaIp("185.45.152.39")).toBe(false));
  it("rejects .44 (one above end)", () => expect(isZadarmaIp("185.45.152.44")).toBe(false));
  it("rejects a completely different IP", () => expect(isZadarmaIp("1.2.3.4")).toBe(false));
  it("rejects an empty string", () => expect(isZadarmaIp("")).toBe(false));
  it("rejects a malformed IP", () => expect(isZadarmaIp("not-an-ip")).toBe(false));
});

// ---------------------------------------------------------------------------
// resolveClientIp unit tests
// ---------------------------------------------------------------------------

describe("resolveClientIp", () => {
  it("returns x-real-ip when present", () => {
    const req = makeReq({ headers: { "x-real-ip": "185.45.152.41" } });
    expect(resolveClientIp(req)).toBe("185.45.152.41");
  });

  it("returns last x-forwarded-for entry when x-real-ip absent", () => {
    const req = makeReq({ headers: { "x-forwarded-for": "10.0.0.1, 185.45.152.42" } });
    expect(resolveClientIp(req)).toBe("185.45.152.42");
  });

  it("prefers x-real-ip over x-forwarded-for", () => {
    const req = makeReq({
      headers: { "x-real-ip": "185.45.152.40", "x-forwarded-for": "10.0.0.1, 1.2.3.4" },
    });
    expect(resolveClientIp(req)).toBe("185.45.152.40");
  });

  it("returns null when no IP headers present", () => {
    const req = makeReq({ headers: {} });
    expect(resolveClientIp(req)).toBeNull();
  });

  // Fix 1 — IPv4-mapped IPv6 normalisation
  it("strips ::ffff: prefix from x-real-ip (Fix 1)", () => {
    const req = makeReq({ headers: { "x-real-ip": "::ffff:185.45.152.42" } });
    expect(resolveClientIp(req)).toBe("185.45.152.42");
  });

  it("strips ::FFFF: prefix (uppercase) from x-real-ip (Fix 1)", () => {
    const req = makeReq({ headers: { "x-real-ip": "::FFFF:185.45.152.42" } });
    expect(resolveClientIp(req)).toBe("185.45.152.42");
  });

  it("strips ::ffff: prefix from last x-forwarded-for entry (Fix 1)", () => {
    const req = makeReq({ headers: { "x-forwarded-for": "10.0.0.1, ::ffff:185.45.152.43" } });
    expect(resolveClientIp(req)).toBe("185.45.152.43");
  });
});

// ---------------------------------------------------------------------------
// handleVerification (GET) — open, no IP gate
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
// handleCallWebhook (POST) — zd_echo re-verify (happens before IP gate)
// ---------------------------------------------------------------------------

describe("zadarmaController.handleCallWebhook — POST with zd_echo", () => {
  beforeEach(() => vi.clearAllMocks());

  it("echoes zd_echo as text/plain regardless of source IP", async () => {
    const req = makeReq({ query: { zd_echo: "verify99" }, body: {}, headers: { "x-real-ip": OUTSIDE_IP } });
    const res = makeRes();

    await zadarmaController.handleCallWebhook(req, res as unknown as import("express").Response);

    expect(res._type).toBe("text/plain");
    expect(res._body).toBe("verify99");
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleCallWebhook (POST) — IP gate
// ---------------------------------------------------------------------------

describe("zadarmaController.handleCallWebhook — IP gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPoolQuery.mockResolvedValue({ rows: [] });
  });

  const callBody = {
    event: "NOTIFY_END",
    pbx_call_id: "in_ip_test",
    caller_id: "+972501234567",
    disposition: "cancel",
  };

  it("allows a POST from an IP in the Zadarma block (x-real-ip) and returns 200", async () => {
    const req = makeReq({
      query: {},
      body: callBody,
      headers: { "x-real-ip": ZADARMA_IP },
    });
    const res = makeRes();

    await zadarmaController.handleCallWebhook(req, res as unknown as import("express").Response);

    expect(res._status).toBe(200);
    expect(res._body).toEqual({ ok: true });
    expect(mockPoolQuery).toHaveBeenCalledOnce();
  });

  it("allows .40 (block start)", async () => {
    const req = makeReq({ query: {}, body: callBody, headers: { "x-real-ip": "185.45.152.40" } });
    const res = makeRes();
    await zadarmaController.handleCallWebhook(req, res as unknown as import("express").Response);
    expect(res._status).toBe(200);
  });

  it("rejects a POST from an IP outside the block with 403", async () => {
    const req = makeReq({
      query: {},
      body: callBody,
      headers: { "x-real-ip": OUTSIDE_IP },
    });
    const res = makeRes();

    await zadarmaController.handleCallWebhook(req, res as unknown as import("express").Response);

    expect(res._status).toBe(403);
    expect(res._body).toEqual({ ok: false });
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it("rejects when no IP headers are present", async () => {
    const req = makeReq({ query: {}, body: callBody, headers: {} });
    const res = makeRes();

    await zadarmaController.handleCallWebhook(req, res as unknown as import("express").Response);

    expect(res._status).toBe(403);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it("resolves IP from last x-forwarded-for when x-real-ip absent", async () => {
    const req = makeReq({
      query: {},
      body: callBody,
      headers: { "x-forwarded-for": "10.0.0.1, 185.45.152.43" },
    });
    const res = makeRes();

    await zadarmaController.handleCallWebhook(req, res as unknown as import("express").Response);

    expect(res._status).toBe(200);
    expect(mockPoolQuery).toHaveBeenCalledOnce();
  });

  // Fix 1 — IPv4-mapped IPv6 prefix is stripped before the IP gate check
  it("accepts ::ffff:-prefixed Zadarma IP via x-real-ip and calls the DB (Fix 1)", async () => {
    const req = makeReq({
      query: {},
      body: callBody,
      headers: { "x-real-ip": "::ffff:185.45.152.42" },
    });
    const res = makeRes();

    await zadarmaController.handleCallWebhook(req, res as unknown as import("express").Response);

    expect(res._status).toBe(200);
    expect(res._body).toEqual({ ok: true });
    expect(mockPoolQuery).toHaveBeenCalledOnce();
  });
});
