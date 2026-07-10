// Residual race: a human editing rows between the batchGet scan and the deleteDimension
// call could shift row indices — the window is a few seconds every 5 minutes on a small
// CRM sheet, accepted as-is. Mirror-vs-sweep races (this process's own writers) are
// eliminated by withSheetLock, which this module's two entry points always acquire.
import { google } from "googleapis";
import { env } from "../../../config/env.js";
import { logger } from "../../../config/logger.js";
import { getAuthenticatedClient } from "./google.auth.js";
import {
  resolveLeadsTabTitle,
  resolveLeadsSheetId,
  appendLeadRow,
  quoteA1Title,
  relevanceValidationRule,
} from "./google.sheets.js";
import { withSheetLock } from "./sheets-lock.js";

interface RelevanceTab {
  trimmed: string;
  exactTitle: string;
  sheetId: number;
}

export interface RelevanceSweepResult {
  scanned: number;
  moved: number;
  ignoredEmpty: number;
  ignoredInvalid: number;
  errors: number;
}

interface QueuedMove {
  dest: RelevanceTab;
  rowIndex0: number;
  values: string[];
}

function zeroResult(): RelevanceSweepResult {
  return { scanned: 0, moved: 0, ignoredEmpty: 0, ignoredInvalid: 0, errors: 0 };
}

// Fixed order: NEW, EXISTING, IRRELEVANT — unresolvable tabs are skipped (warn), not fatal.
async function getRelevanceTabs(): Promise<RelevanceTab[]> {
  const names = [env.LEADS_SHEET_TAB_NEW, env.LEADS_SHEET_TAB_EXISTING, env.LEADS_SHEET_TAB_IRRELEVANT];
  const tabs: RelevanceTab[] = [];

  for (const name of names) {
    const trimmed = name.trim();
    const exactTitle = await resolveLeadsTabTitle(trimmed);
    if (!exactTitle) {
      logger.warn({ name: trimmed }, "leads-relevance: tab title unresolved — skipping");
      continue;
    }

    const sheetId = await resolveLeadsSheetId(exactTitle);
    if (sheetId === null) {
      logger.warn({ name: trimmed, exactTitle }, "leads-relevance: sheetId unresolved — skipping");
      continue;
    }

    tabs.push({ trimmed, exactTitle, sheetId });
  }

  return tabs;
}

export async function applyRelevanceDropdowns(): Promise<{ tabsApplied: number }> {
  if (!env.LEADS_MIRROR_ENABLED) {
    return { tabsApplied: 0 };
  }

  try {
    let client;
    try {
      client = await getAuthenticatedClient();
    } catch (err) {
      logger.warn({ err }, "leads-relevance: not connected — skipping dropdown apply");
      return { tabsApplied: 0 };
    }

    const tabs = await getRelevanceTabs();
    if (tabs.length === 0) {
      return { tabsApplied: 0 };
    }

    const sheets = google.sheets({ version: "v4", auth: client });
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: env.LEADS_SPREADSHEET_ID,
      requestBody: {
        requests: tabs.map((tab) => ({
          setDataValidation: {
            range: {
              sheetId: tab.sheetId,
              startRowIndex: 1,
              startColumnIndex: 5,
              endColumnIndex: 6,
            },
            rule: relevanceValidationRule(),
          },
        })),
      },
    });

    logger.info({ tabsApplied: tabs.length }, "leads-relevance: dropdowns applied");
    return { tabsApplied: tabs.length };
  } catch (err) {
    logger.error({ err }, "leads-relevance: applyRelevanceDropdowns failed");
    return { tabsApplied: 0 };
  }
}

let sweepRunning = false;

export async function sweepRelevanceMoves(): Promise<RelevanceSweepResult> {
  if (sweepRunning) {
    logger.warn("leads-relevance: sweep already in progress — skipping re-entrant call");
    return zeroResult();
  }
  sweepRunning = true;

  try {
    if (!env.LEADS_MIRROR_ENABLED) {
      return zeroResult();
    }

    try {
      return await withSheetLock(() => runSweep());
    } catch (err) {
      logger.error({ err }, "leads-relevance: sweep failed");
      return { ...zeroResult(), errors: 1 };
    }
  } finally {
    sweepRunning = false;
  }
}

async function runSweep(): Promise<RelevanceSweepResult> {
  const tabs = await getRelevanceTabs();
  if (tabs.length < 2) {
    logger.warn({ resolved: tabs.length }, "leads-relevance: fewer than 2 tabs resolved — skipping sweep");
    return zeroResult();
  }

  let client;
  try {
    client = await getAuthenticatedClient();
  } catch (err) {
    logger.warn({ err }, "leads-relevance: not connected — skipping sweep");
    return zeroResult();
  }

  const sheets = google.sheets({ version: "v4", auth: client });

  let valueRanges: Array<{ values?: string[][] | null }>;
  try {
    const batchRes = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: env.LEADS_SPREADSHEET_ID,
      ranges: tabs.map((tab) => `${quoteA1Title(tab.exactTitle)}!A2:G`),
    });
    valueRanges = (batchRes.data.valueRanges ?? []) as Array<{ values?: string[][] | null }>;
  } catch (err) {
    logger.error({ err }, "leads-relevance: batchGet failed");
    return { ...zeroResult(), errors: 1 };
  }

  let scanned = 0;
  let ignoredEmpty = 0;
  let ignoredInvalid = 0;
  let errors = 0;
  const movesBySourceIndex = new Map<number, QueuedMove[]>();

  for (let t = 0; t < tabs.length; t++) {
    const rows = valueRanges[t]?.values ?? [];

    for (let i = 0; i < rows.length; i++) {
      scanned++;
      const row = rows[i] ?? [];
      const f = String(row[5] ?? "").trim();

      if (f === "") {
        ignoredEmpty++;
        continue;
      }

      const dest = tabs.find((tab) => tab.trimmed === f);
      if (!dest) {
        ignoredInvalid++;
        continue;
      }

      if (dest.sheetId === tabs[t]!.sheetId) {
        continue;
      }

      const phone = String(row[0] ?? "").trim();
      const name = String(row[1] ?? "").trim();
      if (!phone && !name) {
        ignoredInvalid++;
        continue;
      }

      const values = Array.from({ length: 7 }, (_, c) => String(row[c] ?? ""));
      const queue = movesBySourceIndex.get(t) ?? [];
      queue.push({ dest, rowIndex0: i + 1, values });
      movesBySourceIndex.set(t, queue);
    }
  }

  let moved = 0;

  for (let t = 0; t < tabs.length; t++) {
    const queuedMoves = movesBySourceIndex.get(t);
    if (!queuedMoves || queuedMoves.length === 0) continue;

    try {
      const appended: QueuedMove[] = [];
      for (const move of queuedMoves) {
        const ok = await appendLeadRow(move.values, move.dest.exactTitle);
        if (ok) {
          appended.push(move);
        } else {
          errors++;
        }
      }

      if (appended.length > 0) {
        const sortedDescending = [...appended].sort((a, b) => b.rowIndex0 - a.rowIndex0);
        try {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: env.LEADS_SPREADSHEET_ID,
            requestBody: {
              requests: sortedDescending.map((move) => ({
                deleteDimension: {
                  range: {
                    sheetId: tabs[t]!.sheetId,
                    dimension: "ROWS",
                    startIndex: move.rowIndex0,
                    endIndex: move.rowIndex0 + 1,
                  },
                },
              })),
            },
          });
          moved += appended.length;
        } catch (err) {
          errors++;
          logger.error(
            { err, tab: tabs[t]!.exactTitle },
            "leads-relevance: source rows not deleted; will re-append duplicates next tick — manual cleanup may be needed",
          );
        }
      }
    } catch (err) {
      errors++;
      logger.error({ err, tab: tabs[t]!.exactTitle }, "leads-relevance: sweep failed for source tab");
    }
  }

  const result: RelevanceSweepResult = { scanned, moved, ignoredEmpty, ignoredInvalid, errors };

  if (result.moved > 0 || result.errors > 0) {
    logger.info(result, "leads-relevance: sweep done");
  } else {
    logger.debug(result, "leads-relevance: sweep done");
  }

  return result;
}
