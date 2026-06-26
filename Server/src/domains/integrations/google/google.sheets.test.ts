import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// vi.hoisted shared mock functions
// ---------------------------------------------------------------------------
const {
  mockFromImpl,
  mockSheetsGet,
  mockSheetsAppend,
  mockSheetsUpdate,
  mockGetAuthenticatedClient,
} = vi.hoisted(() => {
  const mockFromImpl = vi.fn();
  const mockSheetsGet = vi.fn();
  const mockSheetsAppend = vi.fn();
  const mockSheetsUpdate = vi.fn();
  const mockGetAuthenticatedClient = vi.fn();
  return {
    mockFromImpl,
    mockSheetsGet,
    mockSheetsAppend,
    mockSheetsUpdate,
    mockGetAuthenticatedClient,
  };
});

// ---------------------------------------------------------------------------
// Module mocks (no mock of google.sheets.js — it is the module under test)
// ---------------------------------------------------------------------------
vi.mock("../../../config/env.js", () => ({
  env: {
    LEADS_MIRROR_ENABLED: true,
    LEADS_SPREADSHEET_ID: "sheet-id",
    LEADS_SHEET_TAB: "לידים חדשים",
    LEADS_SHEET_TAB_NEW: "לידים חדשים",
    LEADS_SHEET_TAB_OLD: "לקוח קיים",
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

vi.mock("googleapis", () => ({
  google: {
    sheets: vi.fn(() => ({
      spreadsheets: {
        get: vi.fn().mockResolvedValue({
          data: {
            sheets: [
              { properties: { title: "לידים חדשים" } },
              { properties: { title: "לקוח קיים" } },
            ],
          },
        }),
        values: {
          get: mockSheetsGet,
          append: mockSheetsAppend,
          update: mockSheetsUpdate,
        },
      },
    })),
    auth: { OAuth2: vi.fn() },
  },
}));

vi.mock("./google.auth.js", () => ({
  getAuthenticatedClient: mockGetAuthenticatedClient,
}));

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------
import { upsertLeadRow } from "./google.sheets.js";

// ---------------------------------------------------------------------------
// Helpers — set up supabaseAdmin.from for resolveLeadsTabTitle cache miss
// then cache hit path
// ---------------------------------------------------------------------------
type Builder = Record<string, unknown>;

function makeBuilder(result: unknown): Builder {
  const terminal = vi.fn().mockResolvedValue(result);
  const builder: Builder = {};
  const chainMethods = [
    "select", "eq", "neq", "is", "not", "in", "gte", "lte",
    "order", "insert", "upsert", "update", "limit",
  ];
  for (const m of chainMethods) {
    builder[m] = vi.fn().mockReturnValue(builder);
  }
  builder["maybeSingle"] = terminal;
  builder["single"] = terminal;
  builder["then"] = (onFulfilled: (v: unknown) => unknown) => Promise.resolve(result).then(onFulfilled);
  return builder;
}

function setupCachedTab(tabTitle: string): void {
  const cacheHit = makeBuilder({ data: { value: tabTitle }, error: null });
  mockFromImpl.mockReturnValue(cacheHit);
}

// ---------------------------------------------------------------------------
// Tests — existing behaviour preserved
// ---------------------------------------------------------------------------

describe("upsertLeadRow — phone found → values.update", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthenticatedClient.mockResolvedValue({});
    setupCachedTab("לידים חדשים");
  });

  it("calls values.update with A{N}:H{N} when phone matches existing row", async () => {
    mockSheetsGet.mockResolvedValue({
      data: {
        values: [
          ["טלפון"],
          ["972501234567"],
        ],
      },
    });
    mockSheetsUpdate.mockResolvedValue({});

    const row = ["972501234567", "יעל כהן", "yael@example.com", "ביטוח חיים", "", "", "123456789", ""];
    const result = await upsertLeadRow(row);

    expect(result).toBe(true);
    expect(mockSheetsUpdate).toHaveBeenCalledOnce();

    const updateArg = mockSheetsUpdate.mock.calls[0]?.[0] as {
      range: string;
      requestBody: { values: string[][] };
    };
    expect(updateArg.range).toBe("לידים חדשים!A2:H2");
    expect(updateArg.requestBody.values[0]).toEqual(row);
    expect(mockSheetsAppend).not.toHaveBeenCalled();
  });

  it("matches phone stored with non-digit formatting (+972-50-123-4567)", async () => {
    mockSheetsGet.mockResolvedValue({
      data: { values: [["+972-50-123-4567"]] },
    });
    mockSheetsUpdate.mockResolvedValue({});

    const row = ["972501234567", "Test", "", "", "", "", "", ""];
    const result = await upsertLeadRow(row);

    expect(result).toBe(true);
    expect(mockSheetsUpdate).toHaveBeenCalledOnce();
    const updateArg = mockSheetsUpdate.mock.calls[0]?.[0] as { range: string };
    expect(updateArg.range).toBe("לידים חדשים!A1:H1");
  });

  it("does not match the header row (text header normalises to empty string)", async () => {
    mockSheetsGet.mockResolvedValue({
      data: { values: [["Phone"], ["972501234567"]] },
    });
    mockSheetsUpdate.mockResolvedValue({});

    const row = ["972501234567", "", "", "", "", "", "", ""];
    await upsertLeadRow(row);

    expect(mockSheetsUpdate).toHaveBeenCalledOnce();
    const updateArg = mockSheetsUpdate.mock.calls[0]?.[0] as { range: string };
    expect(updateArg.range).toBe("לידים חדשים!A2:H2");
  });
});

describe("upsertLeadRow — phone not found → values.append", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthenticatedClient.mockResolvedValue({});
    setupCachedTab("לידים חדשים");
  });

  it("falls back to append when phone is not in column A", async () => {
    mockSheetsGet.mockResolvedValue({
      data: { values: [["טלפון"], ["972509999999"]] },
    });
    mockSheetsAppend.mockResolvedValue({});

    const row = ["972501234567", "דני לוי", "", "", "", "", "", ""];
    const result = await upsertLeadRow(row);

    expect(result).toBe(true);
    expect(mockSheetsAppend).toHaveBeenCalledOnce();
    expect(mockSheetsUpdate).not.toHaveBeenCalled();

    const appendArg = mockSheetsAppend.mock.calls[0]?.[0] as {
      requestBody: { values: string[][] };
    };
    expect(appendArg.requestBody.values[0]).toEqual(row);
  });

  it("appends when the sheet is completely empty (values: null)", async () => {
    mockSheetsGet.mockResolvedValue({ data: { values: null } });
    mockSheetsAppend.mockResolvedValue({});

    const row = ["972500000001", "", "", "", "", "", "", ""];
    const result = await upsertLeadRow(row);

    expect(result).toBe(true);
    expect(mockSheetsAppend).toHaveBeenCalledOnce();
    expect(mockSheetsUpdate).not.toHaveBeenCalled();
  });
});

describe("upsertLeadRow — error paths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupCachedTab("לידים חדשים");
  });

  it("returns false when getAuthenticatedClient throws", async () => {
    mockGetAuthenticatedClient.mockRejectedValue(new Error("not authed"));

    const result = await upsertLeadRow(["972500000001", "", "", "", "", "", "", ""]);

    expect(result).toBe(false);
    expect(mockSheetsGet).not.toHaveBeenCalled();
  });

  it("returns false and does not throw when sheets.values.get throws", async () => {
    mockGetAuthenticatedClient.mockResolvedValue({});
    mockSheetsGet.mockRejectedValue(new Error("API error"));

    const result = await upsertLeadRow(["972500000001", "", "", "", "", "", "", ""]);

    expect(result).toBe(false);
    expect(mockSheetsUpdate).not.toHaveBeenCalled();
    expect(mockSheetsAppend).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// NEW: per-tab behaviour — explicit tabTitle param + per-tab cache key
// ---------------------------------------------------------------------------

describe("upsertLeadRow — explicit tabTitle param", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthenticatedClient.mockResolvedValue({});
  });

  it("targets the passed tab title when provided", async () => {
    setupCachedTab("לקוח קיים");
    mockSheetsGet.mockResolvedValue({ data: { values: null } });
    mockSheetsAppend.mockResolvedValue({});

    const row = ["972501111111", "Old Client", "", "", "", "", "", ""];
    const result = await upsertLeadRow(row, "לקוח קיים");

    expect(result).toBe(true);
    expect(mockSheetsAppend).toHaveBeenCalledOnce();
    const appendArg = mockSheetsAppend.mock.calls[0]?.[0] as { range: string };
    expect(appendArg.range).toContain("לקוח קיים");
  });

  it("uses a different system_settings cache key per tab", async () => {
    // First call: "לידים חדשים" tab — cache miss, writes key leads_sheet_tab_resolved:לידים חדשים
    const cacheMissNew = makeBuilder({ data: null, error: null });
    const cacheWriteNew = makeBuilder({ data: null, error: null });
    // Second call: "לקוח קיים" tab — cache miss, writes key leads_sheet_tab_resolved:לקוח קיים
    const cacheMissOld = makeBuilder({ data: null, error: null });
    const cacheWriteOld = makeBuilder({ data: null, error: null });

    mockFromImpl
      .mockReturnValueOnce(cacheMissNew)  // select for "לידים חדשים" cache
      .mockReturnValueOnce(cacheWriteNew) // upsert for "לידים חדשים" cache
      .mockReturnValueOnce(cacheMissOld)  // select for "לקוח קיים" cache
      .mockReturnValue(cacheWriteOld);    // upsert for "לקוח קיים" cache

    mockSheetsGet.mockResolvedValue({ data: { values: null } });
    mockSheetsAppend.mockResolvedValue({});

    const rowNew = ["972501234567", "New", "", "", "", "", "", ""];
    const rowOld = ["972509876543", "Old", "", "", "", "", "", ""];

    await upsertLeadRow(rowNew, "לידים חדשים");
    await upsertLeadRow(rowOld, "לקוח קיים");

    const cacheWriteNewUpsert = cacheWriteNew["upsert"] as ReturnType<typeof vi.fn>;
    const cacheWriteOldUpsert = cacheWriteOld["upsert"] as ReturnType<typeof vi.fn>;
    const newKey = (cacheWriteNewUpsert.mock.calls[0] as [{ key: string }])[0]?.key;
    const oldKey = (cacheWriteOldUpsert.mock.calls[0] as [{ key: string }])[0]?.key;

    expect(newKey).toBe("leads_sheet_tab_resolved:לידים חדשים");
    expect(oldKey).toBe("leads_sheet_tab_resolved:לקוח קיים");
    expect(newKey).not.toBe(oldKey);
  });
});
