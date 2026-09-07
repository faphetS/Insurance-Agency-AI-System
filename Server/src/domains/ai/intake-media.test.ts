import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockFromImpl,
  mockFetchRemoteFile,
  mockExtFor,
  mockDownloadMetaMedia,
  mockUploadLeadDocument,
  mockMirrorLeadToSheet,
} = vi.hoisted(() => ({
  mockFromImpl: vi.fn(),
  mockFetchRemoteFile: vi.fn(),
  mockExtFor: vi.fn(() => "jpg"),
  mockDownloadMetaMedia: vi.fn(),
  mockUploadLeadDocument: vi.fn(),
  mockMirrorLeadToSheet: vi.fn(),
}));

vi.mock("../../config/env.js", () => ({ env: { NODE_ENV: "test" } }));
vi.mock("../../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../config/supabase.js", () => ({ supabaseAdmin: { from: mockFromImpl } }));
vi.mock("../../lib/storage.js", () => ({
  fetchRemoteFile: mockFetchRemoteFile,
  extFor: mockExtFor,
}));
vi.mock("../whatsapp/meta/meta.media.js", () => ({ downloadMetaMedia: mockDownloadMetaMedia }));
vi.mock("../integrations/google/google.drive.js", () => ({ uploadLeadDocument: mockUploadLeadDocument }));
vi.mock("../integrations/google/leads-mirror.service.js", () => ({ mirrorLeadToSheet: mockMirrorLeadToSheet }));

import { captureIntakeDocument, resolveInboundMedia } from "./intake-media.js";

// ---------------------------------------------------------------------------
// Supabase shim builders
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Builder = Record<string, any>;

function makeBuilder(result: unknown): Builder {
  const terminal = vi.fn().mockResolvedValue(result);
  const builder: Builder = {};
  for (const m of ["select", "eq", "insert", "update", "upsert", "limit", "order"]) {
    builder[m] = vi.fn().mockReturnValue(builder);
  }
  builder["maybeSingle"] = terminal;
  builder["single"] = terminal;
  builder["then"] = (onFulfilled: (v: unknown) => unknown) => Promise.resolve(result).then(onFulfilled);
  return builder;
}

/** Records which table each .from() call targeted; the 2nd clients call is the update. */
function setupTables(clientResult: unknown) {
  const builders: Record<string, Builder> = {
    clients: makeBuilder(clientResult),
    documents: makeBuilder({ data: null, error: null }),
    clientsUpdate: makeBuilder({ data: null, error: null }),
  };
  const tables: string[] = [];
  let clientsCalls = 0;
  mockFromImpl.mockImplementation((table: string) => {
    tables.push(table);
    if (table === "clients") {
      clientsCalls += 1;
      return clientsCalls === 1 ? builders["clients"]! : builders["clientsUpdate"]!;
    }
    return builders["documents"]!;
  });
  return { builders, tables };
}

const CLIENT_ID = "client-abc-123";
const BYTES = Buffer.from("fake-image-bytes");

function clientData(over: Record<string, unknown> = {}) {
  return {
    data: { phone: "972501234567", full_name: "יעל כהן", id_validated: false, ...over },
    error: null,
  };
}

const META_IMAGE = { kind: "image" as const, mediaId: "media-1", mimeType: "image/jpeg" };
const GREEN_DOC = {
  kind: "document" as const,
  fileUrl: "https://green.example/file.pdf",
  mimeType: "application/pdf",
  fileName: "policy.pdf",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockExtFor.mockReturnValue("jpg");
  mockDownloadMetaMedia.mockResolvedValue({ bytes: BYTES, mimeType: "image/jpeg" });
  mockFetchRemoteFile.mockResolvedValue(BYTES);
  mockUploadLeadDocument.mockResolvedValue({
    fileId: "drive-file-1",
    webViewLink: "https://drive.google.com/file/d/drive-file-1/view",
  });
  mockMirrorLeadToSheet.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// resolveInboundMedia — transport split
// ---------------------------------------------------------------------------

describe("resolveInboundMedia", () => {
  it("Meta mediaId → downloadMetaMedia bytes", async () => {
    await expect(resolveInboundMedia(META_IMAGE)).resolves.toBe(BYTES);
    expect(mockDownloadMetaMedia).toHaveBeenCalledWith("media-1");
    expect(mockFetchRemoteFile).not.toHaveBeenCalled();
  });

  it("GreenAPI fileUrl → fetchRemoteFile bytes", async () => {
    await expect(resolveInboundMedia(GREEN_DOC)).resolves.toBe(BYTES);
    expect(mockFetchRemoteFile).toHaveBeenCalledWith("https://green.example/file.pdf");
    expect(mockDownloadMetaMedia).not.toHaveBeenCalled();
  });

  it("text payload → null", async () => {
    await expect(resolveInboundMedia({ kind: "text", text: "hi" })).resolves.toBeNull();
  });

  it("media message with neither url nor id → null", async () => {
    await expect(resolveInboundMedia({ kind: "image" })).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// captureIntakeDocument — happy path and every bail-out
// ---------------------------------------------------------------------------

describe("captureIntakeDocument", () => {
  it("Meta image → Drive upload, documents row, id_photo_url, sheet mirror", async () => {
    const { builders, tables } = setupTables(clientData());

    await captureIntakeDocument(CLIENT_ID, META_IMAGE);

    expect(mockUploadLeadDocument).toHaveBeenCalledOnce();
    const up = mockUploadLeadDocument.mock.calls[0]![0] as {
      name: string;
      mimeType: string;
      bytes: Buffer;
    };
    expect(up.bytes).toBe(BYTES);
    expect(up.mimeType).toBe("image/jpeg");
    // "<name> - YYYY-MM-DD HH.mm.ss.<ext>" — ":" would be unsafe in a file name
    expect(up.name).toMatch(/^יעל כהן - \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2}\.jpg$/);
    expect(up.name).not.toContain(":");

    expect(tables).toContain("documents");
    const doc = builders["documents"]!["insert"].mock.calls[0][0];
    expect(doc).toMatchObject({
      client_id: CLIENT_ID,
      type: "other", // schema CHECK is a fixed set; 'id_photo' stays reserved for OCR-verified
      file_url: "https://drive.google.com/file/d/drive-file-1/view",
      mime_type: "image/jpeg",
    });

    expect(builders["clientsUpdate"]!["update"]).toHaveBeenCalledWith({
      id_photo_url: "https://drive.google.com/file/d/drive-file-1/view",
    });
    expect(mockMirrorLeadToSheet).toHaveBeenCalledWith(CLIENT_ID);
  });

  it("GreenAPI document → downloaded by url, real mime + filename carried through", async () => {
    mockExtFor.mockReturnValue("pdf");
    const { builders } = setupTables(clientData());

    await captureIntakeDocument(CLIENT_ID, GREEN_DOC);

    expect(mockFetchRemoteFile).toHaveBeenCalledWith("https://green.example/file.pdf");
    const up = mockUploadLeadDocument.mock.calls[0]![0] as { name: string; mimeType: string };
    expect(up.mimeType).toBe("application/pdf");
    expect(up.name).toMatch(/\.pdf$/);
    expect(builders["documents"]!["insert"].mock.calls[0][0]).toMatchObject({
      file_name: "policy.pdf",
    });
  });

  it("text payload → does nothing at all (no DB, no upload)", async () => {
    setupTables(clientData());
    await captureIntakeDocument(CLIENT_ID, { kind: "text", text: "שלום" });
    expect(mockFromImpl).not.toHaveBeenCalled();
    expect(mockUploadLeadDocument).not.toHaveBeenCalled();
  });

  it("client has no phone → skips before downloading", async () => {
    setupTables({ data: { phone: null, full_name: "x" }, error: null });
    await captureIntakeDocument(CLIENT_ID, META_IMAGE);
    expect(mockDownloadMetaMedia).not.toHaveBeenCalled();
    expect(mockUploadLeadDocument).not.toHaveBeenCalled();
  });

  it("media download fails → no Drive upload, no mirror", async () => {
    mockDownloadMetaMedia.mockResolvedValue(null);
    setupTables(clientData());
    await captureIntakeDocument(CLIENT_ID, META_IMAGE);
    expect(mockUploadLeadDocument).not.toHaveBeenCalled();
    expect(mockMirrorLeadToSheet).not.toHaveBeenCalled();
  });

  it("Drive upload fails → no documents row, no client update, no mirror", async () => {
    mockUploadLeadDocument.mockResolvedValue(null);
    const { tables } = setupTables(clientData());
    await captureIntakeDocument(CLIENT_ID, META_IMAGE);
    expect(tables).not.toContain("documents");
    expect(mockMirrorLeadToSheet).not.toHaveBeenCalled();
  });

  it("an OCR-verified ID is never overwritten — archived to Drive, sheet untouched", async () => {
    const { builders, tables } = setupTables(clientData({ id_validated: true }));

    await captureIntakeDocument(CLIENT_ID, META_IMAGE);

    expect(mockUploadLeadDocument).toHaveBeenCalledOnce(); // still archived
    expect(tables).toContain("documents");
    expect(builders["clientsUpdate"]!["update"]).not.toHaveBeenCalled();
    expect(mockMirrorLeadToSheet).not.toHaveBeenCalled();
  });

  it("falls back to the phone digits when full_name is just the phone", async () => {
    setupTables(clientData({ full_name: "972501234567" }));
    await captureIntakeDocument(CLIENT_ID, META_IMAGE);
    const up = mockUploadLeadDocument.mock.calls[0]![0] as { name: string };
    expect(up.name).toMatch(/^972501234567 - /);
  });

  it("never throws when the DB blows up — intake must not break", async () => {
    mockFromImpl.mockImplementation(() => {
      throw new Error("db down");
    });
    await expect(captureIntakeDocument(CLIENT_ID, META_IMAGE)).resolves.toBeUndefined();
    expect(mockUploadLeadDocument).not.toHaveBeenCalled();
  });
});
