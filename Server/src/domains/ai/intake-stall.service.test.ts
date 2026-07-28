import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — notifyOwner (GreenAPI send) is ALWAYS mocked; no live send.
// ---------------------------------------------------------------------------

const { mockFromImpl, mockNotifyOwner, mockBuildStallAlert } = vi.hoisted(() => ({
  mockFromImpl: vi.fn(),
  mockNotifyOwner: vi.fn().mockResolvedValue(true),
  mockBuildStallAlert: vi.fn((phone: string, _name: string | null, slot: string) => `ALERT:${slot}:${phone}`),
}));

vi.mock("../../config/env.js", () => ({
  env: {
    NODE_ENV: "test",
    OP_EXCLUDED_PHONES: [] as string[],
  },
}));
vi.mock("../../config/supabase.js", () => ({
  supabaseAdmin: { from: mockFromImpl },
}));
vi.mock("../../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../operations/owner-notify.js", () => ({ notifyOwner: mockNotifyOwner }));
vi.mock("./intake-notify.service.js", () => ({ buildStallAlert: mockBuildStallAlert }));

import { checkIntakeStalls } from "./intake-stall.service.js";

// ---------------------------------------------------------------------------
// Builder shim
// ---------------------------------------------------------------------------

function makeBuilder(result: unknown) {
  const b: Record<string, unknown> = {};
  const chain = ["select", "eq", "neq", "is", "not", "in", "gte", "lte", "lt", "gt", "order", "update"];
  for (const m of chain) b[m] = vi.fn().mockReturnValue(b);
  b["then"] = (resolve: (v: unknown) => void) => Promise.resolve(result).then(resolve);
  return b;
}

function setupFrom(builders: ReturnType<typeof makeBuilder>[]) {
  let i = 0;
  mockFromImpl.mockImplementation(() => {
    const b = builders[i] ?? builders[builders.length - 1]!;
    i++;
    return b;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockNotifyOwner.mockResolvedValue(true);
});

describe("checkIntakeStalls", () => {
  it("notifies the owner and flags each eligible stalled row", async () => {
    const rows = [
      { id: "c1", phone: "972501234567", full_name: "יעל", intake_current_slot: "consent" },
      { id: "c2", phone: "972507654321", full_name: null, intake_current_slot: "id_photo" },
    ];
    const selectBuilder = makeBuilder({ data: rows, error: null });
    const update1 = makeBuilder({ data: null, error: null });
    const update2 = makeBuilder({ data: null, error: null });
    setupFrom([selectBuilder, update1, update2]);

    await checkIntakeStalls();

    expect(mockNotifyOwner).toHaveBeenCalledTimes(2);
    expect(mockBuildStallAlert).toHaveBeenCalledWith("972501234567", "יעל", "consent");
    expect(mockBuildStallAlert).toHaveBeenCalledWith("972507654321", null, "id_photo");

    const upd1 = update1["update"] as ReturnType<typeof vi.fn>;
    const upd2 = update2["update"] as ReturnType<typeof vi.fn>;
    expect(upd1.mock.calls[0]?.[0]).toHaveProperty("stall_notified_at");
    expect(upd2.mock.calls[0]?.[0]).toHaveProperty("stall_notified_at");
  });

  it("applies the eligibility filters (state, slot, consent_prompted_at, stall_notified_at)", async () => {
    const selectBuilder = makeBuilder({ data: [], error: null });
    setupFrom([selectBuilder]);

    await checkIntakeStalls();

    expect(selectBuilder["eq"]).toHaveBeenCalledWith("intake_state", "collecting");
    expect(selectBuilder["in"]).toHaveBeenCalledWith("intake_current_slot", ["consent", "id_photo"]);
    expect(selectBuilder["not"]).toHaveBeenCalledWith("consent_prompted_at", "is", null);
    expect(selectBuilder["is"]).toHaveBeenCalledWith("stall_notified_at", null);
    const lte = selectBuilder["lte"] as ReturnType<typeof vi.fn>;
    expect(lte.mock.calls[0]?.[0]).toBe("consent_prompted_at");
  });

  it("does nothing when no rows are eligible", async () => {
    const selectBuilder = makeBuilder({ data: [], error: null });
    setupFrom([selectBuilder]);

    await checkIntakeStalls();

    expect(mockNotifyOwner).not.toHaveBeenCalled();
  });

  it("tolerates a null data result", async () => {
    const selectBuilder = makeBuilder({ data: null, error: null });
    setupFrom([selectBuilder]);

    await expect(checkIntakeStalls()).resolves.toBeUndefined();
    expect(mockNotifyOwner).not.toHaveBeenCalled();
  });
});
