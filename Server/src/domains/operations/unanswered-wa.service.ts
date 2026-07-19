import { pool } from "../../lib/db.js";
import { logger } from "../../config/logger.js";
import { env } from "../../config/env.js";
import { sleep } from "../../lib/sleep.js";
import { supabaseAdmin } from "../../config/supabase.js";
import { israelWallTimeInstant } from "../calendar/reminder.service.js";
import {
  opCreds,
  sendMessageWith,
  sendInteractiveButtonsWith,
} from "../whatsapp/whatsapp.service.js";
import { extractButtonId, toChatId } from "../whatsapp/whatsapp.util.js";
import { notifyOwnerOps } from "./owner-notify.js";
import { needsReplyFromDidi } from "./unanswered-wa.llm.js";

const TZ = "Asia/Jerusalem";

// ---------------------------------------------------------------------------
// Message texts (exact — see plan)
// ---------------------------------------------------------------------------

export const AUTO_REPLY_TEXT =
  "היי זה דידי, אני בפגישה. אם מדובר במשהו שבמשרד יכולים לעזור, מוזמנים להתקשר או לשלוח וואטסאפ למספר 026244791";

export const FOLLOWUP_BODY = "היי זה דידי, הסתדרת אתמול או שצריך את עזרתי?";

export const FOLLOWUP_BUTTONS = [
  { buttonId: "ua_ok", buttonText: "הסתדרתי, תודה" },
  { buttonId: "ua_callback", buttonText: "אשמח שתחזור אליי" },
];

// ---------------------------------------------------------------------------
// Pacing + daily safety caps
// ---------------------------------------------------------------------------

const SEND_GAP_MS = 20_000;
const DAILY_AUTO_REPLY_CAP = 20;
const DAILY_FOLLOWUP_CAP = 40;

// ---------------------------------------------------------------------------
// Israel wall-time helpers (reuse calendar/reminder.service.ts — don't hand-roll)
// ---------------------------------------------------------------------------

function israelMinutesOfDay(d: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  })
    .formatToParts(d)
    .reduce<Record<string, string>>((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});

  // Intl reports midnight as hour "24" under hour12: false — normalize to "00"
  const h = parts["hour"] === "24" ? 0 : Number(parts["hour"]);
  return h * 60 + Number(parts["minute"]);
}

export function isWithinWatchWindow(d: Date): boolean {
  if (env.UNANSWERED_WINDOW_DISABLED) return true;
  const minutes = israelMinutesOfDay(d);
  return minutes >= 7 * 60 && minutes <= 20 * 60;
}

function israelDayStart(d: Date): Date {
  return israelWallTimeInstant(d, 0, 0);
}

// ---------------------------------------------------------------------------
// Exclusions — group chats, self/bot chat ids, staff phones, the owner number
// ---------------------------------------------------------------------------

async function getExcludedChatIds(): Promise<Set<string>> {
  const excluded = new Set<string>();

  const { data: selfRow } = await supabaseAdmin
    .from("system_settings")
    .select("value")
    .eq("key", "commitment_self_chat_id")
    .maybeSingle();
  if (selfRow?.value) excluded.add(selfRow.value as string);

  const { data: botRow } = await supabaseAdmin
    .from("system_settings")
    .select("value")
    .eq("key", "commitment_bot_chat_id")
    .maybeSingle();
  if (botRow?.value) excluded.add(botRow.value as string);

  const { data: staffList } = await supabaseAdmin
    .from("staff")
    .select("phone")
    .not("phone", "is", null);
  for (const s of (staffList ?? []) as { phone: string | null }[]) {
    const chatId = toChatId(s.phone);
    if (chatId) excluded.add(chatId);
  }

  const summaryChatId = toChatId(env.SUMMARY_RECIPIENT_PHONE ?? null);
  if (summaryChatId) excluded.add(summaryChatId);

  return excluded;
}

// ---------------------------------------------------------------------------
// wa_unanswered row helpers
// ---------------------------------------------------------------------------

interface ActiveRow {
  id: string;
  chat_id: string;
  state: "watching" | "awaiting_reply" | "pending_followup";
}

async function getActiveRow(chatId: string): Promise<ActiveRow | null> {
  const res = await pool.query<ActiveRow>(
    `SELECT id, chat_id, state FROM public.wa_unanswered
     WHERE chat_id = $1 AND state IN ('watching','awaiting_reply','pending_followup')
     LIMIT 1`,
    [chatId],
  );
  return res.rows[0] ?? null;
}

async function createWatchingRow(chatId: string, senderName: string | null, firstUnansweredAt: Date): Promise<void> {
  await pool.query(
    `INSERT INTO public.wa_unanswered (chat_id, sender_name, first_unanswered_at, state)
     VALUES ($1, $2, $3, 'watching')
     ON CONFLICT (chat_id) WHERE state IN ('watching','awaiting_reply','pending_followup') DO NOTHING`,
    [chatId, senderName, firstUnansweredAt.toISOString()],
  );
}

// Plain resolve — LLM-close path only. A closer verdict means nothing needed a reply
// in the first place, so it must NOT day-disable the chat's automation.
async function resolveRow(id: string): Promise<void> {
  await pool.query(
    `UPDATE public.wa_unanswered SET state='resolved', resolved_at=now(), updated_at=now() WHERE id=$1`,
    [id],
  );
}

// Resolve + day-disable — any human engagement (Didi replying, the lead replying while
// awaiting/pending, or a button tap) blocks the rest of the Israel day for that chat.
async function resolveRowWithBlock(id: string): Promise<void> {
  await pool.query(
    `UPDATE public.wa_unanswered
     SET state='resolved', resolved_at=now(), updated_at=now(), blocks_rest_of_day=true
     WHERE id=$1`,
    [id],
  );
}

async function resolveActiveRowForChatWithBlock(chatId: string): Promise<void> {
  await pool.query(
    `UPDATE public.wa_unanswered
     SET state='resolved', resolved_at=now(), updated_at=now(), blocks_rest_of_day=true
     WHERE chat_id=$1 AND state IN ('watching','awaiting_reply','pending_followup')`,
    [chatId],
  );
}

async function isChatBlockedToday(chatId: string, dayStart: Date): Promise<boolean> {
  const res = await pool.query(
    `SELECT 1 FROM public.wa_unanswered
     WHERE chat_id=$1 AND blocks_rest_of_day AND resolved_at >= $2
     LIMIT 1`,
    [chatId, dayStart.toISOString()],
  );
  return (res.rowCount ?? 0) > 0;
}

async function markExpired(id: string): Promise<void> {
  await pool.query(`UPDATE public.wa_unanswered SET state='expired', updated_at=now() WHERE id=$1`, [id]);
}

async function countAutoRepliedToday(dayStart: Date): Promise<number> {
  const res = await pool.query<{ c: string | number }>(
    `SELECT count(*)::int AS c FROM public.wa_unanswered
     WHERE auto_replied_at IS NOT NULL AND auto_replied_at >= $1`,
    [dayStart.toISOString()],
  );
  return Number(res.rows[0]?.c ?? 0);
}

async function countFollowupsSentToday(dayStart: Date): Promise<number> {
  const res = await pool.query<{ c: string | number }>(
    `SELECT count(*)::int AS c FROM public.wa_unanswered
     WHERE followup_sent_at IS NOT NULL AND followup_sent_at >= $1`,
    [dayStart.toISOString()],
  );
  return Number(res.rows[0]?.c ?? 0);
}

// ---------------------------------------------------------------------------
// Webhook event handler — OP instance only (see whatsapp.controller.ts wiring)
// ---------------------------------------------------------------------------

interface OpWebhookBody {
  typeWebhook?: string;
  senderData?: { chatId?: string; senderName?: string };
  timestamp?: number; // unix seconds
  messageData?: {
    typeMessage?: string;
    textMessageData?: { textMessage?: string };
    extendedTextMessageData?: { text?: string };
  };
}

// Matches exactly one full emoji (incl. ZWJ sequences, skin tones, flags).
// Constructor form because the "v" flag needs a runtime regex under our TS target.
const SINGLE_EMOJI_RE = new RegExp("^\\p{RGI_Emoji}$", "v");

export async function handleOpInstanceEvent(rawBody: unknown): Promise<void> {
  if (env.UNANSWERED_WA_MODE === "off") return;

  const body = rawBody as OpWebhookBody;
  const typeWebhook = body.typeWebhook;

  // Our own auto-reply/follow-up going out via the API — never act on it.
  if (typeWebhook === "outgoingAPIMessageReceived") return;

  const chatId = body.senderData?.chatId;
  if (!chatId) return;

  const typeMessage = body.messageData?.typeMessage;
  const text =
    body.messageData?.textMessageData?.textMessage ?? body.messageData?.extendedTextMessageData?.text ?? "";
  // A lone typed emoji is a reaction in spirit ("👍" sent as a message) — owner rule.
  const isReaction = typeMessage === "reactionMessage" || SINGLE_EMOJI_RE.test(text.trim());

  // Didi sent anything (text, media, or a reaction) on his own phone — he's handling
  // it himself, so cancel the watch and day-block the chat's automation.
  if (typeWebhook === "outgoingMessageReceived") {
    await resolveActiveRowForChatWithBlock(chatId);
    return;
  }

  if (typeWebhook !== "incomingMessageReceived") return;

  if (chatId.endsWith("@g.us")) return; // group chats never tracked

  const excluded = await getExcludedChatIds();
  if (excluded.has(chatId)) return;

  const active = await getActiveRow(chatId);

  if (!active) {
    if (isReaction) return; // reactions never start tracking
    const messageTs = typeof body.timestamp === "number" ? new Date(body.timestamp * 1000) : new Date();
    if (!isWithinWatchWindow(messageTs)) return;
    if (await isChatBlockedToday(chatId, israelDayStart(new Date()))) return;
    await createWatchingRow(chatId, body.senderData?.senderName ?? null, messageTs);
    logger.debug({ chatId, typeMessage }, "unanswered-wa: watching row created");
    return;
  }

  if (active.state === "watching") {
    // First message already started the clock — nothing else to do.
    return;
  }

  if (active.state === "awaiting_reply") {
    // Anyone replying (any message, including reactions) cancels the pending follow-up
    // and day-blocks the chat.
    await resolveRowWithBlock(active.id);
    return;
  }

  // active.state === "pending_followup"
  const buttonId = extractButtonId(rawBody);
  if (buttonId === "ua_ok") {
    await resolveRowWithBlock(active.id);
    return;
  }
  if (buttonId === "ua_callback") {
    const phone = chatId.replace("@c.us", "");
    const name = body.senderData?.senderName || phone;
    await notifyOwnerOps(`🔔 ${name} (${phone}) ביקש שתחזור אליו — לא ענית להודעה שלו מאתמול.`);
    await resolveRowWithBlock(active.id);
    return;
  }
  // Any other incoming (text, media, reaction) — silently resolve + day-block.
  await resolveRowWithBlock(active.id);
}

// ---------------------------------------------------------------------------
// Sweeper — every 5 minutes: auto-reply to chats silent 1h+
// ---------------------------------------------------------------------------

let sweepRunning = false;

export async function sweepUnanswered(): Promise<{
  processed: number;
  autoReplied: number;
  skipped: number;
  closedByLlm: number;
}> {
  if (sweepRunning) {
    logger.warn("unanswered-wa: sweep already in progress — skipping re-entrant call");
    return { processed: 0, autoReplied: 0, skipped: 0, closedByLlm: 0 };
  }
  sweepRunning = true;

  try {
    if (env.UNANSWERED_WA_MODE === "off") {
      // Expire leftovers so re-enabling later can't fire ancient auto-replies.
      const expiredRes = await pool.query(
        `UPDATE public.wa_unanswered SET state='expired', updated_at=now()
         WHERE state IN ('watching','awaiting_reply','pending_followup')`,
      );
      const expiredCount = expiredRes.rowCount ?? 0;
      if (expiredCount > 0) {
        logger.info({ expiredCount }, `unanswered-wa: mode=off — expired ${expiredCount} active rows`);
      }
      return { processed: 0, autoReplied: 0, skipped: 0, closedByLlm: 0 };
    }

    const creds = opCreds();
    if (!creds) {
      logger.info("unanswered-wa: op creds unset — skipping sweep");
      return { processed: 0, autoReplied: 0, skipped: 0, closedByLlm: 0 };
    }

    const now = new Date();
    const cutoff = new Date(now.getTime() - 60 * 60 * 1000);
    const dayStart = israelDayStart(now);

    // Daily-reset expiry: yesterday's pending follow-ups (button prompt already sent,
    // no reply) expire at the start of today's Israel day. Cheap, runs every sweep.
    await pool.query(
      `UPDATE public.wa_unanswered
       SET state='expired', updated_at=now()
       WHERE state='pending_followup' AND followup_sent_at < $1`,
      [dayStart.toISOString()],
    );

    const res = await pool.query<{ id: string; chat_id: string }>(
      `SELECT id, chat_id FROM public.wa_unanswered
       WHERE state = 'watching' AND first_unanswered_at <= $1`,
      [cutoff.toISOString()],
    );

    let autoReplied = 0;
    let skipped = 0;
    let closedByLlm = 0;
    let sentTodayCount = await countAutoRepliedToday(dayStart);

    for (const row of res.rows) {
      try {
        const needed = await needsReplyFromDidi(row.chat_id);
        if (!needed) {
          await resolveRow(row.id);
          closedByLlm++;
          logger.info(
            { chatId: row.chat_id },
            "unanswered-wa: LLM judged trailing message a closer — resolved without auto-reply",
          );
          continue;
        }

        const already = await pool.query(
          `SELECT 1 FROM public.wa_unanswered
           WHERE chat_id = $1 AND auto_replied_at IS NOT NULL AND auto_replied_at >= $2
           LIMIT 1`,
          [row.chat_id, dayStart.toISOString()],
        );

        if ((already.rowCount ?? 0) > 0) {
          // Already auto-replied today for this chat — resolve + day-block rather than
          // re-sending or leaving tomorrow's 09:00 follow-up eligible.
          await resolveRowWithBlock(row.id);
          skipped++;
          continue;
        }

        if (sentTodayCount >= DAILY_AUTO_REPLY_CAP) {
          logger.warn(
            { chatId: row.chat_id, cap: DAILY_AUTO_REPLY_CAP },
            "unanswered-wa: daily auto-reply cap reached — skipping",
          );
          await markExpired(row.id);
          skipped++;
          continue;
        }

        if (autoReplied > 0) {
          await sleep(SEND_GAP_MS);
        }

        if (env.UNANSWERED_WA_MODE === "send") {
          await sendMessageWith(creds, row.chat_id, AUTO_REPLY_TEXT);
        } else {
          logger.info(
            { chatId: row.chat_id, text: AUTO_REPLY_TEXT },
            "unanswered-wa: [LOG MODE] auto-reply suppressed — would have sent",
          );
        }
        await pool.query(
          `UPDATE public.wa_unanswered
           SET state='awaiting_reply', auto_replied_at=now(), updated_at=now()
           WHERE id=$1`,
          [row.id],
        );
        autoReplied++;
        sentTodayCount++;
      } catch (err) {
        logger.warn({ err, chatId: row.chat_id }, "unanswered-wa: sweep row failed — continuing");
      }
    }

    logger.info(
      { processed: res.rows.length, autoReplied, skipped, closedByLlm },
      "unanswered-wa: sweep complete",
    );
    return { processed: res.rows.length, autoReplied, skipped, closedByLlm };
  } finally {
    sweepRunning = false;
  }
}

// ---------------------------------------------------------------------------
// Follow-up pass — daily (09:00 cron): send buttons + housekeeping
// ---------------------------------------------------------------------------

let followupRunning = false;

export async function sendUnansweredFollowups(): Promise<{ followupsSent: number; expired: number; deleted: number }> {
  if (followupRunning) {
    logger.warn("unanswered-wa: follow-up pass already in progress — skipping re-entrant call");
    return { followupsSent: 0, expired: 0, deleted: 0 };
  }
  followupRunning = true;

  try {
    const creds = opCreds();
    const now = new Date();
    const dayStart = israelDayStart(now);

    let followupsSent = 0;
    let expired = 0;

    if (env.UNANSWERED_WA_MODE === "off") {
      logger.info("unanswered-wa: mode=off — skipping follow-up sends");
    } else if (creds) {
      const res = await pool.query<{ id: string; chat_id: string }>(
        `SELECT id, chat_id FROM public.wa_unanswered
         WHERE state = 'awaiting_reply' AND auto_replied_at IS NOT NULL AND auto_replied_at < $1`,
        [dayStart.toISOString()],
      );

      let sentTodayCount = await countFollowupsSentToday(dayStart);

      for (const row of res.rows) {
        try {
          if (sentTodayCount >= DAILY_FOLLOWUP_CAP) {
            logger.warn(
              { chatId: row.chat_id, cap: DAILY_FOLLOWUP_CAP },
              "unanswered-wa: daily follow-up cap reached — expiring",
            );
            await markExpired(row.id);
            expired++;
            continue;
          }

          if (followupsSent > 0) {
            await sleep(SEND_GAP_MS);
          }

          if (env.UNANSWERED_WA_MODE === "send") {
            await sendInteractiveButtonsWith(creds, row.chat_id, FOLLOWUP_BODY, FOLLOWUP_BUTTONS);
          } else {
            logger.info(
              { chatId: row.chat_id },
              "unanswered-wa: [LOG MODE] follow-up buttons suppressed — would have sent",
            );
          }
          await pool.query(
            `UPDATE public.wa_unanswered
             SET state='pending_followup', followup_sent_at=now(), updated_at=now()
             WHERE id=$1`,
            [row.id],
          );
          followupsSent++;
          sentTodayCount++;
        } catch (err) {
          logger.warn({ err, chatId: row.chat_id }, "unanswered-wa: follow-up send failed — continuing");
        }
      }
    } else {
      logger.info("unanswered-wa: op creds unset — skipping follow-up sends");
    }

    // Housekeeping (runs regardless of creds): delete old resolved/skipped/expired rows.
    // Stale pending_followup rows now expire on the daily-reset in sweepUnanswered().
    const deleteCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const deletedRes = await pool.query(
      `DELETE FROM public.wa_unanswered
       WHERE state IN ('resolved','skipped','expired') AND updated_at <= $1`,
      [deleteCutoff.toISOString()],
    );
    const deleted = deletedRes.rowCount ?? 0;

    logger.info({ followupsSent, expired, deleted }, "unanswered-wa: follow-up pass complete");
    return { followupsSent, expired, deleted };
  } finally {
    followupRunning = false;
  }
}
