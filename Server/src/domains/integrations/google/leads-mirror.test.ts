import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// vi.hoisted shared mock functions
// ---------------------------------------------------------------------------
const { mockFromImpl, mockUpsertLeadRow } = vi.hoisted(() => ({
  mockFromImpl: vi.fn(),
  mockUpsertLeadRow: vi.fn(),
}));

vi.mock("../../../config/env.js", () => ({
  env: {
    LEADS_MIRROR_ENABLED: true,
    LEADS_SPREADSHEET_ID: "sheet-id",
    LEADS_SHEET_TAB: "לידים חדשים",
    LEADS_SHEET_TAB_NEW: "לידים חדשים",
    LEADS_DRIVE_FOLDER_ID: "folder-id",
    NODE_ENV: "test",
  },
}));

vi.mock("../../../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../../config/supabase.js", () => ({
  supabaseAdmin: { from: mockFromImpl },
}));

vi.mock("./google.sheets.js", () => ({
  upsertLeadRow: mockUpsertLeadRow,
  appendLeadRow: vi.fn(),
  resolveLeadsTabTitle: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Builder shim helpers
// ---------------------------------------------------------------------------
type Builder = Record<string, unknown>;

function makeBuilder(result: unknown): Builder {
  const terminal = vi.fn().mockResolvedValue(result);
  const builder: Builder = {};
  const chainMethods = ["select", "eq", "neq", "is", "not", "in", "gte", "lte", "order", "insert", "upsert", "update", "limit"];
  for (const m of chainMethods) builder[m] = vi.fn().mockReturnValue(builder);
  builder["maybeSingle"] = terminal;
  builder["single"] = terminal;
  builder["then"] = (onFulfilled: (v: unknown) => unknown) => Promise.resolve(result).then(onFulfilled);
  return builder;
}

function setupFromSequence(builders: Builder[]): void {
  let callIndex = 0;
  mockFromImpl.mockImplementation(() => {
    const b = builders[callIndex] ?? builders[builders.length - 1];
    callIndex++;
    return b;
  });
}

import { mirrorLeadToSheet } from "./leads-mirror.service.js";

const CLIENT_ID = "client-abc-123";

function clientRow(over: Record<string, unknown>) {
  return {
    phone: "972501234567",
    full_name: "יעל כהן",
    inquiry_type: "vehicle",
    client_type: null,
    id_photo_url: null,
    id_number: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 7-column progressive upsert into the new-leads tab (EVERY branch)
// ---------------------------------------------------------------------------

describe("mirrorLeadToSheet — 7-col row into the new-leads tab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpsertLeadRow.mockResolvedValue(true);
  });

  it("builds A→G with insurance label, id photo, id number, empty relevance, creation date", async () => {
    setupFromSequence([
      makeBuilder({
        data: clientRow({
          inquiry_type: "life_health_pension",
          id_photo_url: "https://drive.google.com/file/d/abc/view",
          id_number: "123456789",
          client_type: "new",
        }),
        error: null,
      }),
    ]);

    await mirrorLeadToSheet(CLIENT_ID);

    expect(mockUpsertLeadRow).toHaveBeenCalledOnce();
    const [row, tab, opts] = mockUpsertLeadRow.mock.calls[0] as [string[], string, { setOnceColumns: number[] }];
    expect(row).toHaveLength(7);
    expect(row[0]).toBe("972501234567"); // A phone
    expect(row[1]).toBe("יעל כהן"); // B name
    expect(row[2]).toBe("ביטוח חיים/בריאות/פנסיה"); // C inquiry
    expect(row[3]).toBe("https://drive.google.com/file/d/abc/view"); // D id photo
    expect(row[4]).toBe("123456789"); // E id number
    expect(row[5]).toBe(""); // F relevance (manual — always blank)
    expect(row[6]).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/); // G creation date
    expect(tab).toBe("לידים חדשים");
    expect(opts).toEqual({ setOnceColumns: [6] });
  });

  it("col B is empty when full_name equals the phone (never echoes the phone)", async () => {
    setupFromSequence([
      makeBuilder({ data: clientRow({ full_name: "972501234567" }), error: null }),
    ]);

    await mirrorLeadToSheet(CLIENT_ID);

    const [row] = mockUpsertLeadRow.mock.calls[0] as [string[]];
    expect(row[1]).toBe("");
  });

  it("callback inquiry → col C 'בקשת שיחה חוזרת'", async () => {
    setupFromSequence([makeBuilder({ data: clientRow({ inquiry_type: "callback" }), error: null })]);
    await mirrorLeadToSheet(CLIENT_ID);
    const [row] = mockUpsertLeadRow.mock.calls[0] as [string[]];
    expect(row[2]).toBe("בקשת שיחה חוזרת");
  });

  it("meeting + client_type old → 'תיאום פגישה — לקוח קיים'", async () => {
    setupFromSequence([makeBuilder({ data: clientRow({ inquiry_type: "meeting", client_type: "old" }), error: null })]);
    await mirrorLeadToSheet(CLIENT_ID);
    const [row] = mockUpsertLeadRow.mock.calls[0] as [string[]];
    expect(row[2]).toBe("תיאום פגישה — לקוח קיים");
  });

  it("meeting + client_type new → 'תיאום פגישה — לקוח חדש'", async () => {
    setupFromSequence([makeBuilder({ data: clientRow({ inquiry_type: "meeting", client_type: "new" }), error: null })]);
    await mirrorLeadToSheet(CLIENT_ID);
    const [row] = mockUpsertLeadRow.mock.calls[0] as [string[]];
    expect(row[2]).toBe("תיאום פגישה — לקוח חדש");
  });

  it("meeting before the sub-choice (no client_type) → plain 'תיאום פגישה'", async () => {
    setupFromSequence([makeBuilder({ data: clientRow({ inquiry_type: "meeting", client_type: null }), error: null })]);
    await mirrorLeadToSheet(CLIENT_ID);
    const [row] = mockUpsertLeadRow.mock.calls[0] as [string[]];
    expect(row[2]).toBe("תיאום פגישה");
  });

  it("placeholder 'general' inquiry → col C blank", async () => {
    setupFromSequence([makeBuilder({ data: clientRow({ inquiry_type: "general" }), error: null })]);
    await mirrorLeadToSheet(CLIENT_ID);
    const [row] = mockUpsertLeadRow.mock.calls[0] as [string[]];
    expect(row[2]).toBe("");
  });

  it("mirrors regardless of client_type (no gating)", async () => {
    setupFromSequence([makeBuilder({ data: clientRow({ client_type: null, inquiry_type: "home" }), error: null })]);
    await mirrorLeadToSheet(CLIENT_ID);
    expect(mockUpsertLeadRow).toHaveBeenCalledOnce();
    const [row] = mockUpsertLeadRow.mock.calls[0] as [string[]];
    expect(row[2]).toBe("ביטוח דירה");
  });
});

// ---------------------------------------------------------------------------
// Edge / error paths
// ---------------------------------------------------------------------------

describe("mirrorLeadToSheet — edge and error paths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpsertLeadRow.mockResolvedValue(true);
  });

  it("skips when the client has no phone", async () => {
    setupFromSequence([makeBuilder({ data: clientRow({ phone: null }), error: null })]);
    await mirrorLeadToSheet(CLIENT_ID);
    expect(mockUpsertLeadRow).not.toHaveBeenCalled();
  });

  it("skips when the client is not found", async () => {
    setupFromSequence([makeBuilder({ data: null, error: null })]);
    await mirrorLeadToSheet(CLIENT_ID);
    expect(mockUpsertLeadRow).not.toHaveBeenCalled();
  });

  it("never throws even if upsertLeadRow throws", async () => {
    setupFromSequence([makeBuilder({ data: clientRow({}), error: null })]);
    mockUpsertLeadRow.mockRejectedValue(new Error("sheets API down"));
    await expect(mirrorLeadToSheet(CLIENT_ID)).resolves.toBeUndefined();
  });

  it("does nothing when LEADS_MIRROR_ENABLED is false", async () => {
    const { env } = await import("../../../config/env.js");
    (env as Record<string, unknown>)["LEADS_MIRROR_ENABLED"] = false;

    await mirrorLeadToSheet(CLIENT_ID);

    expect(mockUpsertLeadRow).not.toHaveBeenCalled();
    expect(mockFromImpl).not.toHaveBeenCalled();

    (env as Record<string, unknown>)["LEADS_MIRROR_ENABLED"] = true;
  });
});
