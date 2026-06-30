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
import { getUnresolvedMissedSince } from "./call-events.service.js";

// ---------------------------------------------------------------------------
// Tests: getUnresolvedMissedSince
// ---------------------------------------------------------------------------

describe("getUnresolvedMissedSince", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns rows from pool.query", async () => {
    mockPoolQuery.mockResolvedValue({
      rows: [{ counterpart_phone: "97250111@c.us", called_at: "2026-06-25T09:00:00Z" }],
    });

    const iso = "2026-06-25T08:00:00Z";
    const result = await getUnresolvedMissedSince(iso);

    expect(result).toEqual([{ counterpart_phone: "97250111@c.us", called_at: "2026-06-25T09:00:00Z" }]);
    expect(mockPoolQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("call_events");
    expect(sql).toContain("missed");
    expect(params).toEqual([iso]);
  });

  it("returns missed row even when a later accepted call to same number exists", async () => {
    mockPoolQuery.mockResolvedValue({
      rows: [{ counterpart_phone: "97250111@c.us", called_at: "2026-06-25T09:00:00Z" }],
    });

    const result = await getUnresolvedMissedSince("2026-06-25T08:00:00Z");
    expect(result).toHaveLength(1);
    expect(result[0]!.counterpart_phone).toBe("97250111@c.us");
  });

  it("returns [] when pool.query rejects", async () => {
    mockPoolQuery.mockRejectedValueOnce(new Error("DB down"));

    const result = await getUnresolvedMissedSince("2026-06-25T08:00:00Z");
    expect(result).toEqual([]);
  });
});
