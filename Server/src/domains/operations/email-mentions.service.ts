import { pool } from "../../lib/db.js";
import { logger } from "../../config/logger.js";
import { env } from "../../config/env.js";
import { listSentMessageIds, getSentMessage, sendOwnerEmail } from "../integrations/google/google.gmail.js";

const TEMPLATE = /חתימה מרחוק|סיום תהליך/;

interface StaffMatcher {
  id: string;
  name: string;
  email: string;
  localpart: string;
}

interface MentionRow {
  id: string;
  staff_id: string;
  staff_email: string;
  staff_name: string | null;
  subject: string | null;
  sent_at: string;
}

async function loadStaffMatchers(): Promise<StaffMatcher[]> {
  const res = await pool.query<{ id: string; full_name: string; email: string }>(
    `SELECT id, full_name, email FROM staff WHERE is_active = true AND role = 'agent'`,
  );
  return res.rows.map((r) => ({
    id: r.id,
    name: r.full_name,
    email: r.email,
    localpart: r.email.split("@")[0].toLowerCase(),
  }));
}

export interface StaffMatch {
  staff: StaffMatcher;
  detected_via: "to_cc" | "body";
}

export function matchStaffInEmail(
  headers: Record<string, string>,
  bodyText: string,
  staff: StaffMatcher[],
): StaffMatch[] {
  const hdr = ((headers["to"] ?? "") + " " + (headers["cc"] ?? "")).toLowerCase();
  const body = bodyText.toLowerCase();

  const matches: StaffMatch[] = [];
  for (const s of staff) {
    const searchTerm = s.localpart + "@";
    const inHdr = hdr.includes(searchTerm);
    const inBody = !inHdr && body.includes(searchTerm);
    if (inHdr) {
      matches.push({ staff: s, detected_via: "to_cc" });
    } else if (inBody) {
      matches.push({ staff: s, detected_via: "body" });
    }
  }
  return matches;
}

function ownText(body: string): string {
  const cut = body.split(/From:|מאת:|בתאריך|-+ ?Forwarded| On .*wrote:/)[0].trim();
  return cut.length > 0 ? cut : body;
}

export async function scanAndStoreSentMentions(): Promise<{ scanned: number; stored: number }> {
  const ids = await listSentMessageIds("in:sent newer_than:1d");
  const staff = await loadStaffMatchers();

  let scanned = 0;
  let stored = 0;

  for (const id of ids) {
    try {
      const { headers, bodyText, internalDate } = await getSentMessage(id);

      if (TEMPLATE.test(headers["subject"] ?? "")) continue;

      const matches = matchStaffInEmail(headers, bodyText, staff);

      const to = headers["to"] ?? "";
      const cc = headers["cc"] ?? "";
      const recipients = [to, cc].filter(Boolean).join("; ");
      const subject = headers["subject"] ?? null;
      const sentAt = new Date(internalDate);
      const snippet = ownText(bodyText).slice(0, 200);

      for (const { staff: s, detected_via } of matches) {
        const res = await pool.query(
          `INSERT INTO public.email_staff_mentions
             (gmail_message_id, sent_at, subject, recipients, staff_id, staff_email,
              staff_name, detected_via, snippet)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (gmail_message_id, staff_id) WHERE gmail_message_id IS NOT NULL DO NOTHING`,
          [id, sentAt, subject, recipients, s.id, s.email, s.name, detected_via, snippet],
        );
        stored += res.rowCount ?? 0;
      }

      scanned++;
    } catch (err) {
      logger.warn({ err, gmailMessageId: id }, "email-mentions: error processing message — skipping");
    }
  }

  return { scanned, stored };
}

export async function notifyStaffMentions(): Promise<{ notified: number }> {
  const res = await pool.query<MentionRow>(
    `SELECT id, staff_id, staff_email, staff_name, subject, sent_at
     FROM public.email_staff_mentions
     WHERE status = 'pending'
     ORDER BY sent_at`,
  );

  const byStaff = new Map<string, MentionRow[]>();
  for (const row of res.rows) {
    const bucket = byStaff.get(row.staff_id) ?? [];
    bucket.push(row);
    byStaff.set(row.staff_id, bucket);
  }

  let notified = 0;

  for (const [, rows] of byStaff) {
    const first = rows[0];
    const staffName = first.staff_name ?? "";
    const staffEmail = first.staff_email;

    const bullets = rows
      .map((r) => `• "${r.subject ?? "(ללא נושא)"}"`)
      .join("\n");

    const subject = "תזכורת ממשרד שקד";
    const body = `שלום ${staffName},\n\nתזכורת: אתמול דידי שלח/העביר אליך מייל בנושא:\n${bullets}\n\nנא לטפל בהתאם.`;

    if (env.STAFF_EMAIL_NOTIFY_MODE === "send") {
      await sendOwnerEmail(staffEmail, subject, body);
    } else {
      logger.info({ to: staffEmail, subject, body }, "staff-email-notify (DRY RUN — not sent)");
    }

    const ids = rows.map((r) => r.id);
    await pool.query(
      `UPDATE public.email_staff_mentions
       SET status = 'sent', sent_notify_at = now()
       WHERE id = ANY($1)`,
      [ids],
    );

    notified++;
  }

  return { notified };
}

export async function runStaffEmailNotify(): Promise<{ scanned: number; stored: number; notified: number }> {
  const { scanned, stored } = await scanAndStoreSentMentions();
  const { notified } = await notifyStaffMentions();
  logger.info({ scanned, stored, notified }, "email-mentions: daily run complete");
  return { scanned, stored, notified };
}
