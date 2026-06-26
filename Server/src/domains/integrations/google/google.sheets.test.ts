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
  // resolveLeadsTabTitle first checks system_settings for a cached value
  const cacheHit = makeBuilder({ data: { value: tabTitle }, error: null });
  mockFromImpl.mockReturnValue(cacheHit);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("upsertLeadRow — phone found → values.update", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthenticatedClient.mockResolvedValue({});
    setupCachedTab("לידים חדשים");
  });

  it("calls values.update with A{N}:H{N} when phone matches existing row", async () => {
    // Row 1 is a header ("טלפון" → normalises to ""), row 2 has the target phone
    mockSheetsGet.mockResolvedValue({
      data: {
        values: [
          ["טלפון"],        // row 1 — header digits = "" → no match
          ["972501234567"], // row 2 — exact match
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
    // If the header is "Phone" it must never match a numeric phone
    mockSheetsGet.mockResolvedValue({
      data: { values: [["Phone"], ["972501234567"]] },
    });
    mockSheetsUpdate.mockResolvedValue({});

    const row = ["972501234567", "", "", "", "", "", "", ""];
    await upsertLeadRow(row);

    expect(mockSheetsUpdate).toHaveBeenCalledOnce();
    const updateArg = mockSheetsUpdate.mock.calls[0]?.[0] as { range: string };
    // Must match row 2, not row 1 (the header)
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
