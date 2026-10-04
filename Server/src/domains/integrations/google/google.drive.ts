import { Readable } from "node:stream";
import { google } from "googleapis";
import { env } from "../../../config/env.js";
import { logger } from "../../../config/logger.js";
import { getAuthenticatedClient } from "./google.auth.js";

export async function uploadLeadDocument(opts: {
  name: string;
  mimeType: string;
  bytes: Buffer;
}): Promise<{ fileId: string; webViewLink: string } | null> {
  let client;
  try {
    client = await getAuthenticatedClient();
  } catch (err) {
    logger.warn({ err }, "google.drive: not connected — skipping upload");
    return null;
  }

  try {
    const drive = google.drive({ version: "v3", auth: client });

    const createRes = await drive.files.create({
      requestBody: {
        name: opts.name,
        parents: [env.LEADS_DRIVE_FOLDER_ID],
      },
      media: {
        mimeType: opts.mimeType,
        body: Readable.from(opts.bytes),
      },
      fields: "id, webViewLink",
    });

    const fileId = createRes.data.id;
    const webViewLink = createRes.data.webViewLink;

    if (!fileId || !webViewLink) {
      logger.error({ createRes: createRes.data }, "google.drive: missing id or webViewLink");
      return null;
    }

    await drive.permissions.create({
      fileId,
      requestBody: { role: "reader", type: "anyone" },
    });

    return { fileId, webViewLink };
  } catch (err) {
    // The file name carries the lead's name (for a valid ID photo, the one read off the card),
    // and a GaxiosError keeps the request that carried it, plus any image bytes still buffered,
    // for pino to copy; so only status + message are logged.
    const e = err as { message?: string; code?: number | string; response?: { status?: number } } | null;
    logger.error(
      { err: { status: e?.response?.status ?? e?.code, message: e?.message }, mimeType: opts.mimeType },
      "google.drive: uploadLeadDocument failed",
    );
    return null;
  }
}
