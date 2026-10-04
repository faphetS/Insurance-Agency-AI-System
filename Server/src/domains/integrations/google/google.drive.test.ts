import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFilesCreate, mockPermissionsCreate, mockGetAuthenticatedClient } = vi.hoisted(() => ({
  mockFilesCreate: vi.fn(),
  mockPermissionsCreate: vi.fn(),
  mockGetAuthenticatedClient: vi.fn(),
}));

vi.mock("../../../config/env.js", () => ({
  env: { LEADS_DRIVE_FOLDER_ID: "folder-id", NODE_ENV: "test" },
}));

vi.mock("../../../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("googleapis", () => ({
  google: {
    drive: vi.fn(() => ({
      files: { create: mockFilesCreate },
      permissions: { create: mockPermissionsCreate },
    })),
  },
}));

vi.mock("./google.auth.js", () => ({
  getAuthenticatedClient: mockGetAuthenticatedClient,
}));

import { uploadLeadDocument } from "./google.drive.js";
import { logger } from "../../../config/logger.js";

// A valid ID photo is uploaded as "<name read off the card> - ID.<ext>".
const NAME = "ישראל ישראלי - ID.jpg";

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAuthenticatedClient.mockResolvedValue({});
});

describe("uploadLeadDocument — failure log", () => {
  it("logs status + message + mimeType only, never the file name or the request carrying it", async () => {
    // googleapis sends the metadata (incl. the name) inside the multipart request body,
    // and a GaxiosError keeps that request on config / response.config.
    const config = { method: "POST", data: { multipartMetadata: JSON.stringify({ name: NAME, parents: ["folder-id"] }) } };
    mockFilesCreate.mockRejectedValue(
      Object.assign(new Error("Internal Error"), {
        code: 500,
        status: 500,
        config,
        response: { status: 500, config, data: { error: { code: 500, message: "Internal Error" } } },
      }),
    );

    const result = await uploadLeadDocument({ name: NAME, mimeType: "image/jpeg", bytes: Buffer.from("jpeg") });

    expect(result).toBeNull();
    expect(mockFilesCreate).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      { err: { status: 500, message: "Internal Error" }, mimeType: "image/jpeg" },
      "google.drive: uploadLeadDocument failed",
    );
    const logged = JSON.stringify(vi.mocked(logger.error).mock.calls);
    expect(logged).not.toContain("ישראל");
  });
});
