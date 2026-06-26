import { google } from "googleapis";
import { supabaseAdmin } from "../../../config/supabase.js";
import { env } from "../../../config/env.js";
import { logger } from "../../../config/logger.js";
import { getAuthenticatedClient } from "./google.auth.js";

const CACHE_KEY = "leads_sheet_tab_resolved";

export async function resolveLeadsTabTitle(): Promise<string | null> {
  const { data: cached } = await supabaseAdmin
    .from("system_settings")
    .select("value")
    .eq("key", CACHE_KEY)
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

    const tabTitle = env.LEADS_SHEET_TAB.trim();
    const match = (res.data.sheets ?? []).find(
      (s) => (s.properties?.title ?? "").trim() === tabTitle,
    );

    if (!match?.properties?.title) {
      logger.warn(
        { tabTitle, available: (res.data.sheets ?? []).map((s) => s.properties?.title) },
        "google.sheets: tab not found in spreadsheet",
      );
      return null;
    }

    const exact = match.properties.title;

    await supabaseAdmin
      .from("system_settings")
      .upsert({ key: CACHE_KEY, value: exact }, { onConflict: "key" });

    return exact;
  } catch (err) {
    logger.error({ err }, "google.sheets: resolveLeadsTabTitle failed");
    return null;
  }
}

export async function appendLeadRow(values: string[]): Promise<boolean> {
  const title = await resolveLeadsTabTitle();
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

export async function upsertLeadRow(values: string[]): Promise<boolean> {
  const phone = String(values[0] ?? "").replace(/\D/g, "");

  const title = await resolveLeadsTabTitle();
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

    if (foundRow !== null) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: env.LEADS_SPREADSHEET_ID,
        range: `${title}!A${foundRow}:H${foundRow}`,
        valueInputOption: "RAW",
        requestBody: { values: [values] },
      });
    } else {
      await sheets.spreadsheets.values.append({
        spreadsheetId: env.LEADS_SPREADSHEET_ID,
        range: `${title}!A:H`,
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
