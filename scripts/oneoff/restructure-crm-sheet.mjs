// One-time CRM sheet restructure for Conversational Bot v4.
//
// DO NOT RUN until the owner explicitly fires. Runs on the VPS (has the .env + pg).
// Purpose: rename the 7 v4 headers on all 3 tabs and clear existing test rows.
//
//   node scripts/oneoff/restructure-crm-sheet.mjs
//
// Requires (from the app .env / environment):
//   GOOGLE_WS_CLIENT_ID, GOOGLE_WS_CLIENT_SECRET, DATABASE_URL, BACKEND_URL
// The Google Workspace refresh token is read from system_settings.google_ws_refresh_token
// (same source as domains/integrations/google/google.auth.ts).

import { google } from "googleapis";
import pg from "pg";

const SPREADSHEET_ID = "11TwqEQzqh3Yul9dWQfX2s8__yfH0hbcI71f_TF1pAjw";

// NOTE the trailing spaces on two of the tab titles — do NOT "fix" them.
const TABS = ["לידים חדשים ", "לקוח קיים ", "לא רלוונטי"];

const HEADERS = [
  "מספר טלפון",
  "שם מלא",
  "סוג הפנייה",
  "תמונת תעודת זהות",
  "תעודת זהות",
  "רלוונטיות",
  "תאריך יצירה",
];

async function getRefreshToken() {
  const { Pool } = pg;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const { rows } = await pool.query(
      `SELECT value FROM public.system_settings WHERE key = 'google_ws_refresh_token'`,
    );
    const token = rows[0]?.value;
    if (!token) throw new Error("google_ws_refresh_token not found in system_settings");
    return token;
  } finally {
    await pool.end();
  }
}

function buildOAuthClient(refreshToken) {
  if (!process.env.GOOGLE_WS_CLIENT_ID || !process.env.GOOGLE_WS_CLIENT_SECRET) {
    throw new Error("GOOGLE_WS_CLIENT_ID / GOOGLE_WS_CLIENT_SECRET are required");
  }
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_WS_CLIENT_ID,
    process.env.GOOGLE_WS_CLIENT_SECRET,
    `${process.env.BACKEND_URL}/api/integrations/google/callback`,
  );
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}

async function main() {
  const refreshToken = await getRefreshToken();
  const auth = buildOAuthClient(refreshToken);
  const sheets = google.sheets({ version: "v4", auth });

  for (const tab of TABS) {
    // 1. Rewrite the header row (A1:G1).
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${tab}!A1:G1`,
      valueInputOption: "RAW",
      requestBody: { values: [HEADERS] },
    });

    // 2. Drop any stray header cells beyond G.
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SPREADSHEET_ID,
      range: `${tab}!H1:Z1`,
    });

    // 3. Clear existing (test) data rows — owner-approved deletion.
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SPREADSHEET_ID,
      range: `${tab}!A2:Z10000`,
    });

    // eslint-disable-next-line no-console
    console.log(`restructured tab: "${tab}"`);
  }

  // eslint-disable-next-line no-console
  console.log("done — 3 tabs restructured to the v4 7-column layout");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
