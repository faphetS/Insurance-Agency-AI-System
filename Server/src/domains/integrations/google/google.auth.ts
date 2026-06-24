import { google } from "googleapis";
import { supabaseAdmin } from "../../../config/supabase.js";
import { env } from "../../../config/env.js";
import { logger } from "../../../config/logger.js";
import { AppError } from "../../../lib/errors.js";

const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
];

function createOAuth2Client() {
  if (!env.GOOGLE_WS_CLIENT_ID || !env.GOOGLE_WS_CLIENT_SECRET) {
    throw new AppError(503, "Google Workspace OAuth credentials are not configured.", "GOOGLE_WS_NOT_CONFIGURED");
  }

  return new google.auth.OAuth2(
    env.GOOGLE_WS_CLIENT_ID,
    env.GOOGLE_WS_CLIENT_SECRET,
    `${env.BACKEND_URL}/api/integrations/google/callback`,
  );
}

export function getAuthUrl(): string {
  const client = createOAuth2Client();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });
}

export async function handleCallback(code: string): Promise<void> {
  const client = createOAuth2Client();
  const { tokens } = await client.getToken(code);

  if (!tokens.refresh_token) {
    throw new AppError(400, "No refresh token received. Try revoking access and re-authorizing.", "NO_REFRESH_TOKEN");
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabaseAdmin as any)
    .from("system_settings")
    .upsert(
      { key: "google_ws_refresh_token", value: tokens.refresh_token, updated_at: new Date().toISOString() },
      { onConflict: "key" },
    );

  if (error) {
    logger.error({ error }, "google-ws: failed to store refresh token");
    throw new AppError(500, "Failed to store refresh token", "TOKEN_STORE_FAILED");
  }

  logger.info("google-ws: OAuth refresh token stored successfully");
}

export async function getAuthenticatedClient() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin as any)
    .from("system_settings")
    .select("value")
    .eq("key", "google_ws_refresh_token")
    .single();

  if (error || !data?.value) {
    throw new AppError(401, "Google Workspace not authorized. Visit /api/integrations/google/authorize first.", "GOOGLE_WS_NOT_AUTHORIZED");
  }

  const client = createOAuth2Client();
  client.setCredentials({ refresh_token: data.value });
  return client;
}

export async function getStatus(): Promise<{ connected: boolean }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (supabaseAdmin as any)
    .from("system_settings")
    .select("value")
    .eq("key", "google_ws_refresh_token")
    .maybeSingle();

  return { connected: Boolean(data?.value) };
}
