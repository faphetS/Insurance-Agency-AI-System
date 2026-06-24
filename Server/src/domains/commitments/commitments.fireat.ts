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
 * 1h before due_date @ due_time, clamped to 07:00–21:00 Jerusalem.
 *
 * @param dueDate  YYYY-MM-DD
 * @param dueTime  HH:MM (24h)
 */
export function fireAtTimed(dueDate: string, dueTime: string): Date {
  const [h, m] = dueTime.split(":").map(Number);
  // Build the appointment instant in Jerusalem wall time
  const apptRef = new Date(`${dueDate}T00:00:00Z`);
  const apptInstant = israelWallTimeInstant(apptRef, h ?? 0, m ?? 0);
  // Subtract 1h, then clamp to quiet-hours window
  return clampedSendTime(apptInstant, ONE_HOUR_MS);
}

/**
 * Compute fire_at for a "date_only" commitment:
 * due_date @ 08:00 Jerusalem.
 *
 * @param dueDate  YYYY-MM-DD
 */
export function fireAtDateOnly(dueDate: string): Date {
  const ref = new Date(`${dueDate}T00:00:00Z`);
  return israelWallTimeInstant(ref, 8, 0);
}

/**
 * Compute fire_at for a "floating" commitment:
 * (message_date + 1 day) @ 08:00 Jerusalem.
 *
 * @param messageTs  Unix timestamp (seconds) of the source message.
 */
export function fireAtFloating(messageTs: number): Date {
  const msgDate = new Date(messageTs * 1000);
  const nextDay = new Date(msgDate.getTime() + 24 * 60 * 60 * 1000);
  return israelWallTimeInstant(nextDay, 8, 0);
}

/**
 * Compute fire_at for any commitment given its kind + raw LLM fields.
 */
export function computeFireAt(
  kind: CommitmentKind,
  dueDate: string | null,
  dueTime: string | null,
  messageTs: number,
): Date {
  if (kind === "timed" && dueDate && dueTime) return fireAtTimed(dueDate, dueTime);
  if (kind === "date_only" && dueDate) return fireAtDateOnly(dueDate);
  return fireAtFloating(messageTs);
}
