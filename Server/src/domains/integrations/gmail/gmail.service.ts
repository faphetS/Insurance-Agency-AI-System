import { google } from "googleapis";
import { supabaseAdmin } from "../../../config/supabase.js";
import { env } from "../../../config/env.js";
import { logger } from "../../../config/logger.js";
import { AppError } from "../../../lib/errors.js";
import type { GmailIntegration, ParsedEmail } from "./gmail.types.js";

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
];

function createOAuth2Client() {
  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) {
    throw new AppError(
      503,
      "Gmail OAuth credentials are not configured. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.",
      "GMAIL_NOT_CONFIGURED",
    );
  }
  return new google.auth.OAuth2(
    env.GOOGLE_OAUTH_CLIENT_ID,
    env.GOOGLE_OAUTH_CLIENT_SECRET,
    env.GOOGLE_OAUTH_REDIRECT_URI,
  );
}

export function getAuthorizationUrl(staffId: string): string {
  const client = createOAuth2Client();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: GMAIL_SCOPES,
    state: staffId,
  });
}

export async function handleCallback(
  code: string,
  state: string,
): Promise<{ email: string }> {
  const staffId = state;

  const client = createOAuth2Client();
  const { tokens } = await client.getToken(code);

  if (!tokens.refresh_token) {
    throw new AppError(
      400,
      "No refresh token received. Revoke access at myaccount.google.com/permissions and re-authorize.",
      "NO_REFRESH_TOKEN",
    );
  }

  client.setCredentials(tokens);
  const gmail = google.gmail({ version: "v1", auth: client });
  const profile = await gmail.users.getProfile({ userId: "me" });
  const email = profile.data.emailAddress;

  if (!email) {
    throw new AppError(500, "Failed to retrieve Gmail address from profile", "GMAIL_PROFILE_ERROR");
  }

  const expiresAt = tokens.expiry_date
    ? new Date(tokens.expiry_date).toISOString()
    : null;

  const { error } = await supabaseAdmin
    .from("gmail_integrations")
    .upsert(
      {
        staff_id: staffId,
        email,
        refresh_token: tokens.refresh_token,
        access_token: tokens.access_token ?? null,
        access_token_expires_at: expiresAt,
        scope: tokens.scope ?? GMAIL_SCOPES.join(" "),
        connected_at: new Date().toISOString(),
        is_active: true,
        last_error: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "staff_id" },
    );

  if (error) {
    logger.error({ error, staffId }, "gmail.handleCallback: upsert failed");
    throw new AppError(500, "Failed to store Gmail integration", "GMAIL_STORE_FAILED");
  }

  logger.info({ staffId, email }, "gmail.handleCallback: integration stored");
  return { email };
}

export async function getValidAccessToken(integration: GmailIntegration): Promise<string> {
  const now = Date.now();
  const bufferMs = 60_000;

  const expiresAt = integration.access_token_expires_at
    ? new Date(integration.access_token_expires_at).getTime()
    : 0;

  if (integration.access_token && expiresAt > now + bufferMs) {
    return integration.access_token;
  }

  const client = createOAuth2Client();
  client.setCredentials({ refresh_token: integration.refresh_token });

  const { credentials } = await client.refreshAccessToken();

  const newExpiresAt = credentials.expiry_date
    ? new Date(credentials.expiry_date).toISOString()
    : null;

  await supabaseAdmin
    .from("gmail_integrations")
    .update({
      access_token: credentials.access_token ?? null,
      access_token_expires_at: newExpiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq("staff_id", integration.staff_id);

  if (!credentials.access_token) {
    throw new AppError(500, "Failed to refresh access token", "GMAIL_REFRESH_FAILED");
  }

  return credentials.access_token;
}

export async function getAuthenticatedGmailClient(integration: GmailIntegration) {
  const accessToken = await getValidAccessToken(integration);
  const client = createOAuth2Client();
  client.setCredentials({ access_token: accessToken });
  return google.gmail({ version: "v1", auth: client });
}

export async function sendGmailEmail(
  integration: GmailIntegration,
  to: string,
  subject: string,
  bodyText: string,
): Promise<{ id: string }> {
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
  const encodedBody = Buffer.from(bodyText, "utf8").toString("base64");

  const raw = [
    `From: ${integration.email}`,
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

  const gmail = await getAuthenticatedGmailClient(integration);
  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: rawBase64url },
  });

  return { id: res.data.id ?? "" };
}

export async function getOwnerGmailIntegration(): Promise<GmailIntegration | null> {
  const { data: ownerStaff } = await supabaseAdmin
    .from("staff")
    .select("id")
    .eq("role", "owner")
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  if (!ownerStaff) return null;

  const { data: integration } = await supabaseAdmin
    .from("gmail_integrations")
    .select("*")
    .eq("staff_id", (ownerStaff as { id: string }).id)
    .eq("is_active", true)
    .maybeSingle();

  return (integration as GmailIntegration | null) ?? null;
}

export async function countUnreadEmails(staffId: string): Promise<number> {
  const { data: integration, error: fetchErr } = await supabaseAdmin
    .from("gmail_integrations")
    .select("*")
    .eq("staff_id", staffId)
    .eq("is_active", true)
    .single();

  if (fetchErr || !integration) {
    throw new AppError(404, `No active Gmail integration for staff ${staffId}`, "GMAIL_NOT_FOUND");
  }

  const accessToken = await getValidAccessToken(integration as GmailIntegration);

  const client = createOAuth2Client();
  client.setCredentials({ access_token: accessToken });
  const gmail = google.gmail({ version: "v1", auth: client });

  const response = await gmail.users.messages.list({
    userId: "me",
    // Last 24h only — the daily digest reports recent activity, not the whole unread backlog.
    q: "is:unread -category:promotions -category:social newer_than:1d",
    maxResults: 100,
  });

  // Count actual returned messages — Gmail's resultSizeEstimate is unreliable and
  // often ignores the date filter (echoing a mailbox-wide estimate).
  return response.data.messages?.length ?? 0;
}

export async function getGmailStatus(staffId: string): Promise<{
  connected: boolean;
  email: string | null;
  lastSyncedAt: string | null;
}> {
  const { data } = await supabaseAdmin
    .from("gmail_integrations")
    .select("email, is_active, last_synced_at")
    .eq("staff_id", staffId)
    .maybeSingle();

  if (!data) {
    return { connected: false, email: null, lastSyncedAt: null };
  }

  return {
    connected: Boolean(data.is_active),
    email: (data.email as string | null) ?? null,
    lastSyncedAt: (data.last_synced_at as string | null) ?? null,
  };
}

function decodeBase64Url(encoded: string): string {
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64").toString("utf-8");
}

function stripHtmlTags(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s{2,}/g, " ")
    .trim();
}

type GmailMessagePart = {
  mimeType?: string | null;
  body?: { data?: string | null } | null;
  parts?: GmailMessagePart[] | null;
};

function extractBodyText(payload: GmailMessagePart): string {
  const plainParts: string[] = [];
  const htmlParts: string[] = [];

  function walk(part: GmailMessagePart) {
    const mime = part.mimeType ?? "";

    if (mime === "text/plain" && part.body?.data) {
      plainParts.push(decodeBase64Url(part.body.data));
      return;
    }

    if (mime === "text/html" && part.body?.data) {
      htmlParts.push(decodeBase64Url(part.body.data));
      return;
    }

    if (mime.startsWith("multipart/") && part.parts) {
      for (const child of part.parts) {
        walk(child);
      }
      return;
    }

    // Top-level payload with body.data but no explicit mimeType — treat as plain
    if (!mime && part.body?.data) {
      plainParts.push(decodeBase64Url(part.body.data));
    }
  }

  walk(payload);

  if (plainParts.length > 0) {
    return plainParts.join("\n").trim();
  }
  if (htmlParts.length > 0) {
    return stripHtmlTags(htmlParts.join("\n"));
  }
  return "";
}

function headerValue(
  headers: Array<{ name?: string | null; value?: string | null }>,
  name: string,
): string {
  const lower = name.toLowerCase();
  return headers.find((h) => h.name?.toLowerCase() === lower)?.value ?? "";
}

export async function fetchMessages(
  staffId: string,
  opts: { q?: string; maxResults?: number },
): Promise<ParsedEmail[]> {
  const { data: integration, error: fetchErr } = await supabaseAdmin
    .from("gmail_integrations")
    .select("*")
    .eq("staff_id", staffId)
    .eq("is_active", true)
    .single();

  if (fetchErr || !integration) {
    throw new AppError(404, `No active Gmail integration for staff ${staffId}`, "GMAIL_NOT_FOUND");
  }

  const accessToken = await getValidAccessToken(integration as GmailIntegration);
  const client = createOAuth2Client();
  client.setCredentials({ access_token: accessToken });
  const gmail = google.gmail({ version: "v1", auth: client });

  const listRes = await gmail.users.messages.list({
    userId: "me",
    q: opts.q ?? "newer_than:30d",
    maxResults: opts.maxResults ?? 10,
  });

  const messageIds = listRes.data.messages ?? [];
  if (messageIds.length === 0) {
    return [];
  }

  logger.info({ staffId, count: messageIds.length }, "gmail.fetchMessages: fetching full messages");

  const results = await Promise.all(
    messageIds.map(async (ref) => {
      try {
        const msgRes = await gmail.users.messages.get({
          userId: "me",
          id: ref.id!,
          format: "full",
        });

        const msg = msgRes.data;
        const payload = msg.payload ?? {};
        const headers = payload.headers ?? [];
        const labelIds = (msg.labelIds ?? []) as string[];

        const bodyText = extractBodyText(payload as GmailMessagePart);

        const direction: "sent" | "received" | "other" = labelIds.includes("SENT")
          ? "sent"
          : labelIds.includes("INBOX")
            ? "received"
            : "other";

        return {
          id: msg.id ?? "",
          threadId: msg.threadId ?? "",
          from: headerValue(headers, "from"),
          to: headerValue(headers, "to"),
          subject: headerValue(headers, "subject"),
          date: headerValue(headers, "date"),
          snippet: msg.snippet ?? "",
          bodyText,
          internalDate: Number(msg.internalDate ?? 0),
          labelIds,
          direction,
        } satisfies ParsedEmail;
      } catch (err) {
        logger.warn({ err, messageId: ref.id, staffId }, "gmail.fetchMessages: failed to parse message, skipping");
        return null;
      }
    }),
  );

  return results.filter((r): r is ParsedEmail => r !== null);
}
