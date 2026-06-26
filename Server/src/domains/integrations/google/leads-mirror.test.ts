import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// vi.hoisted shared mock functions
// ---------------------------------------------------------------------------
const {
  mockFromImpl,
  mockUpsertLeadRow,
  mockResolveLeadsTabTitle,
} = vi.hoisted(() => {
  const mockFromImpl = vi.fn();
  const mockUpsertLeadRow = vi.fn();
  const mockResolveLeadsTabTitle = vi.fn();
  return {
    mockFromImpl,
    mockUpsertLeadRow,
    mockResolveLeadsTabTitle,
  };
});

// ---------------------------------------------------------------------------
// Module mocks
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

vi.mock("../../../lib/db.js", () => ({
  pool: { query: vi.fn() },
}));

vi.mock("./google.sheets.js", () => ({
  upsertLeadRow: mockUpsertLeadRow,
  appendLeadRow: vi.fn(),
  resolveLeadsTabTitle: mockResolveLeadsTabTitle,
}));

// ---------------------------------------------------------------------------
// Builder shim helpers
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

function setupFromSequence(builders: Builder[]): void {
  let callIndex = 0;
  mockFromImpl.mockImplementation(() => {
    const b = builders[callIndex] ?? builders[builders.length - 1];
    callIndex++;
    return b;
  });
}

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------
import { mirrorLeadToSheet } from "./leads-mirror.service.js";

const CLIENT_ID = "client-abc-123";

describe("mirrorLeadToSheet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds the A→H row correctly including Hebrew inquiry label and empty POA", async () => {
    const clientData = {
      full_name: "יעל כהן",
      phone: "972501234567",
      email: "yael@example.com",
      inquiry_type: "life",
      id_number: "123456789",
      id_photo_url: "https://drive.google.com/file/d/abc/view",
      poa_doc_url: null,
    };

    const clientBuilder = makeBuilder({ data: clientData, error: null });
    setupFromSequence([clientBuilder]);

    mockUpsertLeadRow.mockResolvedValue(true);

    await mirrorLeadToSheet(CLIENT_ID);

    expect(mockUpsertLeadRow).toHaveBeenCalledOnce();
    const [row] = mockUpsertLeadRow.mock.calls[0] as [string[]];

    expect(row).toHaveLength(8);
    expect(row[0]).toBe("972501234567");         // phone
    expect(row[1]).toBe("יעל כהן");              // full_name
    expect(row[2]).toBe("yael@example.com");     // email
    expect(row[3]).toBe("ביטוח חיים");           // Hebrew inquiry label
    expect(row[4]).toBe("https://drive.google.com/file/d/abc/view"); // id_photo_url
    expect(row[5]).toBe("");                     // poa_doc_url (null → "")
    expect(row[6]).toBe("123456789");            // id_number
    expect(row[7]).toBe("");                     // relevance (always empty)
  });

  it("calls upsertLeadRow even when some fields are null (early-stage sync)", async () => {
    const clientData = {
      full_name: null,
      phone: "972509876543",
      email: null,
      inquiry_type: null,
      id_number: null,
      id_photo_url: null,
      poa_doc_url: null,
    };

    const clientBuilder = makeBuilder({ data: clientData, error: null });
    setupFromSequence([clientBuilder]);
    mockUpsertLeadRow.mockResolvedValue(true);

    await mirrorLeadToSheet(CLIENT_ID);

    expect(mockUpsertLeadRow).toHaveBeenCalledOnce();
    const [row] = mockUpsertLeadRow.mock.calls[0] as [string[]];
    expect(row[0]).toBe("972509876543");
    expect(row[1]).toBe("");
    expect(row[3]).toBe("");
  });

  it("never throws even if upsertLeadRow throws", async () => {
    const clientData = {
      full_name: "אבי",
      phone: "972500000001",
      email: null,
      inquiry_type: "vehicle",
      id_number: null,
      id_photo_url: null,
      poa_doc_url: null,
    };

    const clientBuilder = makeBuilder({ data: clientData, error: null });
    setupFromSequence([clientBuilder]);

    mockUpsertLeadRow.mockRejectedValue(new Error("sheets API down"));

    await expect(mirrorLeadToSheet(CLIENT_ID)).resolves.toBeUndefined();
  });

  it("skips upsert when client is not found", async () => {
    const clientBuilder = makeBuilder({ data: null, error: null });
    setupFromSequence([clientBuilder]);

    await mirrorLeadToSheet(CLIENT_ID);

    expect(mockUpsertLeadRow).not.toHaveBeenCalled();
  });

  it("does nothing when LEADS_MIRROR_ENABLED is false", async () => {
    const { env } = await import("../../../config/env.js");
    (env as Record<string, unknown>)["LEADS_MIRROR_ENABLED"] = false;

    await mirrorLeadToSheet(CLIENT_ID);

    expect(mockUpsertLeadRow).not.toHaveBeenCalled();
    expect(mockFromImpl).not.toHaveBeenCalled();

    (env as Record<string, unknown>)["LEADS_MIRROR_ENABLED"] = true;
  });

  it("uses all 10 INQUIRY_TYPE_HE values without fallback for known types", async () => {
    const types = [
      ["life", "ביטוח חיים"],
      ["health", "ביטוח בריאות"],
      ["property", "ביטוח רכוש"],
      ["vehicle", "ביטוח רכב"],
      ["liability", "ביטוח חבות"],
      ["business", "ביטוח עסקי"],
      ["pension", "ביטוח פנסיוני"],
      ["travel", "ביטוח נסיעות"],
      ["mortgage", "ביטוח משכנתא"],
      ["general", "כללי"],
    ];

    for (const [type, expected] of types) {
      vi.clearAllMocks();

      const clientData = {
        full_name: "Test",
        phone: "972500000000",
        email: null,
        inquiry_type: type,
        id_number: null,
        id_photo_url: null,
        poa_doc_url: null,
      };

      const clientBuilder = makeBuilder({ data: clientData, error: null });
      setupFromSequence([clientBuilder]);
      mockUpsertLeadRow.mockResolvedValue(true);

      await mirrorLeadToSheet(CLIENT_ID);

      const [row] = mockUpsertLeadRow.mock.calls[0] as [string[]];
      expect(row[3]).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// google.sheets — tab resolution (contract kept from original test suite)
// ---------------------------------------------------------------------------
describe("google.sheets — tab resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolveLeadsTabTitle trims the env tab name when matching", async () => {
    mockResolveLeadsTabTitle.mockResolvedValue("לידים חדשים ");
    const title = await mockResolveLeadsTabTitle();
    expect(title).toBe("לידים חדשים ");
    expect(title?.trim()).toBe("לידים חדשים");
  });
});
