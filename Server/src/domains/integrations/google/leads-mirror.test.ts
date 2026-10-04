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

function setupClient(clientOver: Record<string, unknown>, docUrls: string[] = []) {
  setupFromSequence([
    makeBuilder({ data: clientRow(clientOver), error: null }),
    makeBuilder(docsResult(docUrls)),
  ]);
}

// Each document's created_at spelled out: with no menu choice, only a file from the current
// inquiry (on/after intake_started_at, 1 min slack) opens a row.
function setupClientDocsAt(clientOver: Record<string, unknown>, docs: [url: string, createdAt: string][]) {
  setupFromSequence([
    makeBuilder({ data: clientRow(clientOver), error: null }),
    makeBuilder({ data: docs.map(([file_url, created_at]) => ({ file_url, created_at })), error: null }),
  ]);
}

import { mirrorLeadToSheet, backfillLeadDocuments } from "./leads-mirror.service.js";

const CLIENT_ID = "client-abc-123";

function clientRow(over: Record<string, unknown>) {
  return {
    phone: "972501234567",
    full_name: "יעל כהן",
    inquiry_type: "vehicle",
    client_type: null,
    id_number: null,
    intake_started_at: "2026-10-04T07:00:00.000Z",
    created_at: "2026-09-01T08:00:00.000Z",
    ...over,
  };
}

function docsResult(urls: string[]) {
  return { data: urls.map((u, i) => ({ file_url: u, created_at: `2026-10-0${i + 1}T08:00:00.000Z` })), error: null };
}

// ---------------------------------------------------------------------------
// 7-column progressive upsert into the new-leads tab (EVERY branch)
// ---------------------------------------------------------------------------

describe("mirrorLeadToSheet — 7-col row into the new-leads tab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpsertLeadRow.mockResolvedValue(true);
  });

  it("builds A→G with insurance label, document link, id number, empty relevance, creation date", async () => {
    setupClient(
      { inquiry_type: "life_health_pension", id_number: "123456782", client_type: "new" },
      ["https://drive.google.com/file/d/abc/view"],
    );

    await mirrorLeadToSheet(CLIENT_ID);

    expect(mockUpsertLeadRow).toHaveBeenCalledOnce();
    const [row, tab, opts] = mockUpsertLeadRow.mock.calls[0] as [string[], string, { setOnceColumns: number[] }];
    expect(row).toHaveLength(7);
    expect(row[0]).toBe("972501234567"); // A phone
    expect(row[1]).toBe("יעל כהן"); // B name
    expect(row[2]).toBe("ביטוח חיים/בריאות/פנסיה"); // C inquiry
    expect(row[3]).toBe("https://drive.google.com/file/d/abc/view"); // D document links
    expect(row[4]).toBe("123456782"); // E id number
    expect(row[5]).toBe(""); // F relevance (manual — always blank)
    expect(row[6]).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/); // G creation date
    expect(tab).toBe("לידים חדשים");
    expect(opts).toEqual({ setOnceColumns: [5, 6], startedAt: new Date("2026-10-04T07:00:00.000Z") });
  });

  it("col B is empty when full_name equals the phone (never echoes the phone)", async () => {
    setupClient({ full_name: "972501234567" });

    await mirrorLeadToSheet(CLIENT_ID);

    const [row] = mockUpsertLeadRow.mock.calls[0] as [string[]];
    expect(row[1]).toBe("");
  });

  it("callback inquiry → col C 'בקשת שיחה חוזרת', new-leads tab", async () => {
    setupClient({ inquiry_type: "callback" });
    await mirrorLeadToSheet(CLIENT_ID);
    const [row, tab] = mockUpsertLeadRow.mock.calls[0] as [string[], string];
    expect(row[2]).toBe("בקשת שיחה חוזרת");
    expect(tab).toBe("לידים חדשים");
  });

  it("meeting + client_type old → 'תיאום פגישה — לקוח קיים', existing-client tab", async () => {
    setupClient({ inquiry_type: "meeting", client_type: "old" });
    await mirrorLeadToSheet(CLIENT_ID);
    const [row, tab] = mockUpsertLeadRow.mock.calls[0] as [string[], string];
    expect(row[2]).toBe("תיאום פגישה — לקוח קיים");
    expect(tab).toBe("לקוח קיים");
  });

  it("meeting + client_type new → 'תיאום פגישה — לקוח חדש', new-leads tab", async () => {
    setupClient({ inquiry_type: "meeting", client_type: "new" });
    await mirrorLeadToSheet(CLIENT_ID);
    const [row, tab] = mockUpsertLeadRow.mock.calls[0] as [string[], string];
    expect(row[2]).toBe("תיאום פגישה — לקוח חדש");
    expect(tab).toBe("לידים חדשים");
  });

  it("vehicle inquiry → new-leads tab", async () => {
    setupClient({ inquiry_type: "vehicle" });
    await mirrorLeadToSheet(CLIENT_ID);
    const [, tab] = mockUpsertLeadRow.mock.calls[0] as [string[], string];
    expect(tab).toBe("לידים חדשים");
  });

  it("mirrors non-meeting inquiries regardless of client_type", async () => {
    setupClient({ client_type: null, inquiry_type: "home" });
    await mirrorLeadToSheet(CLIENT_ID);
    expect(mockUpsertLeadRow).toHaveBeenCalledOnce();
    const [row, tab] = mockUpsertLeadRow.mock.calls[0] as [string[], string];
    expect(row[2]).toBe("ביטוח דירה");
    expect(tab).toBe("לידים חדשים");
  });
});

// ---------------------------------------------------------------------------
// Tab-routing gates — no row until a definitive choice is made
// ---------------------------------------------------------------------------

describe("mirrorLeadToSheet — routing gates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpsertLeadRow.mockResolvedValue(true);
  });

  it("skips when inquiry_type is 'general' (no menu choice yet)", async () => {
    setupClient({ inquiry_type: "general" });
    await mirrorLeadToSheet(CLIENT_ID);
    expect(mockUpsertLeadRow).not.toHaveBeenCalled();
  });

  it("skips when inquiry_type is null", async () => {
    setupClient({ inquiry_type: null });
    await mirrorLeadToSheet(CLIENT_ID);
    expect(mockUpsertLeadRow).not.toHaveBeenCalled();
  });

  it("skips a meeting request before the existing/new sub-choice (client_type null)", async () => {
    setupClient({ inquiry_type: "meeting", client_type: null });
    await mirrorLeadToSheet(CLIENT_ID);
    expect(mockUpsertLeadRow).not.toHaveBeenCalled();
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
    setupClient({ phone: null });
    await mirrorLeadToSheet(CLIENT_ID);
    expect(mockUpsertLeadRow).not.toHaveBeenCalled();
  });

  it("skips when the client is not found", async () => {
    setupFromSequence([makeBuilder({ data: null, error: null })]);
    await mirrorLeadToSheet(CLIENT_ID);
    expect(mockUpsertLeadRow).not.toHaveBeenCalled();
  });

  it("a failed client read is logged as the DB error it is, not as 'client not found'", async () => {
    const error = { message: 'column "intake_started_at" does not exist', code: "42703" };
    setupFromSequence([makeBuilder({ data: null, error })]);

    await mirrorLeadToSheet(CLIENT_ID);

    expect(mockUpsertLeadRow).not.toHaveBeenCalled();
    const { logger } = await import("../../../config/logger.js");
    expect(logger.error).toHaveBeenCalledWith({ clientId: CLIENT_ID, error }, "leads-mirror: client read failed — skipping");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("a failed documents read writes nothing, so the links already in col D are never blanked", async () => {
    const error = { message: "Connection terminated unexpectedly" };
    setupFromSequence([makeBuilder({ data: clientRow({}), error: null }), makeBuilder({ data: null, error })]);

    await mirrorLeadToSheet(CLIENT_ID);

    expect(mockUpsertLeadRow).not.toHaveBeenCalled();
    const { logger } = await import("../../../config/logger.js");
    expect(logger.error).toHaveBeenCalledWith({ clientId: CLIENT_ID, error }, "leads-mirror: documents read failed — skipping");
  });

  it("never throws even if upsertLeadRow throws", async () => {
    setupClient({});
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

// ---------------------------------------------------------------------------
// Column D = every file the lead sent (documents rows, oldest first). A lead who
// sent a file in this inquiry before choosing a menu option still needs a row, since
// the sheet is the only place the links surface.
// ---------------------------------------------------------------------------

describe("mirrorLeadToSheet — column D from documents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpsertLeadRow.mockResolvedValue(true);
  });

  it("joins every document link oldest-first, one per line", async () => {
    setupClient({ inquiry_type: "vehicle" }, ["https://drive/1", "https://drive/2", "https://drive/3"]);

    await mirrorLeadToSheet(CLIENT_ID);

    const [row] = mockUpsertLeadRow.mock.calls[0] as [string[]];
    expect(row[3]).toBe("https://drive/1\nhttps://drive/2\nhttps://drive/3");
  });

  it("reads documents ordered by created_at ascending", async () => {
    const docs = makeBuilder(docsResult(["https://drive/1"]));
    setupFromSequence([makeBuilder({ data: clientRow({}), error: null }), docs]);

    await mirrorLeadToSheet(CLIENT_ID);

    expect(docs["eq"]).toHaveBeenCalledWith("client_id", CLIENT_ID);
    expect(docs["order"]).toHaveBeenCalledWith("created_at", { ascending: true });
  });

  it("'general' + a document from this inquiry → row IS written, col C blank, into the new-leads tab", async () => {
    setupClientDocsAt({ inquiry_type: "general" }, [
      ["https://drive.google.com/file/d/cap/view", "2026-10-04T07:05:00.000Z"],
    ]);

    await mirrorLeadToSheet(CLIENT_ID);

    expect(mockUpsertLeadRow).toHaveBeenCalledOnce();
    const [row, tab, opts] = mockUpsertLeadRow.mock.calls[0] as [string[], string, { setOnceColumns: number[] }];
    expect(row[2]).toBe("");
    expect(row[3]).toBe("https://drive.google.com/file/d/cap/view");
    expect(tab).toBe("לידים חדשים");
    expect(opts.setOnceColumns).toEqual([2, 5, 6]);
  });

  it("still skips 'general' when there is no document", async () => {
    setupClient({ inquiry_type: "general" }, []);
    await mirrorLeadToSheet(CLIENT_ID);
    expect(mockUpsertLeadRow).not.toHaveBeenCalled();
  });

  it("a returning lead back on 'general' whose files all predate this inquiry → no row (they sit on the previous inquiry's row)", async () => {
    setupClientDocsAt({ inquiry_type: "general" }, [
      ["https://drive/old-id", "2026-09-20T08:00:00.000Z"],
      ["https://drive/old-2", "2026-10-04T06:58:59.000Z"], // 61 s before intake_started_at
    ]);

    await mirrorLeadToSheet(CLIENT_ID);

    expect(mockUpsertLeadRow).not.toHaveBeenCalled();
  });

  it("a returning lead's new file opens the row, and col D still lists every link, old ones included", async () => {
    setupClientDocsAt({ inquiry_type: "general" }, [
      ["https://drive/old-id", "2026-09-20T08:00:00.000Z"],
      ["https://drive/new", "2026-10-04T07:05:00.000Z"],
    ]);

    await mirrorLeadToSheet(CLIENT_ID);

    expect(mockUpsertLeadRow).toHaveBeenCalledOnce();
    const [row] = mockUpsertLeadRow.mock.calls[0] as [string[]];
    expect(row[3]).toBe("https://drive/old-id\nhttps://drive/new");
  });

  it("a file that raced the restart stamp (under 1 min before intake_started_at) still counts", async () => {
    setupClientDocsAt({ inquiry_type: "general" }, [["https://drive/raced", "2026-10-04T06:59:30.000Z"]]);

    await mirrorLeadToSheet(CLIENT_ID);

    expect(mockUpsertLeadRow).toHaveBeenCalledOnce();
  });

  it("a pre-migration lead (no intake_started_at) on 'general' with a file still gets a row: created_at stands in", async () => {
    setupClient({ inquiry_type: "general", intake_started_at: null }, ["https://drive/x"]);

    await mirrorLeadToSheet(CLIENT_ID);

    expect(mockUpsertLeadRow).toHaveBeenCalledOnce();
  });

  it("a known inquiry still overwrites col C (setOnce stays [5,6])", async () => {
    setupClient({ inquiry_type: "vehicle" }, ["https://drive/x"]);
    await mirrorLeadToSheet(CLIENT_ID);
    const [row, , opts] = mockUpsertLeadRow.mock.calls[0] as [string[], string, { setOnceColumns: number[] }];
    expect(row[2]).toBe("ביטוח רכב");
    expect(opts.setOnceColumns).toEqual([5, 6]);
  });

  it("falls back to created_at as startedAt when intake_started_at is null (pre-migration clients)", async () => {
    setupClient({ intake_started_at: null });
    await mirrorLeadToSheet(CLIENT_ID);
    const [, , opts] = mockUpsertLeadRow.mock.calls[0] as [string[], string, { startedAt: Date }];
    expect(opts.startedAt).toEqual(new Date("2026-09-01T08:00:00.000Z"));
  });
});

// ---------------------------------------------------------------------------
// One-off backfill: re-mirror every client that has at least one document
// ---------------------------------------------------------------------------

describe("backfillLeadDocuments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpsertLeadRow.mockResolvedValue(true);
  });

  it("mirrors each distinct client once, in order", async () => {
    const docsList = makeBuilder({
      data: [{ client_id: "c1" }, { client_id: "c2" }, { client_id: "c1" }],
      error: null,
    });
    // After the documents listing, each mirrorLeadToSheet does clients → documents.
    setupFromSequence([
      docsList,
      makeBuilder({ data: clientRow({}), error: null }),
      makeBuilder(docsResult(["https://drive/a"])),
      makeBuilder({ data: clientRow({ phone: "972509999999" }), error: null }),
      makeBuilder(docsResult(["https://drive/b"])),
    ]);

    const result = await backfillLeadDocuments();

    expect(result).toEqual({ clients: 2 });
    expect(mockUpsertLeadRow).toHaveBeenCalledTimes(2);
    expect((mockUpsertLeadRow.mock.calls[0] as [string[]])[0][0]).toBe("972501234567");
    expect((mockUpsertLeadRow.mock.calls[1] as [string[]])[0][0]).toBe("972509999999");
  });

  it("no documents → nothing mirrored", async () => {
    setupFromSequence([makeBuilder({ data: [], error: null })]);
    const result = await backfillLeadDocuments();
    expect(result).toEqual({ clients: 0 });
    expect(mockUpsertLeadRow).not.toHaveBeenCalled();
  });

  it("a failed documents listing fails the run instead of reporting success with 0 clients", async () => {
    const error = { message: "Connection terminated unexpectedly" };
    setupFromSequence([makeBuilder({ data: null, error })]);

    await expect(backfillLeadDocuments()).rejects.toMatchObject({ statusCode: 500, code: "LEADS_BACKFILL_READ_FAILED" });

    expect(mockUpsertLeadRow).not.toHaveBeenCalled();
    const { logger } = await import("../../../config/logger.js");
    expect(logger.error).toHaveBeenCalledWith({ error }, "leads-mirror: backfill documents read failed");
    expect(logger.info).not.toHaveBeenCalled();
  });
});
