import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// vi.hoisted shared mock functions
// ---------------------------------------------------------------------------
const {
  mockFromImpl,
  mockSpreadsheetsGet,
  mockSheetsGet,
  mockSheetsBatchGet,
  mockSheetsAppend,
  mockSheetsUpdate,
  mockSheetsBatchUpdate,
  mockGetAuthenticatedClient,
} = vi.hoisted(() => {
  const mockFromImpl = vi.fn();
  const mockSpreadsheetsGet = vi.fn();
  const mockSheetsGet = vi.fn();
  const mockSheetsBatchGet = vi.fn();
  const mockSheetsAppend = vi.fn();
  const mockSheetsUpdate = vi.fn();
  const mockSheetsBatchUpdate = vi.fn();
  const mockGetAuthenticatedClient = vi.fn();
  return {
    mockFromImpl,
    mockSpreadsheetsGet,
    mockSheetsGet,
    mockSheetsBatchGet,
    mockSheetsAppend,
    mockSheetsUpdate,
    mockSheetsBatchUpdate,
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
    LEADS_SHEET_TAB_EXISTING: "לקוח קיים",
    LEADS_SHEET_TAB_IRRELEVANT: "לא רלוונטי",
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
        get: mockSpreadsheetsGet,
        batchUpdate: mockSheetsBatchUpdate,
        values: {
          get: mockSheetsGet,
          batchGet: mockSheetsBatchGet,
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
import { upsertLeadRow, appendLeadRow } from "./google.sheets.js";

// ---------------------------------------------------------------------------
// Fake system_settings KV store — realistic cache-miss-then-cache-hit behaviour keyed
// by the actual .eq("key", X) argument. A fixed mockReturnValueOnce() sequence (the old
// approach) can't scale to a search across 2-3 candidate tabs per upsertLeadRow call.
// ---------------------------------------------------------------------------
type Builder = Record<string, unknown>;

function createSettingsStore(): { fromImpl: (table: string) => Builder; store: Map<string, string> } {
  const store = new Map<string, string>();

  const fromImpl = (_table: string): Builder => {
    const builder: Builder = {};
    let capturedKey: string | undefined;

    builder["select"] = vi.fn().mockReturnValue(builder);
    builder["eq"] = vi.fn((_col: string, val: string) => {
      capturedKey = val;
      return builder;
    });
    builder["upsert"] = vi.fn((payload: { key: string; value: string }) => {
      store.set(payload.key, payload.value);
      return builder;
    });
    builder["maybeSingle"] = vi.fn(() =>
      Promise.resolve(
        capturedKey !== undefined && store.has(capturedKey)
          ? { data: { value: store.get(capturedKey) }, error: null }
          : { data: null, error: null },
      ),
    );
    builder["then"] = (onFulfilled: (v: unknown) => unknown) =>
      Promise.resolve({ data: null, error: null }).then(onFulfilled);

    return builder;
  };

  return { fromImpl, store };
}

const TAB_NEW = "לידים חדשים";
const TAB_EXISTING = "לקוח קיים";
const TAB_IRRELEVANT = "לא רלוונטי";
const SHEETID_NEW = 0;
const SHEETID_EXISTING = 111;
const SHEETID_IRRELEVANT = 222;

function defaultSheetsFixture() {
  return {
    data: {
      sheets: [
        { properties: { title: TAB_NEW, sheetId: SHEETID_NEW } },
        { properties: { title: TAB_EXISTING, sheetId: SHEETID_EXISTING } },
        { properties: { title: TAB_IRRELEVANT, sheetId: SHEETID_IRRELEVANT } },
      ],
    },
  };
}

function seedAllTabs(store: Map<string, string>): void {
  store.set(`leads_sheet_tab_resolved:${TAB_NEW}`, TAB_NEW);
  store.set(`leads_sheet_tab_resolved:${TAB_EXISTING}`, TAB_EXISTING);
  store.set(`leads_sheet_tab_resolved:${TAB_IRRELEVANT}`, TAB_IRRELEVANT);
}

// One entry per resolved candidate tab, IN SEARCH ORDER (target first).
function batchGetFixture(perTabRows: string[][][]) {
  return { data: { valueRanges: perTabRows.map((values) => ({ values })) } };
}

let store: Map<string, string>;

beforeEach(() => {
  vi.clearAllMocks();
  const fake = createSettingsStore();
  store = fake.store;
  mockFromImpl.mockImplementation(fake.fromImpl);
  mockGetAuthenticatedClient.mockResolvedValue({});
  mockSpreadsheetsGet.mockResolvedValue(defaultSheetsFixture());
  seedAllTabs(store);
});

// ---------------------------------------------------------------------------
// Tests — existing behaviour preserved (implicit target = TAB_NEW)
// ---------------------------------------------------------------------------

describe("upsertLeadRow — phone found → values.update", () => {
  it("calls values.update with A{N}:H{N} when phone matches existing row", async () => {
    mockSheetsBatchGet.mockResolvedValue(batchGetFixture([[["טלפון"], ["972501234567"]], [], []]));
    mockSheetsUpdate.mockResolvedValue({});

    const row = ["972501234567", "יעל כהן", "yael@example.com", "ביטוח חיים", "", "", "123456789", ""];
    const result = await upsertLeadRow(row);

    expect(result).toBe(true);
    expect(mockSheetsUpdate).toHaveBeenCalledOnce();

    const updateArg = mockSheetsUpdate.mock.calls[0]?.[0] as {
      range: string;
      requestBody: { values: string[][] };
    };
    expect(updateArg.range).toBe(`'${TAB_NEW}'!A2:H2`);
    expect(updateArg.requestBody.values[0]).toEqual(row);
    expect(mockSheetsAppend).not.toHaveBeenCalled();
    expect(mockSheetsBatchUpdate).not.toHaveBeenCalled();
  });

  it("matches phone stored with non-digit formatting (+972-50-123-4567)", async () => {
    mockSheetsBatchGet.mockResolvedValue(batchGetFixture([[["+972-50-123-4567"]], [], []]));
    mockSheetsUpdate.mockResolvedValue({});

    const row = ["972501234567", "Test", "", "", "", "", "", ""];
    const result = await upsertLeadRow(row);

    expect(result).toBe(true);
    expect(mockSheetsUpdate).toHaveBeenCalledOnce();
    const updateArg = mockSheetsUpdate.mock.calls[0]?.[0] as { range: string };
    expect(updateArg.range).toBe(`'${TAB_NEW}'!A1:H1`);
  });

  it("does not match the header row (text header normalises to empty string)", async () => {
    mockSheetsBatchGet.mockResolvedValue(batchGetFixture([[["Phone"], ["972501234567"]], [], []]));
    mockSheetsUpdate.mockResolvedValue({});

    const row = ["972501234567", "", "", "", "", "", "", ""];
    await upsertLeadRow(row);

    expect(mockSheetsUpdate).toHaveBeenCalledOnce();
    const updateArg = mockSheetsUpdate.mock.calls[0]?.[0] as { range: string };
    expect(updateArg.range).toBe(`'${TAB_NEW}'!A2:H2`);
  });
});

describe("upsertLeadRow — phone not found → values.append", () => {
  it("falls back to append when phone is not in column A", async () => {
    mockSheetsBatchGet.mockResolvedValue(batchGetFixture([[["טלפון"], ["972509999999"]], [], []]));
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
    mockSheetsBatchGet.mockResolvedValue({ data: { valueRanges: [{}, {}, {}] } });
    mockSheetsAppend.mockResolvedValue({});

    const row = ["972500000001", "", "", "", "", "", "", ""];
    const result = await upsertLeadRow(row);

    expect(result).toBe(true);
    expect(mockSheetsAppend).toHaveBeenCalledOnce();
    expect(mockSheetsUpdate).not.toHaveBeenCalled();
  });
});

describe("upsertLeadRow — error paths", () => {
  it("returns false when getAuthenticatedClient throws", async () => {
    mockGetAuthenticatedClient.mockRejectedValue(new Error("not authed"));

    const result = await upsertLeadRow(["972500000001", "", "", "", "", "", "", ""]);

    expect(result).toBe(false);
    expect(mockSheetsBatchGet).not.toHaveBeenCalled();
  });

  it("returns false and does not throw when sheets.values.batchGet throws", async () => {
    mockSheetsBatchGet.mockRejectedValue(new Error("API error"));

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
  it("targets the passed tab title when provided", async () => {
    mockSheetsBatchGet.mockResolvedValue({ data: { valueRanges: [{}, {}, {}] } });
    mockSheetsAppend.mockResolvedValue({});

    const row = ["972501111111", "Old Client", "", "", "", "", "", ""];
    const result = await upsertLeadRow(row, TAB_EXISTING);

    expect(result).toBe(true);
    expect(mockSheetsAppend).toHaveBeenCalledOnce();
    const appendArg = mockSheetsAppend.mock.calls[0]?.[0] as { range: string };
    expect(appendArg.range).toContain(TAB_EXISTING);
  });

  it("resolves and caches all 3 candidate tabs under distinct system_settings keys", async () => {
    store.clear(); // force cache-miss on every candidate → real resolution via spreadsheets.get
    mockSheetsBatchGet.mockResolvedValue({ data: { valueRanges: [{}, {}, {}] } });
    mockSheetsAppend.mockResolvedValue({});

    const row = ["972501234567", "New", "", "", "", "", "", ""];
    await upsertLeadRow(row, TAB_NEW);

    expect(store.get(`leads_sheet_tab_resolved:${TAB_NEW}`)).toBe(TAB_NEW);
    expect(store.get(`leads_sheet_tab_resolved:${TAB_EXISTING}`)).toBe(TAB_EXISTING);
    expect(store.get(`leads_sheet_tab_resolved:${TAB_IRRELEVANT}`)).toBe(TAB_IRRELEVANT);
  });
});

// ---------------------------------------------------------------------------
// Variable-width upsert — end column derived from values.length (target = TAB_EXISTING)
// ---------------------------------------------------------------------------

describe("upsertLeadRow — variable-width end column", () => {
  it("8-col row (new client) → range ends at H", async () => {
    mockSheetsBatchGet.mockResolvedValue({ data: { valueRanges: [{}, {}, {}] } });
    mockSheetsAppend.mockResolvedValue({});

    const row = ["972501234567", "Name", "email@x.com", "ביטוח רכב", "", "", "", ""];
    await upsertLeadRow(row, TAB_EXISTING);

    const appendArg = mockSheetsAppend.mock.calls[0]?.[0] as { range: string };
    expect(appendArg.range).toBe(`${TAB_EXISTING}!A:H`);
  });

  it("9-col row (old client with issue) → range ends at I", async () => {
    mockSheetsBatchGet.mockResolvedValue({ data: { valueRanges: [{}, {}, {}] } });
    mockSheetsAppend.mockResolvedValue({});

    const row = ["972509876543", "Name", "", "ביטוח דירה", "", "", "", "", "הבעיה שלי"];
    await upsertLeadRow(row, TAB_EXISTING);

    const appendArg = mockSheetsAppend.mock.calls[0]?.[0] as { range: string };
    expect(appendArg.range).toBe(`${TAB_EXISTING}!A:I`);
  });

  it("9-col row — update path also ends at I{N}", async () => {
    mockSheetsBatchGet.mockResolvedValue(batchGetFixture([[["972509876543"]], [], []]));
    mockSheetsUpdate.mockResolvedValue({});

    const row = ["972509876543", "Name", "", "ביטוח דירה", "", "", "", "", "בעיה"];
    await upsertLeadRow(row, TAB_EXISTING);

    const updateArg = mockSheetsUpdate.mock.calls[0]?.[0] as { range: string };
    expect(updateArg.range).toBe(`'${TAB_EXISTING}'!A1:I1`);
  });
});

// ---------------------------------------------------------------------------
// setOnceColumns — preserve creation-date (col G) on update, write-once (target = TAB_NEW)
// ---------------------------------------------------------------------------

describe("upsertLeadRow — setOnceColumns", () => {
  it("preserves a non-empty set-once column on update; other columns overwritten", async () => {
    mockSheetsBatchGet.mockResolvedValue(batchGetFixture([[["972501234567"]], [], []]));
    mockSheetsGet.mockResolvedValueOnce({
      data: { values: [["972501234567", "old name", "", "", "", "", "01/01/2026 09:00"]] },
    });
    mockSheetsUpdate.mockResolvedValue({});

    const row = ["972501234567", "new name", "ביטוח רכב", "", "", "", "09/07/2026 12:00"];
    await upsertLeadRow(row, TAB_NEW, { setOnceColumns: [6] });

    expect(mockSheetsBatchGet).toHaveBeenCalledOnce();
    expect(mockSheetsGet).toHaveBeenCalledOnce();
    const updateArg = mockSheetsUpdate.mock.calls[0]?.[0] as { requestBody: { values: string[][] } };
    expect(updateArg.requestBody.values[0]![6]).toBe("01/01/2026 09:00"); // preserved original
    expect(updateArg.requestBody.values[0]![1]).toBe("new name"); // B overwritten
    expect(updateArg.requestBody.values[0]![2]).toBe("ביטוח רכב"); // C overwritten
  });

  it("overwrites an EMPTY set-once column on update with the new value", async () => {
    mockSheetsBatchGet.mockResolvedValue(batchGetFixture([[["972501234567"]], [], []]));
    mockSheetsGet.mockResolvedValueOnce({ data: { values: [["972501234567", "old", "", "", "", "", ""]] } }); // G empty
    mockSheetsUpdate.mockResolvedValue({});

    const row = ["972501234567", "n", "", "", "", "", "09/07/2026 12:00"];
    await upsertLeadRow(row, TAB_NEW, { setOnceColumns: [6] });

    const updateArg = mockSheetsUpdate.mock.calls[0]?.[0] as { requestBody: { values: string[][] } };
    expect(updateArg.requestBody.values[0]![6]).toBe("09/07/2026 12:00");
  });

  it("append path writes values as-given and does not read the existing row", async () => {
    mockSheetsBatchGet.mockResolvedValue({ data: { valueRanges: [{}, {}, {}] } }); // not found anywhere
    mockSheetsAppend.mockResolvedValue({});

    const row = ["972509999999", "n", "", "", "", "", "09/07/2026 12:00"];
    await upsertLeadRow(row, TAB_NEW, { setOnceColumns: [6] });

    expect(mockSheetsAppend).toHaveBeenCalledOnce();
    const appendArg = mockSheetsAppend.mock.calls[0]?.[0] as { requestBody: { values: string[][] } };
    expect(appendArg.requestBody.values[0]).toEqual(row);
    expect(mockSheetsGet).not.toHaveBeenCalled();
    expect(mockSheetsBatchGet).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Multi-tab search — the new 3-tab-aware behaviour
// ---------------------------------------------------------------------------

describe("upsertLeadRow — multi-tab search", () => {
  it("phone found in a non-target tab → values.update targets that tab, no append", async () => {
    mockSheetsBatchGet.mockResolvedValue(batchGetFixture([[], [["972501234567"]], []]));
    mockSheetsUpdate.mockResolvedValue({});

    const row = ["972501234567", "Name", "", "", "", "", "", ""];
    const result = await upsertLeadRow(row);

    expect(result).toBe(true);
    expect(mockSheetsAppend).not.toHaveBeenCalled();
    expect(mockSheetsUpdate).toHaveBeenCalledOnce();
    const updateArg = mockSheetsUpdate.mock.calls[0]?.[0] as { range: string };
    expect(updateArg.range).toBe(`'${TAB_EXISTING}'!A1:H1`);
  });

  it("phone found in target AND another tab → target wins", async () => {
    mockSheetsBatchGet.mockResolvedValue(batchGetFixture([[["972501234567"]], [["972501234567"]], []]));
    mockSheetsUpdate.mockResolvedValue({});

    const row = ["972501234567", "Name", "", "", "", "", "", ""];
    await upsertLeadRow(row);

    const updateArg = mockSheetsUpdate.mock.calls[0]?.[0] as { range: string };
    expect(updateArg.range).toBe(`'${TAB_NEW}'!A1:H1`);
  });

  it("one tab unresolvable → search proceeds over the rest with a warn", async () => {
    store.delete(`leads_sheet_tab_resolved:${TAB_IRRELEVANT}`);
    mockSpreadsheetsGet.mockResolvedValueOnce({
      data: {
        sheets: [
          { properties: { title: TAB_NEW, sheetId: SHEETID_NEW } },
          { properties: { title: TAB_EXISTING, sheetId: SHEETID_EXISTING } },
        ],
      },
    });
    mockSheetsBatchGet.mockResolvedValue(batchGetFixture([[], [["972501234567"]]]));
    mockSheetsUpdate.mockResolvedValue({});

    const row = ["972501234567", "Name", "", "", "", "", "", ""];
    const result = await upsertLeadRow(row);

    expect(result).toBe(true);
    const batchGetArg = mockSheetsBatchGet.mock.calls[0]?.[0] as { ranges: string[] };
    expect(batchGetArg.ranges).toHaveLength(2);

    const { logger } = await import("../../../config/logger.js");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ unresolved: [TAB_IRRELEVANT] }),
      expect.any(String),
    );

    const updateArg = mockSheetsUpdate.mock.calls[0]?.[0] as { range: string };
    expect(updateArg.range).toBe(`'${TAB_EXISTING}'!A1:H1`);
  });
});

// ---------------------------------------------------------------------------
// Row formatting on append — 13pt / not-bold / white, cols A-G
// (appendLeadRow is unchanged by the multi-tab rework — single-tab resolution only)
// ---------------------------------------------------------------------------

describe("row formatting on append", () => {
  it("appendLeadRow triggers exactly one repeatCell batchUpdate on the parsed row", async () => {
    mockSheetsAppend.mockResolvedValue({
      data: { updates: { updatedRange: "'לידים חדשים '!A3:G3" } },
    });
    mockSheetsBatchUpdate.mockResolvedValue({});

    const row = ["972501234567", "New Client", "ביטוח רכב", "", "", "", "09/07/2026 12:00"];
    const result = await appendLeadRow(row);

    expect(result).toBe(true);
    expect(mockSheetsBatchUpdate).toHaveBeenCalledOnce();

    const batchArg = mockSheetsBatchUpdate.mock.calls[0]?.[0] as {
      requestBody: {
        requests: [
          {
            repeatCell: {
              range: {
                sheetId: number;
                startRowIndex: number;
                endRowIndex: number;
                startColumnIndex: number;
                endColumnIndex: number;
              };
              cell: {
                userEnteredFormat: {
                  backgroundColor: { red: number; green: number; blue: number };
                  textFormat: { fontSize: number; bold: boolean };
                };
              };
              fields: string;
            };
          },
        ];
      };
    };
    const repeatCell = batchArg.requestBody.requests[0].repeatCell;
    expect(repeatCell.range.sheetId).toBe(SHEETID_NEW);
    expect(repeatCell.range.startRowIndex).toBe(2);
    expect(repeatCell.range.endRowIndex).toBe(3);
    expect(repeatCell.range.startColumnIndex).toBe(0);
    expect(repeatCell.range.endColumnIndex).toBe(7);
    expect(repeatCell.cell.userEnteredFormat.textFormat).toEqual({ fontSize: 13, bold: false });
    expect(repeatCell.cell.userEnteredFormat.backgroundColor).toEqual({ red: 1, green: 1, blue: 1 });
    expect(repeatCell.fields).toBe("userEnteredFormat(backgroundColor,textFormat.fontSize,textFormat.bold)");
  });

  it("upsertLeadRow append branch also triggers the repeatCell batchUpdate", async () => {
    mockSheetsBatchGet.mockResolvedValue({ data: { valueRanges: [{}, {}, {}] } }); // not found anywhere
    mockSheetsAppend.mockResolvedValue({
      data: { updates: { updatedRange: "'לידים חדשים '!A5:G5" } },
    });
    mockSheetsBatchUpdate.mockResolvedValue({});

    const row = ["972500000002", "n", "", "", "", "", ""];
    const result = await upsertLeadRow(row, TAB_NEW);

    expect(result).toBe(true);
    expect(mockSheetsBatchUpdate).toHaveBeenCalledOnce();
    const batchArg = mockSheetsBatchUpdate.mock.calls[0]?.[0] as {
      requestBody: { requests: [{ repeatCell: { range: { startRowIndex: number; endRowIndex: number } } }] };
    };
    expect(batchArg.requestBody.requests[0].repeatCell.range.startRowIndex).toBe(4);
    expect(batchArg.requestBody.requests[0].repeatCell.range.endRowIndex).toBe(5);
  });

  it("missing updatedRange → no throw, no batchUpdate, still returns true", async () => {
    mockSheetsAppend.mockResolvedValue({ data: { updates: {} } });

    const row = ["972501234568", "n", "", "", "", "", ""];
    const result = await appendLeadRow(row);

    expect(result).toBe(true);
    expect(mockSheetsBatchUpdate).not.toHaveBeenCalled();
  });

  it("malformed updatedRange → no throw, no batchUpdate, still returns true", async () => {
    mockSheetsAppend.mockResolvedValue({
      data: { updates: { updatedRange: "not-a-valid-range" } },
    });

    const row = ["972501234569", "n", "", "", "", "", ""];
    const result = await appendLeadRow(row);

    expect(result).toBe(true);
    expect(mockSheetsBatchUpdate).not.toHaveBeenCalled();
  });

  it("append response entirely missing .data → no throw, no batchUpdate, still returns true", async () => {
    mockSheetsAppend.mockResolvedValue({});

    const row = ["972501234570", "n", "", "", "", "", ""];
    const result = await appendLeadRow(row);

    expect(result).toBe(true);
    expect(mockSheetsBatchUpdate).not.toHaveBeenCalled();
  });

  it("batchUpdate failure is swallowed — append still returns true", async () => {
    mockSheetsAppend.mockResolvedValue({
      data: { updates: { updatedRange: "'לידים חדשים '!A9:G9" } },
    });
    mockSheetsBatchUpdate.mockRejectedValue(new Error("batchUpdate API error"));

    const row = ["972501234571", "n", "", "", "", "", ""];
    const result = await appendLeadRow(row);

    expect(result).toBe(true);
  });
});
