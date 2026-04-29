import { google } from "googleapis";
import { supabaseAdmin } from "../../config/supabase.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { AppError } from "../../lib/errors.js";

function createOAuth2Client() {
  return new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_REDIRECT_URI,
  );
}

export function getAuthUrl(): string {
  const client = createOAuth2Client();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/calendar.readonly"],
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
      { key: "google_calendar_refresh_token", value: tokens.refresh_token, updated_at: new Date().toISOString() },
      { onConflict: "key" },
    );

  if (error) {
    logger.error({ error }, "calendar: failed to store refresh token");
    throw new AppError(500, "Failed to store refresh token", "TOKEN_STORE_FAILED");
  }

  logger.info("calendar: OAuth refresh token stored successfully");
}

export async function getAuthenticatedClient() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin as any)
    .from("system_settings")
    .select("value")
    .eq("key", "google_calendar_refresh_token")
    .single();

  if (error || !data?.value) {
    throw new AppError(401, "Google Calendar not authorized. Visit /api/calendar/oauth/authorize first.", "GOOGLE_NOT_AUTHORIZED");
  }

  const client = createOAuth2Client();
  client.setCredentials({ refresh_token: data.value });
  return client;
}
