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

// Column A may hold a lead's phone as 972…, +972-…, or a hand-typed 05x/02-…; compare
// all of them in one canonical form so a returning lead never spawns a duplicate row.
// Typed without separators into a default-format cell, 0541234567 is stored as a number
// and reads back with its leading 0 gone (541234567), so that form is mapped the same way.
export function canonicalPhone(raw: string | null | undefined): string {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (/^0\d{8,9}$/.test(digits)) return `972${digits.slice(1)}`;
  if (/^[1-9]\d{7,8}$/.test(digits)) return `972${digits}`;
  return digits;
}

// Creation dates are written to col G as DD/MM/YYYY HH:mm (Asia/Jerusalem). Both sides
// are compared as YYYYMMDDHHmm keys in that same local frame — no timezone arithmetic.
function creationKey(g: string | undefined): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/.exec((g ?? "").trim());
  return m ? `${m[3]}${m[2]}${m[1]}${m[4]}${m[5]}` : null;
}

export function israelKey(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}${get("month")}${get("day")}${get("hour")}${get("minute")}`;
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

// F-column relevance dropdown rule — must stay identical to the tab-wide rule applied by
// applyRelevanceDropdowns; appended rows inherit properties from the row above (a fresh
// tab's first row inherits from the HEADER, i.e. nothing), so each appended row gets the
// rule stamped in the same batchUpdate as its format repaint.
export function relevanceValidationRule() {
  const names = [env.LEADS_SHEET_TAB_NEW, env.LEADS_SHEET_TAB_EXISTING, env.LEADS_SHEET_TAB_IRRELEVANT];
  return {
    condition: { type: "ONE_OF_LIST", values: names.map((n) => ({ userEnteredValue: n.trim() })) },
    strict: true,
    showCustomUi: true,
  };
}

// Column D holds one Drive link per line; without WRAP the row shows only the first.
function wrapColumnDRequest(sheetId: number, rowIndex1Based: number) {
  return {
    repeatCell: {
      range: {
        sheetId,
        startRowIndex: rowIndex1Based - 1,
        endRowIndex: rowIndex1Based,
        startColumnIndex: 3,
        endColumnIndex: 4,
      },
      cell: { userEnteredFormat: { wrapStrategy: "WRAP" } },
      fields: "userEnteredFormat.wrapStrategy",
    },
  };
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
        {
          setDataValidation: {
            range: {
              sheetId,
              startRowIndex: rowIndex1Based - 1,
              endRowIndex: rowIndex1Based,
              startColumnIndex: 5,
              endColumnIndex: 6,
            },
            rule: relevanceValidationRule(),
          },
        },
        wrapColumnDRequest(sheetId, rowIndex1Based),
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
    // A tab deleted and recreated under the same title gets a new sheetId: the title-based
    // writes keep succeeding, so these gid-based calls are the only ones that see the stale gid.
    if (isRangeError(err)) await invalidateLeadsSheetCache();
    logger.warn({ err }, "google.sheets: row formatting failed");
  }
}

// Updated rows never pass through formatDataRow, so D is wrapped here once it holds several
// links. Best-effort — a formatting failure must never fail the update it decorates.
async function wrapColumnDBestEffort(
  sheets: ReturnType<typeof google.sheets>,
  exactTitle: string,
  rowIndex1Based: number,
): Promise<void> {
  try {
    const sheetId = await resolveLeadsSheetId(exactTitle);
    if (sheetId === null) return;
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: env.LEADS_SPREADSHEET_ID,
      requestBody: { requests: [wrapColumnDRequest(sheetId, rowIndex1Based)] },
    });
  } catch (err) {
    if (isRangeError(err)) await invalidateLeadsSheetCache();
    logger.warn({ err }, "google.sheets: column D wrap failed");
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
    logger.error({ err: sheetsErrorSummary(err) }, "google.sheets: appendLeadRow failed");
    return false;
  }
}

// Dedupe the candidate tab names by trimmed value, keeping the FIRST occurrence — target
// first means the target tab wins when a phone's newest rows tie on creation date.
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

interface PhoneRowMatch {
  title: string;
  row: number;
  creation: string | null;
}

function findPhoneRows(
  valueRanges: Array<{ values?: string[][] | null }>,
  titles: string[],
  phone: string,
): PhoneRowMatch[] {
  const target = canonicalPhone(phone);
  const out: PhoneRowMatch[] = [];
  if (!target) return out;
  for (let t = 0; t < titles.length; t++) {
    const rows = valueRanges[t]?.values ?? [];
    for (let i = 0; i < rows.length; i++) {
      if (canonicalPhone(rows[i]?.[0]) === target) {
        out.push({ title: titles[t]!, row: i + 1, creation: creationKey(rows[i]?.[6]) });
      }
    }
  }
  return out;
}

// The lead's newest row by creation date; rows without a parsable date sort oldest and
// search order (target tab first) breaks exact ties.
function pickNewest(matches: PhoneRowMatch[]): PhoneRowMatch | null {
  let best: PhoneRowMatch | null = null;
  for (const m of matches) {
    if (!best || (m.creation ?? "") > (best.creation ?? "")) best = m;
  }
  return best;
}

export function isRangeError(err: unknown): boolean {
  const e = err as { code?: number | string; response?: { status?: number } } | null;
  const status = Number(e?.response?.status ?? e?.code);
  return status === 400 || status === 404;
}

// A GaxiosError carries its request — config.data, config.body and response.config hold
// the row (name, ID number, Drive links) — and pino's err serializer copies all of it.
function sheetsErrorSummary(err: unknown): { status: number | string | undefined; message: string | undefined } {
  const e = err as { message?: string; code?: number | string; response?: { status?: number } } | null;
  return { status: e?.response?.status ?? e?.code, message: e?.message };
}

// A renamed or recreated tab makes every cached title/gid stale at once; drop them all
// and let the next resolution rebuild from the live spreadsheet.
export async function invalidateLeadsSheetCache(): Promise<void> {
  await supabaseAdmin.from("system_settings").delete().like("key", "leads_sheet_%");
}

export interface UpsertLeadRowOptions {
  setOnceColumns?: number[];
  // Start of the lead's current inquiry: the phone's newest row is updated only if it
  // was created at/after this instant (1 min slack); an older row means a NEW inquiry
  // and a fresh row is appended instead.
  startedAt?: Date;
}

export function upsertLeadRow(
  values: string[],
  tabTitle?: string,
  opts?: UpsertLeadRowOptions,
): Promise<boolean> {
  return withSheetLock(() => upsertLeadRowLocked(values, tabTitle, opts, 0));
}

async function upsertLeadRowLocked(
  values: string[],
  tabTitle: string | undefined,
  opts: UpsertLeadRowOptions | undefined,
  attempt: number,
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
      ranges: resolvedTitles.map((t) => `${quoteA1Title(t)}!A:G`),
    });

    const valueRanges = (batchRes.data.valueRanges ?? []) as Array<{ values?: string[][] | null }>;
    const newest = pickNewest(findPhoneRows(valueRanges, resolvedTitles, phone));
    const startedKey = opts?.startedAt ? israelKey(new Date(opts.startedAt.getTime() - 60_000)) : null;
    const match = newest && !(startedKey && (newest.creation ?? "") < startedKey) ? newest : null;

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

      if ((outValues[3] ?? "").includes("\n")) {
        await wrapColumnDBestEffort(sheets, match.title, match.row);
      }
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
    if (attempt === 0 && isRangeError(err)) {
      logger.warn(
        { err: sheetsErrorSummary(err) },
        "google.sheets: upsertLeadRow got 400/404 — refreshing the tab cache and retrying once",
      );
      await invalidateLeadsSheetCache();
      return upsertLeadRowLocked(values, tabTitle, opts, 1);
    }
    logger.error({ err: sheetsErrorSummary(err) }, "google.sheets: upsertLeadRow failed");
    return false;
  }
}
