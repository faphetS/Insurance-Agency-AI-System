import { google } from "googleapis";
import { logger } from "../../../config/logger.js";
import { getAuthenticatedClient } from "./google.auth.js";

export async function sendOwnerEmail(
  to: string,
  subject: string,
  bodyText: string,
): Promise<{ id: string }> {
  const client = await getAuthenticatedClient();
  const gmail = google.gmail({ version: "v1", auth: client });

  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
  const encodedBody = Buffer.from(bodyText, "utf8").toString("base64");

  const raw = [
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    encodedBody,
  ].join("\r\n");

  const rawBase64url = Buffer.from(raw, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: rawBase64url },
  });

  logger.info({ to, messageId: res.data.id }, "google.gmail: owner email sent");
  return { id: res.data.id ?? "" };
}
