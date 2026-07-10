import { google } from "googleapis";
import { supabaseAdmin } from "../../../config/supabase.js";
import { env } from "../../../config/env.js";
import { logger } from "../../../config/logger.js";
import { AppError } from "../../../lib/errors.js";
import { getAuthenticatedClient } from "./google.auth.js";
import { withSheetLock } from "./sheets-lock.js";

// 1–26 only (A–Z); throws immediately rather than producing a silent bad range.
function colLetter(n: number): string {
  if (n < 1 || n > 26) {
    throw new AppError(500, `colLetter: n=${n} out of range 1–26`, "SHEETS_COL_OVERFLOW");
  }
  return String.fromCharCode(64 + n);
}

// A1 notation requires single-quoting any sheet title with spaces/special chars —
// 2 of the 3 live tab titles carry a trailing space, so this is mandatory, not cosmetic.
export function quoteA1Title(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

export async function resolveLeadsTabTitle(tabTitle?: string): Promise<string | null> {
  const requestedTab = (tabTitle ?? env.LEADS_SHEET_TAB).trim();
  const cacheKey = `leads_sheet_tab_resolved:${requestedTab}`;

  const { data: cached } = await supabaseAdmin
    .from("system_settings")
    .select("value")
    .eq("key", cacheKey)
    .maybeSingle();

  if (cached?.value) {
    return cached.value as string;
  }

  let client;
  try {
    client = await getAuthenticatedClient();
  } catch (err) {
    logger.warn({ err }, "google.sheets: not connected — cannot resolve tab title");
    return null;
  }

  try {
    const sheets = google.sheets({ version: "v4", auth: client });
    const res = await sheets.spreadsheets.get({
      spreadsheetId: env.LEADS_SPREADSHEET_ID,
      fields: "sheets.properties.title",
    });

    const match = (res.data.sheets ?? []).find(
      (s) => (s.properties?.title ?? "").trim() === requestedTab,
    );

    if (!match?.properties?.title) {
      logger.warn(
        { tabTitle: requestedTab, available: (res.data.sheets ?? []).map((s) => s.properties?.title) },
        "google.sheets: tab not found in spreadsheet",
      );
      return null;
    }

    const exact = match.properties.title;

    await supabaseAdmin
      .from("system_settings")
      .upsert({ key: cacheKey, value: exact }, { onConflict: "key" });

    return exact;
  } catch (err) {
    logger.error({ err }, "google.sheets: resolveLeadsTabTitle failed");
    return null;
  }
}

export async function resolveLeadsSheetId(exactTitle: string): Promise<number | null> {
  const cacheKey = `leads_sheet_gid:${exactTitle}`;

  const { data: cached } = await supabaseAdmin
    .from("system_settings")
    .select("value")
    .eq("key", cacheKey)
    .maybeSingle();

  if (cached?.value) {
    const parsed = Number(cached.value as string);
    if (!Number.isNaN(parsed)) return parsed;
  }

  let client;
  try {
    client = await getAuthenticatedClient();
  } catch (err) {
    logger.warn({ err }, "google.sheets: not connected — cannot resolve sheet id");
    return null;
  }

  try {
    const sheets = google.sheets({ version: "v4", auth: client });
    const res = await sheets.spreadsheets.get({
      spreadsheetId: env.LEADS_SPREADSHEET_ID,
      fields: "sheets.properties(sheetId,title)",
    });

    const match = (res.data.sheets ?? []).find(
      (s) => (s.properties?.title ?? "").trim() === exactTitle.trim(),
    );

    const sheetId = match?.properties?.sheetId;
    if (sheetId === undefined || sheetId === null) {
      logger.warn({ exactTitle }, "google.sheets: sheetId not found for tab");
      return null;
    }

    await supabaseAdmin
      .from("system_settings")
      .upsert({ key: cacheKey, value: String(sheetId) }, { onConflict: "key" });

    return sheetId;
  } catch (err) {
    logger.error({ err }, "google.sheets: resolveLeadsSheetId failed");
    return null;
  }
}

// Data rows (as opposed to the header) must be 13pt / not bold / white — Sheets
// otherwise has values.append inherit whatever formatting sits on the row above.
async function formatDataRow(
  sheets: ReturnType<typeof google.sheets>,
  sheetId: number,
  rowIndex1Based: number,
): Promise<void> {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: env.LEADS_SPREADSHEET_ID,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: {
              sheetId,
              startRowIndex: rowIndex1Based - 1,
              endRowIndex: rowIndex1Based,
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
}

function parseAppendedRowIndex(updatedRange: string | null | undefined): number | null {
  if (!updatedRange) return null;
  const match = /!A(\d+)(?::|$)/.exec(updatedRange);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isNaN(n) ? null : n;
}

// Best-effort — a formatting failure must never fail the append it decorates.
async function formatAppendedRowBestEffort(
  sheets: ReturnType<typeof google.sheets>,
  exactTitle: string,
  updatedRange: string | null | undefined,
): Promise<void> {
  try {
    const rowIndex = parseAppendedRowIndex(updatedRange);
    if (rowIndex === null) {
      logger.warn({ updatedRange }, "google.sheets: could not parse appended row index — skipping format");
      return;
    }

    const sheetId = await resolveLeadsSheetId(exactTitle);
    if (sheetId === null) return;

    await formatDataRow(sheets, sheetId, rowIndex);
  } catch (err) {
    logger.warn({ err }, "google.sheets: row formatting failed");
  }
}

export async function appendLeadRow(values: string[], tabTitle?: string): Promise<boolean> {
  const title = await resolveLeadsTabTitle(tabTitle);
  if (!title) {
    logger.warn("google.sheets: appendLeadRow — no resolved tab title");
    return false;
  }

  let client;
  try {
    client = await getAuthenticatedClient();
  } catch (err) {
    logger.warn({ err }, "google.sheets: not connected — cannot append row");
    return false;
  }

  try {
    const sheets = google.sheets({ version: "v4", auth: client });
    const res = await sheets.spreadsheets.values.append({
      spreadsheetId: env.LEADS_SPREADSHEET_ID,
      range: `${title}!A:H`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [values] },
    });
    await formatAppendedRowBestEffort(sheets, title, res.data?.updates?.updatedRange);
    return true;
  } catch (err) {
    logger.error({ err }, "google.sheets: appendLeadRow failed");
    return false;
  }
}

// Dedupe the candidate tab names by trimmed value, keeping the FIRST occurrence — target
// first means the target tab is the deterministic winner if a phone somehow exists in two.
function dedupeCandidateNames(names: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const trimmed = raw.trim();
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

function findPhoneRow(
  valueRanges: Array<{ values?: string[][] | null }>,
  titles: string[],
  phone: string,
): { title: string; row: number } | null {
  for (let t = 0; t < titles.length; t++) {
    const cells = valueRanges[t]?.values ?? [];
    for (let i = 0; i < cells.length; i++) {
      const cellNorm = String(cells[i]?.[0] ?? "").replace(/\D/g, "");
      if (cellNorm && cellNorm === phone) {
        return { title: titles[t]!, row: i + 1 };
      }
    }
  }
  return null;
}

export function upsertLeadRow(
  values: string[],
  tabTitle?: string,
  opts?: { setOnceColumns?: number[] },
): Promise<boolean> {
  return withSheetLock(() => upsertLeadRowLocked(values, tabTitle, opts));
}

async function upsertLeadRowLocked(
  values: string[],
  tabTitle?: string,
  opts?: { setOnceColumns?: number[] },
): Promise<boolean> {
  const phone = String(values[0] ?? "").replace(/\D/g, "");

  const candidateNames = dedupeCandidateNames([
    tabTitle ?? env.LEADS_SHEET_TAB,
    env.LEADS_SHEET_TAB_NEW,
    env.LEADS_SHEET_TAB_EXISTING,
    env.LEADS_SHEET_TAB_IRRELEVANT,
  ]);

  const resolvedTitles: string[] = [];
  const unresolved: string[] = [];
  for (const name of candidateNames) {
    const resolved = await resolveLeadsTabTitle(name);
    if (resolved) {
      resolvedTitles.push(resolved);
    } else {
      unresolved.push(name);
    }
  }

  if (unresolved.length > 0) {
    logger.warn({ unresolved }, "google.sheets: upsertLeadRow — some candidate tabs unresolved");
  }

  if (resolvedTitles.length === 0) {
    logger.warn("google.sheets: upsertLeadRow — no resolved tab title");
    return false;
  }

  const targetTitle = resolvedTitles[0]!;

  let client;
  try {
    client = await getAuthenticatedClient();
  } catch (err) {
    logger.warn({ err }, "google.sheets: not connected — cannot upsert row");
    return false;
  }

  try {
    const sheets = google.sheets({ version: "v4", auth: client });

    const batchRes = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: env.LEADS_SPREADSHEET_ID,
      ranges: resolvedTitles.map((t) => `${quoteA1Title(t)}!A:A`),
    });

    const valueRanges = (batchRes.data.valueRanges ?? []) as Array<{ values?: string[][] | null }>;
    const match = findPhoneRow(valueRanges, resolvedTitles, phone);

    const endCol = colLetter(values.length);

    if (match !== null) {
      const outValues = [...values];

      // Preserve set-once columns (e.g. creation date, relevance) that already hold a value.
      const setOnce = opts?.setOnceColumns;
      if (setOnce && setOnce.length > 0) {
        const existingRes = await sheets.spreadsheets.values.get({
          spreadsheetId: env.LEADS_SPREADSHEET_ID,
          range: `${quoteA1Title(match.title)}!A${match.row}:${endCol}${match.row}`,
        });
        const existing = ((existingRes.data.values as string[][] | null | undefined) ?? [])[0] ?? [];
        for (const idx of setOnce) {
          const prev = existing[idx];
          if (typeof prev === "string" && prev.trim() !== "") {
            outValues[idx] = prev;
          }
        }
      }

      await sheets.spreadsheets.values.update({
        spreadsheetId: env.LEADS_SPREADSHEET_ID,
        range: `${quoteA1Title(match.title)}!A${match.row}:${endCol}${match.row}`,
        valueInputOption: "RAW",
        requestBody: { values: [outValues] },
      });
    } else {
      const res = await sheets.spreadsheets.values.append({
        spreadsheetId: env.LEADS_SPREADSHEET_ID,
        range: `${targetTitle}!A:${endCol}`,
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: [values] },
      });
      await formatAppendedRowBestEffort(sheets, targetTitle, res.data?.updates?.updatedRange);
    }

    return true;
  } catch (err) {
    logger.error({ err }, "google.sheets: upsertLeadRow failed");
    return false;
  }
}
