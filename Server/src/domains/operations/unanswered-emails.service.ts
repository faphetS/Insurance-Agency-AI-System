import { pool } from "../../lib/db.js";
import { logger } from "../../config/logger.js";
import { env } from "../../config/env.js";
import {
  listSentMessageIds,
  getProfileAddress,
  getMessageMeta,
  threadRepliedAfter,
  sendOwnerEmail,
} from "../integrations/google/google.gmail.js";

const WATERMARK_KEY = "unanswered_emails_last_run";

const NO_REPLY_RE = /no-?reply|donotreply/i;

async function getWatermark(): Promise<Date | null> {
  const res = await pool.query<{ value: string }>(
    `SELECT value FROM public.system_settings WHERE key = $1`,
    [WATERMARK_KEY],
  );
  const value = res.rows[0]?.value;
  return value ? new Date(value) : null;
}

async function setWatermark(date: Date): Promise<void> {
  await pool.query(
    `INSERT INTO public.system_settings (key, value)
     VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [WATERMARK_KEY, date.toISOString()],
  );
}

// "Name <a@b>" -> Name (quotes stripped); bare "a@b" -> "a@b".
export function senderDisplayName(fromHeader: string): string {
  const match = fromHeader.match(/^(.*)<(.+)>$/);
  if (!match) return fromHeader.trim();

  const name = match[1].trim().replace(/^"(.*)"$/, "$1").trim();
  return name.length > 0 ? name : match[2].trim();
}

export function isEligibleMessage(
  meta: { headers: Record<string, string>; labelIds: string[] },
  ownAddress: string,
): boolean {
  if (!meta.labelIds.includes("CATEGORY_PERSONAL")) return false;

  const from = (meta.headers["from"] ?? "").toLowerCase();
  if (from.includes(ownAddress.toLowerCase())) return false;
  if (NO_REPLY_RE.test(from)) return false;
  if (meta.headers["list-unsubscribe"]) return false;

  return true;
}

function subjectOrPlaceholder(subject: string | null): string {
  return subject && subject.trim().length > 0 ? subject : "(ללא נושא)";
}

export function buildUnansweredEmail(
  rows: { subject: string | null; from: string }[],
): { subject: string; body: string } {
  const bullets = rows
    .map((r) => `• ${subjectOrPlaceholder(r.subject)} — מאת: ${senderDisplayName(r.from)}`)
    .join("\n");

  const body =
    `היי דידי — אלו המיילים מ־24 השעות האחרונות שעדיין לא הגבת עליהם:\n\n` +
    `${bullets}\n\n` +
    `(מייל אוטומטי מהמערכת)`;

  return { subject: "מיילים שלא נענו מאתמול", body };
}

interface Candidate {
  id: string;
  threadId: string;
  internalDate: number;
  subject: string | null;
  from: string;
}

export async function runUnansweredEmailNotify(): Promise<{ scanned: number; flagged: number; sent: number }> {
  const runStart = new Date();
  const sevenDaysAgo = new Date(runStart.getTime() - 7 * 24 * 60 * 60 * 1000);
  const twentyFourHoursAgo = new Date(runStart.getTime() - 24 * 60 * 60 * 1000);

  const watermark = await getWatermark();
  let windowStart = watermark ?? twentyFourHoursAgo;
  if (windowStart.getTime() < sevenDaysAgo.getTime()) windowStart = sevenDaysAgo;
  const windowStartMs = windowStart.getTime();
  const windowEndMs = runStart.getTime();

  const ids = await listSentMessageIds("in:inbox newer_than:7d");
  const ownAddress = await getProfileAddress();

  let scanned = 0;
  const candidates: Candidate[] = [];

  for (const id of ids) {
    try {
      const meta = await getMessageMeta(id);
      scanned++;

      if (meta.internalDate < windowStartMs || meta.internalDate >= windowEndMs) continue;
      if (!isEligibleMessage(meta, ownAddress)) continue;

      candidates.push({
        id,
        threadId: meta.threadId,
        internalDate: meta.internalDate,
        subject: meta.headers["subject"] ?? null,
        from: meta.headers["from"] ?? "",
      });
    } catch (err) {
      logger.warn({ err, gmailMessageId: id }, "unanswered-emails: error processing message — skipping");
    }
  }

  const byThread = new Map<string, Candidate>();
  for (const c of candidates) {
    const existing = byThread.get(c.threadId);
    if (!existing || c.internalDate > existing.internalDate) {
      byThread.set(c.threadId, c);
    }
  }

  const finalRows: Candidate[] = [];
  for (const c of byThread.values()) {
    try {
      const replied = await threadRepliedAfter(c.threadId, c.internalDate, ownAddress);
      if (!replied) finalRows.push(c);
    } catch (err) {
      logger.warn({ err, threadId: c.threadId }, "unanswered-emails: error checking thread reply — skipping");
    }
  }

  if (finalRows.length === 0) {
    await setWatermark(runStart);
    logger.info({ scanned, flagged: 0, sent: 0 }, "unanswered-emails: daily run complete — nothing to flag");
    return { scanned, flagged: 0, sent: 0 };
  }

  finalRows.sort((a, b) => a.internalDate - b.internalDate);

  const { subject, body } = buildUnansweredEmail(
    finalRows.map((r) => ({ subject: r.subject, from: r.from })),
  );

  let sent = 0;
  if (env.STAFF_EMAIL_NOTIFY_MODE === "send") {
    await sendOwnerEmail(ownAddress, subject, body);
    sent = 1;
  } else {
    logger.info({ to: ownAddress, subject, body }, "unanswered-emails notify (DRY RUN — not sent)");
  }

  await setWatermark(runStart);

  logger.info({ scanned, flagged: finalRows.length, sent }, "unanswered-emails: daily run complete");
  return { scanned, flagged: finalRows.length, sent };
}
