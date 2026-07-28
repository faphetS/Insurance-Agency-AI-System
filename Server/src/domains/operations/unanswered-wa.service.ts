import { pool } from "../../lib/db.js";
import { logger } from "../../config/logger.js";
import { env } from "../../config/env.js";
import { sleep } from "../../lib/sleep.js";
import { supabaseAdmin } from "../../config/supabase.js";
import { israelTimeOfDayMs, israelWallTimeInstant } from "../calendar/reminder.service.js";
import { opCreds, sendInteractiveButtonsWith } from "../whatsapp/whatsapp.service.js";
import {
  displayName,
  extractButtonId,
  opExcludedChatIds,
  toChatId,
  toLocalPhone,
} from "../whatsapp/whatsapp.util.js";
import { notifyOwnerOps } from "./owner-notify.js";
import { needsReplyFromDidi } from "./unanswered-wa.llm.js";

const TZ = "Asia/Jerusalem";

// ---------------------------------------------------------------------------
// Message texts (exact — see plan)
// ---------------------------------------------------------------------------

export const AUTO_REPLY_TEXT =
  "היי זה דידי, אני בפגישה. אם מדובר במשהו שבמשרד יכולים לעזור, מוזמנים להתקשר או לשלוח וואטסאפ למספר 026244791";

export const AUTO_REPLY_BUTTONS = [
  { buttonId: "ua_ok", buttonText: "תודה, אדבר עם המשרד" },
  { buttonId: "ua_callback", buttonText: "אשמח שתחזור אליי" },
];

// ---------------------------------------------------------------------------
// Pacing + daily safety caps
// ---------------------------------------------------------------------------

const SEND_GAP_MS = 20_000;
const DAILY_AUTO_REPLY_CAP = 20;

// ---------------------------------------------------------------------------
// Israel wall-time helpers (reuse calendar/reminder.service.ts — don't hand-roll)
// ---------------------------------------------------------------------------

const WATCH_WEEKDAYS = new Set(["Sun", "Mon", "Tue", "Wed", "Thu"]);

function israelWeekday(d: Date): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(d);
}

// Sun–Thu, 09:00–18:00 Israel time (Didi's business hours).
export function isWithinWatchWindow(d: Date): boolean {
  if (env.UNANSWERED_WINDOW_DISABLED) return true;
  const minutes = Math.floor(israelTimeOfDayMs(d) / 60_000);
  return WATCH_WEEKDAYS.has(israelWeekday(d)) && minutes >= 9 * 60 && minutes <= 18 * 60;
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

  for (const chatId of opExcludedChatIds()) excluded.add(chatId);

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

// ua_callback tap — stamp the callback request (picked up by the next business-day 09:00
// owner reminder). No immediate owner notify. Buttons stay tappable in the chat long after
// their row was expired or even deleted, and an explicit callback request must never be
// dropped — so fall back from the active row to the chat's latest auto-replied row, and
// as a last resort record a synthetic resolved row.
async function registerCallbackRequest(chatId: string, senderName: string | null): Promise<void> {
  const active = await pool.query(
    `UPDATE public.wa_unanswered
     SET callback_requested_at=now(), state='resolved', resolved_at=now(), blocks_rest_of_day=true, updated_at=now()
     WHERE chat_id=$1 AND state IN ('watching','awaiting_reply','pending_followup')`,
    [chatId],
  );
  if ((active.rowCount ?? 0) > 0) return;

  const stale = await pool.query(
    `UPDATE public.wa_unanswered SET callback_requested_at=now(), updated_at=now()
     WHERE id = (
       SELECT id FROM public.wa_unanswered
       WHERE chat_id=$1 AND auto_replied_at IS NOT NULL AND callback_requested_at IS NULL
       ORDER BY auto_replied_at DESC LIMIT 1
     )`,
    [chatId],
  );
  if ((stale.rowCount ?? 0) > 0) return;

  await pool.query(
    `INSERT INTO public.wa_unanswered
       (chat_id, sender_name, first_unanswered_at, state, resolved_at, blocks_rest_of_day, callback_requested_at)
     VALUES ($1, $2, now(), 'resolved', now(), true, now())`,
    [chatId, senderName],
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

  // Button taps are handled BEFORE any row-state lookup: the buttons stay tappable in the
  // customer's chat long after their row expired (next-morning reset, weekends), and a
  // stale tap must register the callback — not fall through as a fresh message and trigger
  // a second auto-reply.
  const buttonId = extractButtonId(rawBody);
  if (buttonId === "ua_callback") {
    await registerCallbackRequest(chatId, body.senderData?.senderName ?? null);
    return;
  }
  if (buttonId === "ua_ok") {
    await resolveActiveRowForChatWithBlock(chatId); // stale tap → no active row → no-op
    return;
  }

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
    // Re-anchor the silence timer: the 10-min trigger counts from the customer's LATEST
    // unanswered message, not their first — a mid-burst auto-reply reads as the bot
    // interrupting someone who is still typing. Reactions don't extend the clock.
    if (!isReaction) {
      const messageTs = typeof body.timestamp === "number" ? new Date(body.timestamp * 1000) : new Date();
      await pool.query(
        `UPDATE public.wa_unanswered SET first_unanswered_at=$2, updated_at=now() WHERE id=$1`,
        [active.id, messageTs.toISOString()],
      );
    }
    return;
  }

  // pending_followup: the buttons were already sent, so any non-tap reply (text, media,
  // reaction) means the customer engaged — silently resolve + day-block.
  await resolveRowWithBlock(active.id);
}

// ---------------------------------------------------------------------------
// Sweeper — every 2 minutes: auto-reply (with buttons) to chats silent 10 min+
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

    // Boundary-crossers: a chat that started watching near 18:00 (or before the weekend)
    // must never fire once the window has closed — expire everything still watching
    // and send nothing until the window reopens.
    if (!isWithinWatchWindow(now)) {
      const expiredRes = await pool.query(
        `UPDATE public.wa_unanswered SET state='expired', updated_at=now() WHERE state='watching'`,
      );
      const expiredCount = expiredRes.rowCount ?? 0;
      if (expiredCount > 0) {
        logger.info({ expiredCount }, "unanswered-wa: outside watch window — expired watching rows");
      }
      return { processed: 0, autoReplied: 0, skipped: 0, closedByLlm: 0 };
    }

    const cutoff = new Date(now.getTime() - 10 * 60 * 1000);
    const dayStart = israelDayStart(now);

    // Self-healing double of the 09:00 job's daily reset: node-cron doesn't catch up a
    // tick missed during a restart, and a stale pending_followup row would day-block the
    // chat's next real message instead of tracking it.
    await pool.query(
      `UPDATE public.wa_unanswered SET state='expired', updated_at=now()
       WHERE state='pending_followup' AND auto_replied_at < $1`,
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
        // Cap check first — it's free, and a cap-saturated day must not keep burning a
        // chat-history fetch + Gemini call per due row just to expire it.
        if (sentTodayCount >= DAILY_AUTO_REPLY_CAP) {
          logger.warn(
            { chatId: row.chat_id, cap: DAILY_AUTO_REPLY_CAP },
            "unanswered-wa: daily auto-reply cap reached — skipping",
          );
          await markExpired(row.id);
          skipped++;
          continue;
        }

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
          // re-sending or leaving tomorrow's 09:00 reminder eligible.
          await resolveRowWithBlock(row.id);
          skipped++;
          continue;
        }

        // Pacing gap is real-send anti-ban only — log mode has nothing to pace.
        if (autoReplied > 0 && env.UNANSWERED_WA_MODE === "send") {
          await sleep(SEND_GAP_MS);
        }

        // Didi may have answered while this sweep sat in LLM latency / pacing sleeps —
        // the webhook resolves the row, and we must never send after that.
        const still = await pool.query<{ state: string }>(
          `SELECT state FROM public.wa_unanswered WHERE id = $1`,
          [row.id],
        );
        if (still.rows[0]?.state !== "watching") {
          skipped++;
          continue;
        }

        if (env.UNANSWERED_WA_MODE === "send") {
          await sendInteractiveButtonsWith(creds, row.chat_id, AUTO_REPLY_TEXT, AUTO_REPLY_BUTTONS);
        } else {
          logger.info(
            { chatId: row.chat_id, text: AUTO_REPLY_TEXT },
            "unanswered-wa: [LOG MODE] auto-reply buttons suppressed — would have sent",
          );
        }
        await pool.query(
          `UPDATE public.wa_unanswered
           SET state='pending_followup', auto_replied_at=now(), updated_at=now()
           WHERE id=$1 AND state='watching'`,
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
// Callback-reminder pass — daily (09:00 cron): notify Didi of overnight callback
// requests + housekeeping
// ---------------------------------------------------------------------------

let reminderRunning = false;

export async function sendCallbackReminders(): Promise<{ reminded: number; expired: number; deleted: number }> {
  if (reminderRunning) {
    logger.warn("unanswered-wa: callback-reminder pass already in progress — skipping re-entrant call");
    return { reminded: 0, expired: 0, deleted: 0 };
  }
  reminderRunning = true;

  try {
    const now = new Date();
    const dayStart = israelDayStart(now);

    let reminded = 0;
    let expired = 0;

    if (env.UNANSWERED_WA_MODE === "off") {
      logger.info("unanswered-wa: mode=off — skipping callback-reminder pass");
    } else if (!WATCH_WEEKDAYS.has(israelWeekday(now))) {
      // Fri/Sat — Didi's weekend: hold both the reminder and the daily reset, so
      // Thursday's buttons stay tappable over the weekend and unreminded callbacks roll
      // to Sunday 09:00 instead of being stamped on a morning he won't act on.
      logger.info("unanswered-wa: weekend — callback reminders + daily reset deferred to Sunday");
    } else {
      const res = await pool.query<{ id: string; chat_id: string; sender_name: string | null }>(
        `SELECT id, chat_id, sender_name FROM public.wa_unanswered
         WHERE callback_requested_at IS NOT NULL AND callback_reminded_at IS NULL
         ORDER BY callback_requested_at`,
      );

      if (res.rows.length > 0) {
        const lines = res.rows.map((row) => {
          const phone = toLocalPhone(row.chat_id);
          const name = displayName(row.sender_name, row.chat_id);
          return name ? `• ${name} (${phone})` : `• ${phone}`;
        });
        const message = `🔔 תזכורת — הלקוחות הבאים ביקשו שתחזור אליהם:\n${lines.join("\n")}`;

        if (env.UNANSWERED_WA_MODE === "send") {
          const delivered = await notifyOwnerOps(message);
          if (delivered) {
            const ids = res.rows.map((row) => row.id);
            await pool.query(
              `UPDATE public.wa_unanswered SET callback_reminded_at=now(), updated_at=now() WHERE id = ANY($1)`,
              [ids],
            );
            reminded = res.rows.length;
          } else {
            // Rows stay unstamped so tomorrow's 09:00 pass retries them — a failed owner
            // send must never silently swallow callback requests.
            logger.warn(
              { count: res.rows.length },
              "unanswered-wa: owner callback-reminder send failed — rows left unstamped for retry",
            );
          }
        } else {
          // Log mode must never stamp: a row marked reminded here would be silently
          // swallowed at the next send-mode flip — the exact failure class that lost
          // real client callbacks during the Jul-2026 testing window.
          logger.info({ message }, "unanswered-wa: [LOG MODE] callback-reminder suppressed — rows left unstamped");
        }
      }

      // Yesterday's button messages that got no reply at all — expire at today's reset.
      const expiredRes = await pool.query(
        `UPDATE public.wa_unanswered
         SET state='expired', updated_at=now()
         WHERE state='pending_followup' AND auto_replied_at < $1`,
        [dayStart.toISOString()],
      );
      expired = expiredRes.rowCount ?? 0;
    }

    // Housekeeping (runs regardless of mode): delete old resolved/skipped/expired rows,
    // but never a callback that's still waiting on its owner reminder.
    const deleteCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const deletedRes = await pool.query(
      `DELETE FROM public.wa_unanswered
       WHERE state IN ('resolved','skipped','expired') AND updated_at <= $1
         AND NOT (callback_requested_at IS NOT NULL AND callback_reminded_at IS NULL)`,
      [deleteCutoff.toISOString()],
    );
    const deleted = deletedRes.rowCount ?? 0;

    logger.info({ reminded, expired, deleted }, "unanswered-wa: callback-reminder pass complete");
    return { reminded, expired, deleted };
  } finally {
    reminderRunning = false;
  }
}
