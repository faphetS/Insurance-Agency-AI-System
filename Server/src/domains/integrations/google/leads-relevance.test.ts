import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// vi.hoisted shared mock functions
// ---------------------------------------------------------------------------
const {
  mockResolveLeadsTabTitle,
  mockResolveLeadsSheetId,
  mockAppendLeadRow,
  mockGetAuthenticatedClient,
  mockSheetsBatchUpdate,
  mockSheetsBatchGet,
} = vi.hoisted(() => ({
  mockResolveLeadsTabTitle: vi.fn(),
  mockResolveLeadsSheetId: vi.fn(),
  mockAppendLeadRow: vi.fn(),
  mockGetAuthenticatedClient: vi.fn(),
  mockSheetsBatchUpdate: vi.fn(),
  mockSheetsBatchGet: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock("../../../config/env.js", () => ({
  env: {
    LEADS_MIRROR_ENABLED: true,
    LEADS_SPREADSHEET_ID: "sheet-id",
    LEADS_SHEET_TAB_NEW: "לידים חדשים",
    LEADS_SHEET_TAB_EXISTING: "לקוח קיים",
    LEADS_SHEET_TAB_IRRELEVANT: "לא רלוונטי",
    NODE_ENV: "test",
  },
}));

vi.mock("../../../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("./google.auth.js", () => ({
  getAuthenticatedClient: mockGetAuthenticatedClient,
}));

vi.mock("./google.sheets.js", () => ({
  resolveLeadsTabTitle: mockResolveLeadsTabTitle,
  resolveLeadsSheetId: mockResolveLeadsSheetId,
  appendLeadRow: mockAppendLeadRow,
  quoteA1Title: (title: string) => `'${title.replace(/'/g, "''")}'`,
}));

vi.mock("googleapis", () => ({
  google: {
    sheets: vi.fn(() => ({
      spreadsheets: {
        batchUpdate: mockSheetsBatchUpdate,
        values: {
          batchGet: mockSheetsBatchGet,
        },
      },
    })),
  },
}));

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------
import { applyRelevanceDropdowns, sweepRelevanceMoves } from "./leads-relevance.service.js";

// ---------------------------------------------------------------------------
// Fixtures — mirrors the live sheet: 2 of 3 exact titles carry a trailing space,
// trimmed names (config values) never do.
// ---------------------------------------------------------------------------
const TAB_NEW_TRIMMED = "לידים חדשים";
const TAB_EXISTING_TRIMMED = "לקוח קיים";
const TAB_IRRELEVANT_TRIMMED = "לא רלוונטי";
const TAB_NEW_EXACT = "לידים חדשים ";
const TAB_EXISTING_EXACT = "לקוח קיים ";
const TAB_IRRELEVANT_EXACT = "לא רלוונטי";
const SHEETID_NEW = 0;
const SHEETID_EXISTING = 1427228480;
const SHEETID_IRRELEVANT = 2076864064;

function setupResolvedTabs(): void {
  mockResolveLeadsTabTitle.mockImplementation(async (name: string) => {
    if (name === TAB_NEW_TRIMMED) return TAB_NEW_EXACT;
    if (name === TAB_EXISTING_TRIMMED) return TAB_EXISTING_EXACT;
    if (name === TAB_IRRELEVANT_TRIMMED) return TAB_IRRELEVANT_EXACT;
    return null;
  });
  mockResolveLeadsSheetId.mockImplementation(async (exactTitle: string) => {
    if (exactTitle === TAB_NEW_EXACT) return SHEETID_NEW;
    if (exactTitle === TAB_EXISTING_EXACT) return SHEETID_EXISTING;
    if (exactTitle === TAB_IRRELEVANT_EXACT) return SHEETID_IRRELEVANT;
    return null;
  });
}

function emptyBatchGet() {
  return { data: { valueRanges: [{ values: [] }, { values: [] }, { values: [] }] } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAuthenticatedClient.mockResolvedValue({});
});

// ---------------------------------------------------------------------------
// applyRelevanceDropdowns
// ---------------------------------------------------------------------------

describe("applyRelevanceDropdowns", () => {
  it("issues one batchUpdate with 3 setDataValidation requests (no endRowIndex, ONE_OF_LIST of 3 trimmed names)", async () => {
    setupResolvedTabs();
    mockSheetsBatchUpdate.mockResolvedValue({});

    const result = await applyRelevanceDropdowns();

    expect(result).toEqual({ tabsApplied: 3 });
    expect(mockSheetsBatchUpdate).toHaveBeenCalledOnce();

    const arg = mockSheetsBatchUpdate.mock.calls[0]?.[0] as {
      requestBody: {
        requests: Array<{
          setDataValidation: {
            range: { sheetId: number; startRowIndex: number; startColumnIndex: number; endColumnIndex: number };
            rule: {
              condition: { type: string; values: Array<{ userEnteredValue: string }> };
              strict: boolean;
              showCustomUi: boolean;
            };
          };
        }>;
      };
    };
    const requests = arg.requestBody.requests;
    expect(requests).toHaveLength(3);

    for (const req of requests) {
      const { range, rule } = req.setDataValidation;
      expect(range).not.toHaveProperty("endRowIndex");
      expect(range.startRowIndex).toBe(1);
      expect(range.startColumnIndex).toBe(5);
      expect(range.endColumnIndex).toBe(6);
      expect(rule.condition.type).toBe("ONE_OF_LIST");
      expect(rule.condition.values).toEqual([
        { userEnteredValue: TAB_NEW_TRIMMED },
        { userEnteredValue: TAB_EXISTING_TRIMMED },
        { userEnteredValue: TAB_IRRELEVANT_TRIMMED },
      ]);
      expect(rule.strict).toBe(true);
      expect(rule.showCustomUi).toBe(true);
    }

    const sheetIds = requests.map((r) => r.setDataValidation.range.sheetId);
    expect(sheetIds).toEqual([SHEETID_NEW, SHEETID_EXISTING, SHEETID_IRRELEVANT]);
  });

  it("does nothing when LEADS_MIRROR_ENABLED is false", async () => {
    const { env } = await import("../../../config/env.js");
    (env as Record<string, unknown>)["LEADS_MIRROR_ENABLED"] = false;

    const result = await applyRelevanceDropdowns();

    expect(result).toEqual({ tabsApplied: 0 });
    expect(mockGetAuthenticatedClient).not.toHaveBeenCalled();
    expect(mockSheetsBatchUpdate).not.toHaveBeenCalled();

    (env as Record<string, unknown>)["LEADS_MIRROR_ENABLED"] = true;
  });

  it("resolves { tabsApplied: 0 } when getAuthenticatedClient throws", async () => {
    mockGetAuthenticatedClient.mockRejectedValue(new Error("not authed"));

    const result = await applyRelevanceDropdowns();

    expect(result).toEqual({ tabsApplied: 0 });
    expect(mockSheetsBatchUpdate).not.toHaveBeenCalled();
  });

  it("resolves { tabsApplied: 0 } when no tab resolves", async () => {
    mockResolveLeadsTabTitle.mockResolvedValue(null);

    const result = await applyRelevanceDropdowns();

    expect(result).toEqual({ tabsApplied: 0 });
    expect(mockSheetsBatchUpdate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// sweepRelevanceMoves
// ---------------------------------------------------------------------------

describe("sweepRelevanceMoves", () => {
  it("moves a row from NEW to EXISTING when F names EXISTING — 7 padded values, F kept, delete on source", async () => {
    setupResolvedTabs();
    mockSheetsBatchGet.mockResolvedValue({
      data: {
        valueRanges: [
          {
            values: [
              ["972501234567", "Name", "inquiry", "", "", TAB_EXISTING_TRIMMED, "10/07/2026 09:00"],
            ],
          },
          { values: [] },
          { values: [] },
        ],
      },
    });
    mockAppendLeadRow.mockResolvedValue(true);
    mockSheetsBatchUpdate.mockResolvedValue({});

    const result = await sweepRelevanceMoves();

    expect(result).toEqual({ scanned: 1, moved: 1, ignoredEmpty: 0, ignoredInvalid: 0, errors: 0 });

    expect(mockAppendLeadRow).toHaveBeenCalledOnce();
    const [values, destTitle] = mockAppendLeadRow.mock.calls[0] as [string[], string];
    expect(values).toHaveLength(7);
    expect(values[5]).toBe(TAB_EXISTING_TRIMMED);
    expect(destTitle).toBe(TAB_EXISTING_EXACT);

    expect(mockSheetsBatchUpdate).toHaveBeenCalledOnce();
    const batchArg = mockSheetsBatchUpdate.mock.calls[0]?.[0] as {
      requestBody: {
        requests: Array<{ deleteDimension: { range: { sheetId: number; dimension: string; startIndex: number; endIndex: number } } }>;
      };
    };
    expect(batchArg.requestBody.requests).toHaveLength(1);
    const delRange = batchArg.requestBody.requests[0].deleteDimension.range;
    expect(delRange.sheetId).toBe(SHEETID_NEW);
    expect(delRange.dimension).toBe("ROWS");
    expect(delRange.startIndex).toBe(1);
    expect(delRange.endIndex).toBe(2);
  });

  it("classifies blank/junk/own-tab/phone-and-name-empty/ragged rows without moving any of them", async () => {
    setupResolvedTabs();
    mockSheetsBatchGet.mockResolvedValue({
      data: {
        valueRanges: [
          {
            values: [
              ["972500000001", "Name1", "inq", "", "", "", "10/07/2026 09:00"], // blank F
              ["972500000002", "Name2", "inq", "", "", "לא קיים בכלל", "10/07/2026 09:00"], // junk F
              ["972500000003", "Name3", "inq", "", "", TAB_NEW_TRIMMED, "10/07/2026 09:00"], // own tab (trim-equal despite trailing-space exact title)
              ["", "", "inq", "", "", TAB_EXISTING_TRIMMED, "10/07/2026 09:00"], // phone + name both empty
              ["only-one-cell"], // ragged row, length < 6
            ],
          },
          { values: [] },
          { values: [] },
        ],
      },
    });

    const result = await sweepRelevanceMoves();

    expect(result).toEqual({ scanned: 5, moved: 0, ignoredEmpty: 2, ignoredInvalid: 2, errors: 0 });
    expect(mockAppendLeadRow).not.toHaveBeenCalled();
    expect(mockSheetsBatchUpdate).not.toHaveBeenCalled();
  });

  it("queues multiple moves out of one tab into a single batchUpdate with descending delete indices", async () => {
    setupResolvedTabs();
    mockSheetsBatchGet.mockResolvedValue({
      data: {
        valueRanges: [
          {
            values: [
              ["972500000001", "A", "", "", "", TAB_EXISTING_TRIMMED, ""], // i=0 → rowIndex0=1
              ["972500000002", "B", "", "", "", TAB_IRRELEVANT_TRIMMED, ""], // i=1 → rowIndex0=2
            ],
          },
          { values: [] },
          { values: [] },
        ],
      },
    });
    mockAppendLeadRow.mockResolvedValue(true);
    mockSheetsBatchUpdate.mockResolvedValue({});

    const result = await sweepRelevanceMoves();

    expect(result).toEqual({ scanned: 2, moved: 2, ignoredEmpty: 0, ignoredInvalid: 0, errors: 0 });
    expect(mockAppendLeadRow).toHaveBeenCalledTimes(2);
    expect(mockSheetsBatchUpdate).toHaveBeenCalledOnce();

    const batchArg = mockSheetsBatchUpdate.mock.calls[0]?.[0] as {
      requestBody: { requests: Array<{ deleteDimension: { range: { startIndex: number } } }> };
    };
    const startIndexes = batchArg.requestBody.requests.map((r) => r.deleteDimension.range.startIndex);
    expect(startIndexes).toEqual([2, 1]);
  });

  it("excludes a failed append from the delete batch — errors:1, the other row still moves", async () => {
    setupResolvedTabs();
    mockSheetsBatchGet.mockResolvedValue({
      data: {
        valueRanges: [
          {
            values: [
              ["972500000001", "A", "", "", "", TAB_EXISTING_TRIMMED, ""], // i=0
              ["972500000002", "B", "", "", "", TAB_IRRELEVANT_TRIMMED, ""], // i=1
            ],
          },
          { values: [] },
          { values: [] },
        ],
      },
    });
    mockAppendLeadRow.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mockSheetsBatchUpdate.mockResolvedValue({});

    const result = await sweepRelevanceMoves();

    expect(result).toEqual({ scanned: 2, moved: 1, ignoredEmpty: 0, ignoredInvalid: 0, errors: 1 });
    expect(mockSheetsBatchUpdate).toHaveBeenCalledOnce();
    const batchArg = mockSheetsBatchUpdate.mock.calls[0]?.[0] as {
      requestBody: { requests: Array<{ deleteDimension: { range: { startIndex: number } } }> };
    };
    expect(batchArg.requestBody.requests).toHaveLength(1);
    expect(batchArg.requestBody.requests[0].deleteDimension.range.startIndex).toBe(2);
  });

  it("resolves with errors > 0 when batchGet rejects, never throws", async () => {
    setupResolvedTabs();
    mockSheetsBatchGet.mockRejectedValue(new Error("API down"));

    const result = await sweepRelevanceMoves();

    expect(result.errors).toBeGreaterThan(0);
    expect(result.moved).toBe(0);
  });

  it("returns zeros and warns on a re-entrant call while a sweep is in progress", async () => {
    setupResolvedTabs();
    mockSheetsBatchGet.mockResolvedValue(emptyBatchGet());

    const p1 = sweepRelevanceMoves();
    const result2 = await sweepRelevanceMoves();

    expect(result2).toEqual({ scanned: 0, moved: 0, ignoredEmpty: 0, ignoredInvalid: 0, errors: 0 });

    const { logger } = await import("../../../config/logger.js");
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("already in progress"));

    await p1;
  });

  it("returns zeros without touching the API when LEADS_MIRROR_ENABLED is false", async () => {
    const { env } = await import("../../../config/env.js");
    (env as Record<string, unknown>)["LEADS_MIRROR_ENABLED"] = false;

    const result = await sweepRelevanceMoves();

    expect(result).toEqual({ scanned: 0, moved: 0, ignoredEmpty: 0, ignoredInvalid: 0, errors: 0 });
    expect(mockGetAuthenticatedClient).not.toHaveBeenCalled();

    (env as Record<string, unknown>)["LEADS_MIRROR_ENABLED"] = true;
  });

  it("returns zeros when fewer than 2 tabs resolve", async () => {
    mockResolveLeadsTabTitle.mockImplementation(async (name: string) =>
      name === TAB_NEW_TRIMMED ? TAB_NEW_EXACT : null,
    );
    mockResolveLeadsSheetId.mockResolvedValue(SHEETID_NEW);

    const result = await sweepRelevanceMoves();

    expect(result).toEqual({ scanned: 0, moved: 0, ignoredEmpty: 0, ignoredInvalid: 0, errors: 0 });
    expect(mockGetAuthenticatedClient).not.toHaveBeenCalled();
  });
});
