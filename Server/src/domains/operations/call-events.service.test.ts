import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock functions
// ---------------------------------------------------------------------------
const { mockPoolQuery, mockFromImpl } = vi.hoisted(() => ({
  mockPoolQuery: vi.fn(),
  mockFromImpl: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks — declared before project imports
// ---------------------------------------------------------------------------
vi.mock("../../config/env.js", () => ({
  env: {
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://test",
    DATABASE_POOL_MAX: 5,
    GREENAPI_OP_ID_INSTANCE: "7103519997",
  },
}));

vi.mock("../../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../config/supabase.js", () => ({
  supabaseAdmin: { from: mockFromImpl },
}));

vi.mock("../../lib/db.js", () => ({
  pool: { query: mockPoolQuery },
}));

// ---------------------------------------------------------------------------
// Subject imports (after mocks)
// ---------------------------------------------------------------------------
import { recordCallEvent, getMissedDeclinedSince } from "./call-events.service.js";

// ---------------------------------------------------------------------------
// Builder shim
// ---------------------------------------------------------------------------
type Builder = Record<string, unknown>;

function makeBuilder(result: unknown): Builder {
  const terminal = vi.fn().mockResolvedValue(result);
  const builder: Builder = {};
  const chainMethods = [
    "select", "eq", "neq", "is", "in", "gte", "lte",
    "order", "insert", "upsert", "update", "limit",
  ];
  for (const m of chainMethods) {
    builder[m] = vi.fn().mockReturnValue(builder);
  }
  builder["maybeSingle"] = terminal;
  builder["single"] = terminal;
  builder["then"] = (onFulfilled: (v: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled);
  return builder;
}

// ---------------------------------------------------------------------------
// Tests: recordCallEvent
// ---------------------------------------------------------------------------

describe("recordCallEvent — status mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPoolQuery.mockResolvedValue({ rows: [] });
  });

  const BASE = {
    instanceData: { idInstance: "7103519997" },
    from: "972501234567@c.us",
    timestamp: 1700000000,
    isVideo: false,
  };

  it("maps offer → ringing (incoming)", async () => {
    await recordCallEvent({ ...BASE, typeWebhook: "incomingCall", idMessage: "msg-offer", status: "offer" });
    expect(mockPoolQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("ON CONFLICT");
    expect(params[3]).toBe("972501234567@c.us"); // counterpart_phone
    expect(params[4]).toBe("ringing");
    expect(params[2]).toBe("incoming");
  });

  it("maps pickUp → accepted", async () => {
    await recordCallEvent({ ...BASE, typeWebhook: "incomingCall", idMessage: "msg-pickup", status: "pickUp" });
    const [, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(params[4]).toBe("accepted");
  });

  it("maps hangUp → declined", async () => {
    await recordCallEvent({ ...BASE, typeWebhook: "incomingCall", idMessage: "msg-hangup", status: "hangUp" });
    const [, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(params[4]).toBe("declined");
  });

  it("maps declined → missed", async () => {
    await recordCallEvent({ ...BASE, typeWebhook: "incomingCall", idMessage: "msg-declined", status: "declined" });
    const [, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(params[4]).toBe("missed");
  });

  it("skips when idMessage is missing", async () => {
    await recordCallEvent({ ...BASE, typeWebhook: "incomingCall", status: "offer" });
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it("skips when status is unmappable", async () => {
    await recordCallEvent({ ...BASE, typeWebhook: "incomingCall", idMessage: "msg-x", status: "unknown_status" });
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it("sets direction=outgoing and extracts counterpart from participants", async () => {
    await recordCallEvent({
      ...BASE,
      typeWebhook: "outgoingCall",
      idMessage: "msg-out",
      status: "pickUp",
      participants: [{ id: "972509876543@c.us", status: "pickUp" }],
    });
    const [, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(params[2]).toBe("outgoing");
    expect(params[3]).toBe("972509876543@c.us");
    expect(params[4]).toBe("accepted");
  });

  it("does not throw when pool.query rejects", async () => {
    mockPoolQuery.mockRejectedValueOnce(new Error("DB down"));
    await expect(
      recordCallEvent({ ...BASE, typeWebhook: "incomingCall", idMessage: "msg-err", status: "offer" }),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: getMissedDeclinedSince
// ---------------------------------------------------------------------------

describe("getMissedDeclinedSince", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("queries with direction=incoming, status IN missed/declined, gte called_at, ordered ASC", async () => {
    const rows = [
      { counterpart_phone: "97250111@c.us", called_at: "2026-06-25T09:00:00Z" },
      { counterpart_phone: "97250222@c.us", called_at: "2026-06-25T10:00:00Z" },
    ];

    const builder = makeBuilder({ data: rows, error: null });
    mockFromImpl.mockReturnValue(builder);

    const iso = "2026-06-25T08:00:00Z";
    const result = await getMissedDeclinedSince(iso);

    expect(mockFromImpl).toHaveBeenCalledWith("call_events");
    expect(builder["select"]).toHaveBeenCalledWith("counterpart_phone, called_at");
    expect(builder["eq"]).toHaveBeenCalledWith("direction", "incoming");
    expect(builder["in"]).toHaveBeenCalledWith("status", ["missed", "declined"]);
    expect(builder["gte"]).toHaveBeenCalledWith("called_at", iso);
    expect(builder["order"]).toHaveBeenCalledWith("called_at", { ascending: true });
    expect(result).toEqual(rows);
  });

  it("returns [] when query errors", async () => {
    const builder = makeBuilder({ data: null, error: { message: "fail" } });
    mockFromImpl.mockReturnValue(builder);

    const result = await getMissedDeclinedSince("2026-06-25T08:00:00Z");
    expect(result).toEqual([]);
  });

  it("returns [] when data is null without error", async () => {
    const builder = makeBuilder({ data: null, error: null });
    mockFromImpl.mockReturnValue(builder);

    const result = await getMissedDeclinedSince("2026-06-25T08:00:00Z");
    expect(result).toEqual([]);
  });
});
