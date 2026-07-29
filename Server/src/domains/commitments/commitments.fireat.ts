import { israelWallTimeInstant, clampedSendTime } from "../calendar/reminder.service.js";
import type { CommitmentKind } from "./commitments.types.js";

const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Derive the CommitmentKind from the LLM-extracted date/time pair.
 * - Both date AND time present → "timed"
 * - Date only (no time)       → "date_only"
 * - Neither                   → "floating"
 */
export function deriveKind(date: string | null, time: string | null): CommitmentKind {
  if (date && time) return "timed";
  if (date) return "date_only";
  return "floating";
}

/**
 * Compute fire_at for a "timed" commitment:
 * 1h before due_date @ due_time, clamped to 09:00–17:00 Jerusalem. Returns null when the
 * clamped time would land at/after the appointment itself (early-morning appointment).
 *
 * @param dueDate  YYYY-MM-DD
 * @param dueTime  HH:MM (24h)
 */
export function fireAtTimed(dueDate: string, dueTime: string): Date | null {
  const [h, m] = dueTime.split(":").map(Number);
  // Build the appointment instant in Jerusalem wall time
  const apptRef = new Date(`${dueDate}T00:00:00Z`);
  const apptInstant = israelWallTimeInstant(apptRef, h ?? 0, m ?? 0);
  // 17:00 (not 18:00) — a fire_at parked at exactly 18:00 only gets one 60s firing tick
  // before the next stale-cancel sweep, since the 15-min setInterval phase is boot-dependent.
  const clamped = clampedSendTime(apptInstant, ONE_HOUR_MS, 9, 17);
  if (clamped.getTime() >= apptInstant.getTime()) return null;
  return clamped;
}

/**
 * Compute fire_at for a "date_only" commitment:
 * due_date @ 09:00 Jerusalem.
 *
 * @param dueDate  YYYY-MM-DD
 */
export function fireAtDateOnly(dueDate: string): Date {
  const ref = new Date(`${dueDate}T00:00:00Z`);
  return israelWallTimeInstant(ref, 9, 0);
}

/**
 * Compute fire_at for a "floating" commitment:
 * (message_date + 1 day) @ 09:00 Jerusalem.
 *
 * @param messageTs  Unix timestamp (seconds) of the source message.
 */
export function fireAtFloating(messageTs: number): Date {
  const msgDate = new Date(messageTs * 1000);
  const nextDay = new Date(msgDate.getTime() + 24 * 60 * 60 * 1000);
  return israelWallTimeInstant(nextDay, 9, 0);
}

/**
 * Compute fire_at for any commitment given its kind + raw LLM fields.
 * Returns null when kind === "timed" and fireAtTimed determined the reminder would fire
 * at/after the appointment itself — callers must skip insertion in that case.
 */
export function computeFireAt(
  kind: CommitmentKind,
  dueDate: string | null,
  dueTime: string | null,
  messageTs: number,
): Date | null {
  if (kind === "timed" && dueDate && dueTime) return fireAtTimed(dueDate, dueTime);
  if (kind === "date_only" && dueDate) return fireAtDateOnly(dueDate);
  return fireAtFloating(messageTs);
}
