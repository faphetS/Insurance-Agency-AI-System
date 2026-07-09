import { google } from "googleapis";
import { supabaseAdmin } from "../../../config/supabase.js";
import { env } from "../../../config/env.js";
import { logger } from "../../../config/logger.js";
import { AppError } from "../../../lib/errors.js";
import { getAuthenticatedClient } from "./google.auth.js";

// 1–26 only (A–Z); throws immediately rather than producing a silent bad range.
function colLetter(n: number): string {
  if (n < 1 || n > 26) {
    throw new AppError(500, `colLetter: n=${n} out of range 1–26`, "SHEETS_COL_OVERFLOW");
  }
  return String.fromCharCode(64 + n);
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
    await sheets.spreadsheets.values.append({
      spreadsheetId: env.LEADS_SPREADSHEET_ID,
      range: `${title}!A:H`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [values] },
    });
    return true;
  } catch (err) {
    logger.error({ err }, "google.sheets: appendLeadRow failed");
    return false;
  }
}

export async function upsertLeadRow(
  values: string[],
  tabTitle?: string,
  opts?: { setOnceColumns?: number[] },
): Promise<boolean> {
  const phone = String(values[0] ?? "").replace(/\D/g, "");

  const title = await resolveLeadsTabTitle(tabTitle);
  if (!title) {
    logger.warn("google.sheets: upsertLeadRow — no resolved tab title");
    return false;
  }

  let client;
  try {
    client = await getAuthenticatedClient();
  } catch (err) {
    logger.warn({ err }, "google.sheets: not connected — cannot upsert row");
    return false;
  }

  try {
    const sheets = google.sheets({ version: "v4", auth: client });

    const readRes = await sheets.spreadsheets.values.get({
      spreadsheetId: env.LEADS_SPREADSHEET_ID,
      range: `${title}!A:A`,
    });

    const cells: string[][] = (readRes.data.values as string[][] | null | undefined) ?? [];

    let foundRow: number | null = null;
    for (let i = 0; i < cells.length; i++) {
      const cellNorm = String(cells[i]?.[0] ?? "").replace(/\D/g, "");
      if (cellNorm && cellNorm === phone) {
        foundRow = i + 1;
        break;
      }
    }

    const endCol = colLetter(values.length);

    if (foundRow !== null) {
      const outValues = [...values];

      // Preserve set-once columns (e.g. creation date) that already hold a value.
      const setOnce = opts?.setOnceColumns;
      if (setOnce && setOnce.length > 0) {
        const existingRes = await sheets.spreadsheets.values.get({
          spreadsheetId: env.LEADS_SPREADSHEET_ID,
          range: `${title}!A${foundRow}:${endCol}${foundRow}`,
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
        range: `${title}!A${foundRow}:${endCol}${foundRow}`,
        valueInputOption: "RAW",
        requestBody: { values: [outValues] },
      });
    } else {
      await sheets.spreadsheets.values.append({
        spreadsheetId: env.LEADS_SPREADSHEET_ID,
        range: `${title}!A:${endCol}`,
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: [values] },
      });
    }

    return true;
  } catch (err) {
    logger.error({ err }, "google.sheets: upsertLeadRow failed");
    return false;
  }
}
