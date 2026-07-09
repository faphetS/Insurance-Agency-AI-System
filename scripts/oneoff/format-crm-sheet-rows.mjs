// One-time CRM sheet row-formatting fix for the v4.1 tab routing change.
//
// DO NOT RUN until the owner explicitly fires. Runs on the VPS (has the .env + pg).
// Purpose: wipe stale test rows and (re)apply the 13pt/not-bold/white data-row
// format on all 3 tabs, so values.append no longer inherits the header's styling.
//
//   node scripts/oneoff/format-crm-sheet-rows.mjs
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

async function getSheetIds(sheets) {
  const res = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
    fields: "sheets.properties(sheetId,title)",
  });

  const byTitle = new Map();
  for (const s of res.data.sheets ?? []) {
    const title = (s.properties?.title ?? "").trim();
    if (title && s.properties?.sheetId !== undefined) {
      byTitle.set(title, s.properties.sheetId);
    }
  }
  return byTitle;
}

async function main() {
  const refreshToken = await getRefreshToken();
  const auth = buildOAuthClient(refreshToken);
  const sheets = google.sheets({ version: "v4", auth });

  const sheetIdsByTitle = await getSheetIds(sheets);

  for (const tab of TABS) {
    const sheetId = sheetIdsByTitle.get(tab.trim());
    if (sheetId === undefined) {
      // eslint-disable-next-line no-console
      console.error(`skipping "${tab}" — sheetId not found`);
      continue;
    }

    // 1. Wipe stale test data rows (owner-approved).
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SPREADSHEET_ID,
      range: `${tab}!A2:Z10000`,
    });

    // 2. Apply the data-row format so future hand-entered rows inherit cleanly too.
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [
          {
            repeatCell: {
              range: {
                sheetId,
                startRowIndex: 1,
                endRowIndex: 1000,
                startColumnIndex: 0,
                endColumnIndex: 7,
              },
              cell: {
                userEnteredFormat: {
                  backgroundColor: { red: 1, green: 1, blue: 1 },
                  textFormat: { fontSize: 13, bold: false },
                },
              },
              fields: "userEnteredFormat(backgroundColor,textFormat.fontSize,textFormat.bold)",
            },
          },
        ],
      },
    });

    // eslint-disable-next-line no-console
    console.log(`formatted tab: "${tab}" (sheetId ${sheetId})`);
  }

  // eslint-disable-next-line no-console
  console.log("done — 3 tabs cleared + reformatted");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
