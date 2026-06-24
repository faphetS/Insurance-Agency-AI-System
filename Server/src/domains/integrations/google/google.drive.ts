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
    logger.error({ err, name: opts.name }, "google.drive: uploadLeadDocument failed");
    return null;
  }
}
