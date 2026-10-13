import { z } from "zod";
import { pool } from "../../lib/db.js";
import { logger } from "../../config/logger.js";
import { AppError, NotFoundError } from "../../lib/errors.js";
import { israelWallTimeInstant } from "../calendar/reminder.service.js";

export const DEFAULT_AUTO_REPLY_TEXT =
  "היי זה דידי, אני בפגישה. אם מדובר במשהו שבמשרד יכולים לעזור, מוזמנים להתקשר או לשלוח וואטסאפ למספר 026244791";

export type AutoReplySource = "temporary" | "permanent" | "default";

// Exactly what resolveAutoReply needs — the hidden-original flag is deliberately not part of it.
export interface StoredAutoReplyState {
  permanent: string | null;
  temporary: { text: string; until: Date } | null;
}

interface StoredSettings extends StoredAutoReplyState {
  originalHidden: boolean;
}

export interface AutoReplyStateDto {
  active: { text: string; source: AutoReplySource; until: string | null };
  permanent: string | null;
  temporary: { text: string; until: string } | null;
  originalHidden: boolean;
  originalText: string;
  messages: Array<{ id: string; text: string; builtIn: boolean; createdAt: string | null }>;
}

const PERMANENT_KEY = "unanswered_wa_reply_permanent";
const TEMPORARY_KEY = "unanswered_wa_reply_temporary";
// Row present = the built-in original is hidden from the saved-messages list. Display flag
// only: the send path ignores it, so the original stays the bot's ultimate fallback.
const ORIGINAL_HIDDEN_KEY = "unanswered_wa_reply_original_hidden";
const DEFAULT_MESSAGE_ID = "default";
const MAX_SAVED_MESSAGES = 50;
const MAX_UNTIL_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;
const UNTIL_LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

const isNonBlank = (value: string): boolean => value.trim().length > 0;

const storedTemporarySchema = z.object({
  text: z.string().refine(isNonBlank),
  until: z.string().refine((value) => !Number.isNaN(Date.parse(value))),
});

// ---------------------------------------------------------------------------
// Resolution — temporary wins until its deadline, then permanent, then the original
// ---------------------------------------------------------------------------

export function resolveAutoReply(
  state: StoredAutoReplyState,
  now: Date,
): { text: string; source: AutoReplySource; until: Date | null } {
  if (state.temporary && now.getTime() < state.temporary.until.getTime()) {
    return { text: state.temporary.text, source: "temporary", until: state.temporary.until };
  }
  if (state.permanent !== null) {
    return { text: state.permanent, source: "permanent", until: null };
  }
  return { text: DEFAULT_AUTO_REPLY_TEXT, source: "default", until: null };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseTemporary(raw: string): StoredAutoReplyState["temporary"] {
  const parsed = storedTemporarySchema.safeParse(parseJson(raw));
  if (!parsed.success) {
    logger.warn({ raw }, "unanswered-wa: stored temporary auto-reply is malformed — ignoring it");
    return null;
  }
  return { text: parsed.data.text, until: new Date(parsed.data.until) };
}

async function readStoredState(): Promise<StoredSettings> {
  const res = await pool.query<{ key: string; value: string }>(
    `SELECT key, value FROM public.system_settings WHERE key = ANY($1)`,
    [[PERMANENT_KEY, TEMPORARY_KEY, ORIGINAL_HIDDEN_KEY]],
  );
  const permanent = res.rows.find((row) => row.key === PERMANENT_KEY)?.value;
  const temporary = res.rows.find((row) => row.key === TEMPORARY_KEY)?.value;

  return {
    permanent: permanent !== undefined && isNonBlank(permanent) ? permanent : null,
    temporary: temporary === undefined ? null : parseTemporary(temporary),
    originalHidden: res.rows.some((row) => row.key === ORIGINAL_HIDDEN_KEY),
  };
}

// Called from the live send path: it must always hand back sendable text, so any failure
// (DB down, bad stored value) degrades to the original message instead of blocking the reply.
export async function getActiveAutoReplyText(now: Date): Promise<string> {
  try {
    return resolveAutoReply(await readStoredState(), now).text;
  } catch (err) {
    logger.warn({ err }, "unanswered-wa: could not read the auto-reply setting — using the original text");
    return DEFAULT_AUTO_REPLY_TEXT;
  }
}

export async function getAutoReplyState(now: Date): Promise<AutoReplyStateDto> {
  const [stored, saved] = await Promise.all([
    readStoredState(),
    pool.query<{ id: string; text: string; created_at: Date }>(
      `SELECT id, text, created_at FROM public.auto_reply_messages ORDER BY created_at DESC`,
    ),
  ]);
  const active = resolveAutoReply(stored, now);
  const savedMessages = saved.rows.map((row) => ({
    id: row.id,
    text: row.text,
    builtIn: false,
    createdAt: row.created_at.toISOString(),
  }));

  return {
    active: {
      text: active.text,
      source: active.source,
      until: active.until ? active.until.toISOString() : null,
    },
    permanent: stored.permanent,
    temporary:
      active.source === "temporary" && active.until
        ? { text: active.text, until: active.until.toISOString() }
        : null,
    originalHidden: stored.originalHidden,
    originalText: DEFAULT_AUTO_REPLY_TEXT,
    messages: stored.originalHidden
      ? savedMessages
      : [
          { id: DEFAULT_MESSAGE_ID, text: DEFAULT_AUTO_REPLY_TEXT, builtIn: true, createdAt: null },
          ...savedMessages,
        ],
  };
}

// ---------------------------------------------------------------------------
// Saved-messages list
// ---------------------------------------------------------------------------

async function upsertSetting(key: string, value: string): Promise<void> {
  await pool.query(
    `INSERT INTO public.system_settings (key, value)
     VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value],
  );
}

export async function restoreOriginal(): Promise<void> {
  await pool.query(`DELETE FROM public.system_settings WHERE key = $1`, [ORIGINAL_HIDDEN_KEY]);
}

export async function saveMessage(text: string): Promise<string> {
  const trimmed = text.trim();
  if (trimmed === DEFAULT_AUTO_REPLY_TEXT) {
    await restoreOriginal();
    return DEFAULT_MESSAGE_ID;
  }

  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM public.auto_reply_messages WHERE text = $1`,
    [trimmed],
  );
  if (existing.rows[0]) return existing.rows[0].id;

  const count = await pool.query<{ c: number }>(
    `SELECT count(*)::int AS c FROM public.auto_reply_messages`,
  );
  if (count.rows[0].c >= MAX_SAVED_MESSAGES) {
    throw new AppError(
      400,
      `saved message limit reached (${MAX_SAVED_MESSAGES})`,
      "MESSAGE_LIMIT_REACHED",
    );
  }

  // No-op DO UPDATE rather than DO NOTHING: RETURNING then yields the id even when a
  // concurrent save of the same text won the race between the lookup above and this insert.
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO public.auto_reply_messages (text)
     VALUES ($1)
     ON CONFLICT (text) DO UPDATE SET text = EXCLUDED.text
     RETURNING id`,
    [trimmed],
  );
  return inserted.rows[0].id;
}

export async function deleteMessage(id: string): Promise<void> {
  if (id === DEFAULT_MESSAGE_ID) {
    // Hide only. Permanent/temporary stay untouched, so a message already being sent keeps
    // being sent, and with nothing set the bot still falls back to the original.
    await upsertSetting(ORIGINAL_HIDDEN_KEY, "true");
    return;
  }

  const res = await pool.query(`DELETE FROM public.auto_reply_messages WHERE id = $1`, [id]);
  if ((res.rowCount ?? 0) === 0) throw new NotFoundError("Saved message");
}

// ---------------------------------------------------------------------------
// Using a message — copies its text into the settings, so deleting it later never
// changes what is active
// ---------------------------------------------------------------------------

async function resolveMessageText(id: string): Promise<string> {
  if (id === DEFAULT_MESSAGE_ID) return DEFAULT_AUTO_REPLY_TEXT;

  const res = await pool.query<{ text: string }>(
    `SELECT text FROM public.auto_reply_messages WHERE id = $1`,
    [id],
  );
  if (!res.rows[0]) throw new NotFoundError("Saved message");
  return res.rows[0].text;
}

export async function useMessage(id: string, mode: "permanent"): Promise<void>;
export async function useMessage(id: string, mode: "temporary", until: Date): Promise<void>;
export async function useMessage(
  id: string,
  mode: "permanent" | "temporary",
  until?: Date,
): Promise<void> {
  const text = await resolveMessageText(id);

  if (mode === "temporary") {
    await upsertSetting(TEMPORARY_KEY, JSON.stringify({ text, until: (until as Date).toISOString() }));
    return;
  }

  // One statement per case: a failure between two separate writes could leave a stale
  // temporary message overriding the permanent one the owner just chose.
  if (id === DEFAULT_MESSAGE_ID) {
    await pool.query(`DELETE FROM public.system_settings WHERE key = ANY($1)`, [
      [PERMANENT_KEY, TEMPORARY_KEY],
    ]);
    return;
  }

  await pool.query(
    `WITH cleared AS (DELETE FROM public.system_settings WHERE key = $1)
     INSERT INTO public.system_settings (key, value)
     VALUES ($2, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [TEMPORARY_KEY, PERMANENT_KEY, text],
  );
}

export async function clearTemporary(): Promise<void> {
  await pool.query(`DELETE FROM public.system_settings WHERE key = $1`, [TEMPORARY_KEY]);
}

// ---------------------------------------------------------------------------
// "Until" input — the owner's page sends Israel wall time (YYYY-MM-DDTHH:mm)
// ---------------------------------------------------------------------------

function invalidUntil(): AppError {
  return new AppError(400, "invalid until date/time", "INVALID_UNTIL");
}

export function parseUntil(local: string, now: Date): Date {
  if (!UNTIL_LOCAL_RE.test(local)) throw invalidUntil();

  const date = local.slice(0, 10);
  const [year, month, day] = date.split("-").map(Number);
  const hour = Number(local.slice(11, 13));
  const minute = Number(local.slice(14, 16));

  const calendarDay = new Date(Date.UTC(year, month - 1, day));
  const isRealDate =
    calendarDay.getUTCFullYear() === year &&
    calendarDay.getUTCMonth() === month - 1 &&
    calendarDay.getUTCDate() === day;
  if (!isRealDate || hour > 23 || minute > 59) throw invalidUntil();

  // Noon UTC falls on the same calendar day in Israel (UTC+2/+3), whatever the DST state.
  const until = israelWallTimeInstant(new Date(`${date}T12:00:00Z`), hour, minute);

  if (until.getTime() <= now.getTime()) {
    throw new AppError(400, "until must be in the future", "UNTIL_IN_PAST");
  }
  if (until.getTime() > now.getTime() + MAX_UNTIL_AHEAD_MS) {
    throw new AppError(400, "until must be within one year", "UNTIL_TOO_FAR");
  }
  return until;
}
