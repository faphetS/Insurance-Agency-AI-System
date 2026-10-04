import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockFromImpl,
  mockFetchRemoteFile,
  mockExtFor,
  mockDownloadMetaMedia,
  mockUploadLeadDocument,
  mockMirrorLeadToSheet,
  mockValidateIdPhoto,
} = vi.hoisted(() => ({
  mockFromImpl: vi.fn(),
  mockFetchRemoteFile: vi.fn(),
  mockExtFor: vi.fn(() => "jpg"),
  mockDownloadMetaMedia: vi.fn(),
  mockUploadLeadDocument: vi.fn(),
  mockMirrorLeadToSheet: vi.fn(),
  mockValidateIdPhoto: vi.fn(),
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
vi.mock("./ai.service.js", () => ({ validateIdPhoto: mockValidateIdPhoto }));

import { captureLeadFile, resolveInboundMedia } from "./intake-media.js";
import { logger } from "../../config/logger.js";

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
function setupTables(
  clientResult: unknown,
  writes: { documents?: unknown; clientsUpdate?: unknown } = {},
) {
  const builders: Record<string, Builder> = {
    clients: makeBuilder(clientResult),
    documents: makeBuilder(writes.documents ?? { data: null, error: null }),
    clientsUpdate: makeBuilder(writes.clientsUpdate ?? { data: null, error: null }),
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
    data: { phone: "972501234567", full_name: "יעל כהן", intake_current_slot: "menu", ...over },
    error: null,
  };
}

const NOT_AN_ID = { valid: false, hasIdCard: false, hasAppendix: false, idNumber: null, fullName: null };
const VALID_ID = { valid: true, hasIdCard: true, hasAppendix: true, idNumber: "123456782", fullName: "ישראל ישראלי" };
const IMAGE_AS_FILE = { kind: "document" as const, mediaId: "media-9", mimeType: "image/jpeg", fileName: "IMG_1.jpg" };

// What Postgres' DETAIL looks like for a failing row: it must never reach the logs.
const PII_DETAILS = "Failing row contains (123456782, ישראל ישראלי)";

/** Every logger call so far, serialized — for "this never reaches the logs" checks. */
function allLogs(): string {
  return JSON.stringify(
    [logger.info, logger.warn, logger.error, logger.debug].map((fn) => vi.mocked(fn).mock.calls),
  );
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
  mockValidateIdPhoto.mockResolvedValue(NOT_AN_ID);
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
// captureLeadFile — silent ID check, archive, and every bail-out
// ---------------------------------------------------------------------------

describe("captureLeadFile", () => {
  it("non-ID image → OCR ran, archived as 'other', client row untouched, sheet mirrored", async () => {
    const { builders, tables } = setupTables(clientData());

    await captureLeadFile(CLIENT_ID, META_IMAGE);

    expect(mockValidateIdPhoto).toHaveBeenCalledOnce();
    expect(mockValidateIdPhoto.mock.calls[0]![0]).toMatch(/^data:image\/jpeg;base64,/);
    const up = mockUploadLeadDocument.mock.calls[0]![0] as { name: string; mimeType: string; bytes: Buffer };
    expect(up.bytes).toBe(BYTES);
    expect(up.mimeType).toBe("image/jpeg");
    // "<name> - YYYY-MM-DD HH.mm.ss.<ext>" — ":" would be unsafe in a file name
    expect(up.name).toMatch(/^יעל כהן - \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2}\.jpg$/);
    expect(tables).toContain("documents");
    expect(builders["documents"]!["insert"].mock.calls[0][0]).toMatchObject({
      client_id: CLIENT_ID,
      type: "other",
      file_url: "https://drive.google.com/file/d/drive-file-1/view",
      mime_type: "image/jpeg",
    });
    expect(builders["clientsUpdate"]!["update"]).not.toHaveBeenCalled();
    expect(mockMirrorLeadToSheet).toHaveBeenCalledWith(CLIENT_ID);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ docSaved: true, clientSaved: null }),
      "intake-media: lead file archived",
    );
  });

  it("valid ID + number → 'id_photo' row, number + validated + name on the client, Drive name from the ID", async () => {
    mockValidateIdPhoto.mockResolvedValue(VALID_ID);
    const { builders } = setupTables(clientData());

    await captureLeadFile(CLIENT_ID, META_IMAGE);

    const up = mockUploadLeadDocument.mock.calls[0]![0] as { name: string };
    expect(up.name).toBe("ישראל ישראלי - ID.jpg");
    expect(builders["documents"]!["insert"].mock.calls[0][0]).toMatchObject({ type: "id_photo" });
    expect(builders["clientsUpdate"]!["update"]).toHaveBeenCalledWith({
      id_photo_url: "https://drive.google.com/file/d/drive-file-1/view",
      id_number: "123456782",
      id_validated: true,
      full_name: "ישראל ישראלי",
    });
    expect(mockMirrorLeadToSheet).toHaveBeenCalledWith(CLIENT_ID);
  });

  it("valid ID whose number is unreadable → link saved, name and number untouched, warning logged", async () => {
    mockValidateIdPhoto.mockResolvedValue({ ...VALID_ID, idNumber: null });
    const { builders } = setupTables(clientData());

    await captureLeadFile(CLIENT_ID, META_IMAGE);

    expect(builders["documents"]!["insert"].mock.calls[0][0]).toMatchObject({ type: "id_photo" });
    // A family member's card must not rename the lead while E keeps the lead's own number.
    expect(builders["clientsUpdate"]!["update"]).toHaveBeenCalledWith({
      id_photo_url: "https://drive.google.com/file/d/drive-file-1/view",
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ clientId: CLIENT_ID }), expect.stringContaining("without a readable number"));
  });

  it("valid ID with no readable name → Drive name falls back to the lead's name + stamp, full_name untouched", async () => {
    mockValidateIdPhoto.mockResolvedValue({ ...VALID_ID, fullName: null });
    const { builders } = setupTables(clientData());

    await captureLeadFile(CLIENT_ID, META_IMAGE);

    const up = mockUploadLeadDocument.mock.calls[0]![0] as { name: string };
    expect(up.name).toMatch(/^יעל כהן - \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2}\.jpg$/);
    expect(builders["clientsUpdate"]!["update"]).toHaveBeenCalledWith({
      id_photo_url: "https://drive.google.com/file/d/drive-file-1/view",
      id_number: "123456782",
      id_validated: true,
    });
  });

  it("OCR throws → treated as not-an-ID, file still archived", async () => {
    mockValidateIdPhoto.mockRejectedValue(new Error("model down"));
    const { builders } = setupTables(clientData());

    await captureLeadFile(CLIENT_ID, META_IMAGE);

    expect(mockUploadLeadDocument).toHaveBeenCalledOnce();
    expect(builders["documents"]!["insert"].mock.calls[0][0]).toMatchObject({ type: "other" });
    expect(builders["clientsUpdate"]!["update"]).not.toHaveBeenCalled();
    expect(mockMirrorLeadToSheet).toHaveBeenCalledWith(CLIENT_ID);
  });

  it("a photo sent 'as a file' (document with image/* mime) is checked too", async () => {
    mockValidateIdPhoto.mockResolvedValue(VALID_ID);
    const { builders } = setupTables(clientData());

    await captureLeadFile(CLIENT_ID, IMAGE_AS_FILE);

    expect(mockValidateIdPhoto).toHaveBeenCalledOnce();
    expect(builders["documents"]!["insert"].mock.calls[0][0]).toMatchObject({ type: "id_photo", file_name: "IMG_1.jpg" });
  });

  it("a PDF is archived without OCR", async () => {
    mockExtFor.mockReturnValue("pdf");
    const { builders } = setupTables(clientData());

    await captureLeadFile(CLIENT_ID, GREEN_DOC);

    expect(mockValidateIdPhoto).not.toHaveBeenCalled();
    expect(mockFetchRemoteFile).toHaveBeenCalledWith("https://green.example/file.pdf");
    const up = mockUploadLeadDocument.mock.calls[0]![0] as { name: string; mimeType: string };
    expect(up.mimeType).toBe("application/pdf");
    expect(up.name).toMatch(/\.pdf$/);
    expect(builders["documents"]!["insert"].mock.calls[0][0]).toMatchObject({ type: "other", file_name: "policy.pdf" });
  });

  it("has no slot guard of its own: the pipeline skips only an image the id_photo step took", async () => {
    const { builders } = setupTables(clientData({ intake_current_slot: "id_photo" }));

    await captureLeadFile(CLIENT_ID, META_IMAGE);

    expect(builders["clients"]!["select"]).toHaveBeenCalledWith("phone, full_name");
    expect(mockUploadLeadDocument).toHaveBeenCalledOnce();
    expect(mockMirrorLeadToSheet).toHaveBeenCalledWith(CLIENT_ID);
  });

  it("text and placeholder payloads → does nothing at all (no DB, no upload)", async () => {
    setupTables(clientData());
    await captureLeadFile(CLIENT_ID, { kind: "text", text: "שלום" });
    await captureLeadFile(CLIENT_ID, { kind: "other", subtype: "audio", label: "[הודעה קולית]" });
    expect(mockFromImpl).not.toHaveBeenCalled();
    expect(mockUploadLeadDocument).not.toHaveBeenCalled();
  });

  it("client has no phone → skips before downloading", async () => {
    setupTables({ data: { phone: null, full_name: "x" }, error: null });
    await captureLeadFile(CLIENT_ID, META_IMAGE);
    expect(mockDownloadMetaMedia).not.toHaveBeenCalled();
    expect(mockUploadLeadDocument).not.toHaveBeenCalled();
  });

  it("media download fails → no OCR, no Drive upload, no mirror", async () => {
    mockDownloadMetaMedia.mockResolvedValue(null);
    setupTables(clientData());
    await captureLeadFile(CLIENT_ID, META_IMAGE);
    expect(mockValidateIdPhoto).not.toHaveBeenCalled();
    expect(mockUploadLeadDocument).not.toHaveBeenCalled();
    expect(mockMirrorLeadToSheet).not.toHaveBeenCalled();
  });

  it("Drive upload fails → no documents row, no client update, no mirror; the lead is named in the log", async () => {
    mockUploadLeadDocument.mockResolvedValue(null);
    const { tables } = setupTables(clientData());
    await captureLeadFile(CLIENT_ID, META_IMAGE);
    expect(tables).not.toContain("documents");
    expect(mockMirrorLeadToSheet).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      { clientId: CLIENT_ID, kind: "image", mimeType: "image/jpeg" },
      "intake-media: Drive upload failed — file not archived",
    );
  });

  it("client read fails → logged as a read failure, not as 'no phone'; nothing downloaded", async () => {
    setupTables({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } });

    await captureLeadFile(CLIENT_ID, META_IMAGE);

    expect(logger.error).toHaveBeenCalledWith(
      { clientId: CLIENT_ID, code: "57014", message: "canceling statement due to statement timeout" },
      "intake-media: client read failed — skipping capture",
    );
    expect(logger.warn).not.toHaveBeenCalled();
    expect(mockDownloadMetaMedia).not.toHaveBeenCalled();
    expect(mockUploadLeadDocument).not.toHaveBeenCalled();
  });

  it("documents insert fails on a valid ID → error logged without the number or name; the ID still reaches the client and the sheet", async () => {
    mockValidateIdPhoto.mockResolvedValue(VALID_ID);
    const { builders } = setupTables(clientData(), {
      documents: { data: null, error: { code: "XX000", message: "boom", details: PII_DETAILS } },
    });

    await captureLeadFile(CLIENT_ID, META_IMAGE);

    expect(logger.error).toHaveBeenCalledWith(
      { clientId: CLIENT_ID, fileId: "drive-file-1", code: "XX000", message: "boom" },
      "intake-media: documents insert failed — file is in Drive but not listed in column D",
    );
    expect(builders["clientsUpdate"]!["update"]).toHaveBeenCalledWith(
      expect.objectContaining({ id_number: "123456782", id_validated: true }),
    );
    expect(mockMirrorLeadToSheet).toHaveBeenCalledWith(CLIENT_ID);
    expect(logger.info).not.toHaveBeenCalledWith(expect.anything(), "intake-media: lead file archived");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ docSaved: false, clientSaved: true }),
      "intake-media: lead file is in Drive but not fully recorded",
    );
    expect(allLogs()).not.toContain("123456782");
    expect(allLogs()).not.toContain("ישראל ישראלי");
  });

  it("documents insert fails on a plain file → error logged, no sheet sync, no 'archived' line", async () => {
    setupTables(clientData(), { documents: { data: null, error: { code: "08006", message: "connection failure" } } });

    await captureLeadFile(CLIENT_ID, META_IMAGE);

    expect(logger.error).toHaveBeenCalledWith(
      { clientId: CLIENT_ID, fileId: "drive-file-1", code: "08006", message: "connection failure" },
      "intake-media: documents insert failed — file is in Drive but not listed in column D",
    );
    expect(mockMirrorLeadToSheet).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalledWith(expect.anything(), "intake-media: lead file archived");
  });

  it("client ID update fails → error logged without the number or name; the link still reaches the sheet", async () => {
    mockValidateIdPhoto.mockResolvedValue(VALID_ID);
    setupTables(clientData(), {
      clientsUpdate: { data: null, error: { code: "23514", message: "check constraint violated", details: PII_DETAILS } },
    });

    await captureLeadFile(CLIENT_ID, META_IMAGE);

    expect(logger.error).toHaveBeenCalledWith(
      { clientId: CLIENT_ID, fileId: "drive-file-1", code: "23514", message: "check constraint violated" },
      "intake-media: client ID update failed — number and name not saved",
    );
    expect(mockMirrorLeadToSheet).toHaveBeenCalledWith(CLIENT_ID);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ docSaved: true, clientSaved: false }),
      "intake-media: lead file is in Drive but not fully recorded",
    );
    expect(allLogs()).not.toContain("123456782");
    expect(allLogs()).not.toContain("ישראל ישראלי");
  });

  it("falls back to the phone digits when full_name is just the phone", async () => {
    setupTables(clientData({ full_name: "972501234567" }));
    await captureLeadFile(CLIENT_ID, META_IMAGE);
    const up = mockUploadLeadDocument.mock.calls[0]![0] as { name: string };
    expect(up.name).toMatch(/^972501234567 - /);
  });

  it("never throws when the DB blows up — the pipeline must not break", async () => {
    mockFromImpl.mockImplementation(() => {
      throw new Error("db down");
    });
    await expect(captureLeadFile(CLIENT_ID, META_IMAGE)).resolves.toBeUndefined();
    expect(mockUploadLeadDocument).not.toHaveBeenCalled();
  });
});
