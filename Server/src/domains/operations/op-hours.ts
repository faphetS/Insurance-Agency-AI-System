import { env } from "../../config/env.js";
import { israelTimeOfDayMs } from "../calendar/reminder.service.js";

const TZ = "Asia/Jerusalem";

const OP_WEEKDAYS = new Set(["Sun", "Mon", "Tue", "Wed", "Thu"]);

const WEEKDAY_FMT = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" });

function israelWeekday(d: Date): string {
  return WEEKDAY_FMT.format(d);
}

export function isOpWeekday(d: Date): boolean {
  if (env.UNANSWERED_WINDOW_DISABLED) return true;
  return OP_WEEKDAYS.has(israelWeekday(d));
}

export function isIsraelSunday(d: Date): boolean {
  return israelWeekday(d) === "Sun";
}

// The env key name is historical (from the unanswered-WA-only rollout).
export function isWithinOpWindow(d: Date): boolean {
  if (env.UNANSWERED_WINDOW_DISABLED) return true;
  const minutes = Math.floor(israelTimeOfDayMs(d) / 60_000);
  return isOpWeekday(d) && minutes >= 9 * 60 && minutes <= 18 * 60;
}
