import { google } from "googleapis";
import { logger } from "../../../config/logger.js";
import { getAuthenticatedClient } from "./google.auth.js";

export async function listSentMessageIds(q: string): Promise<string[]> {
  const auth = await getAuthenticatedClient();
  const gmail = google.gmail({ version: "v1", auth });

  const ids: string[] = [];
  let pageToken: string | undefined;

  do {
    const res = await gmail.users.messages.list({
      userId: "me",
      q,
      maxResults: 100,
      ...(pageToken ? { pageToken } : {}),
    });

    for (const msg of res.data.messages ?? []) {
      if (msg.id) ids.push(msg.id);
    }

    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken && ids.length < 400);

  return ids;
}

function decodeBase64Url(encoded: string): string {
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64").toString("utf8");
}

type GmailPart = {
  mimeType?: string | null;
  body?: { data?: string | null } | null;
  parts?: GmailPart[] | null;
};

function extractBodyText(part: GmailPart): string {
  const mime = part.mimeType ?? "";

  if (mime === "text/plain" && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }

  if (part.parts && part.parts.length > 0) {
    // Prefer text/plain among sub-parts
    const plainPart = part.parts.find((p) => p.mimeType === "text/plain");
    if (plainPart) return extractBodyText(plainPart);

    for (const child of part.parts) {
      const text = extractBodyText(child);
      if (text) return text;
    }
  }

  if (mime === "text/html" && part.body?.data) {
    const html = decodeBase64Url(part.body.data);
    return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }

  return "";
}

export async function getSentMessage(
  id: string,
): Promise<{ headers: Record<string, string>; bodyText: string; internalDate: number }> {
  const auth = await getAuthenticatedClient();
  const gmail = google.gmail({ version: "v1", auth });

  const res = await gmail.users.messages.get({ userId: "me", id, format: "full" });
  const msg = res.data;

  const headers: Record<string, string> = {};
  for (const h of msg.payload?.headers ?? []) {
    if (h.name && h.value) {
      headers[h.name.toLowerCase()] = h.value;
    }
  }

  const bodyText = msg.payload ? extractBodyText(msg.payload as GmailPart) : "";
  const internalDate = Number(msg.internalDate ?? 0);

  return { headers, bodyText, internalDate };
}

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
