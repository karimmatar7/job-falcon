/**
 * Timezone-aware scheduling arithmetic.
 *
 * The bot stores a daily wall-clock time (`HH:MM`) plus an IANA timezone, and
 * needs to know the next UTC instant that wall-clock time occurs. This is done
 * with the platform `Intl` API only (no dependency, no paid service), so DST
 * transitions are handled by the runtime's timezone database.
 */

/** `HH:MM` in 24-hour form, from 00:00 to 23:59. */
export const SCHEDULE_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface TimeOfDay {
  readonly hour: number;
  readonly minute: number;
}

export function parseScheduleTime(value: string): TimeOfDay | null {
  const match = SCHEDULE_TIME_PATTERN.exec(value.trim());
  if (match === null) return null;
  const hour = match[1];
  const minute = match[2];
  if (hour === undefined || minute === undefined) return null;
  return { hour: Number(hour), minute: Number(minute) };
}

export function isValidScheduleTime(value: string): boolean {
  return parseScheduleTime(value) !== null;
}

/** True when the runtime recognizes the IANA timezone name. */
export function isValidTimeZone(value: string): boolean {
  const timeZone = value.trim();
  if (timeZone.length === 0) return false;
  try {
    // Throws RangeError for an unknown zone on a fully-ICU Node build.
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

interface ZoneParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

function zoneParts(date: Date, timeZone: string): ZoneParts {
  const parts = formatterFor(timeZone).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((entry) => entry.type === type);
    return part === undefined ? 0 : Number(part.value);
  };
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

/**
 * The zone's UTC offset (in milliseconds) at the given instant, such that
 * `localWallClock = utcInstant + offset`.
 */
function zoneOffsetMs(date: Date, timeZone: string): number {
  const p = zoneParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - date.getTime();
}

/**
 * Convert a wall-clock time in the given zone to a UTC instant. The offset is
 * resolved twice so a DST change between the naive instant and the resolved
 * instant converges on the correct side of the transition.
 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const firstGuess = asUtc - zoneOffsetMs(new Date(asUtc), timeZone);
  const secondGuess = asUtc - zoneOffsetMs(new Date(firstGuess), timeZone);
  const thirdGuess = asUtc - zoneOffsetMs(new Date(secondGuess), timeZone);
  return new Date(thirdGuess);
}

function addCalendarDays(
  year: number,
  month: number,
  day: number,
  days: number,
): { year: number; month: number; day: number } {
  const base = new Date(Date.UTC(year, month - 1, day));
  base.setUTCDate(base.getUTCDate() + days);
  return {
    year: base.getUTCFullYear(),
    month: base.getUTCMonth() + 1,
    day: base.getUTCDate(),
  };
}

/**
 * The next instant strictly after `from` at which the local wall-clock time in
 * `timeZone` equals `time`. Throws when the time is malformed so a bad value
 * can never silently schedule the wrong thing.
 */
export function nextRunAfter(time: string, timeZone: string, from: Date): Date {
  const parsed = parseScheduleTime(time);
  if (parsed === null) {
    throw new Error(`Invalid schedule time: ${time}`);
  }
  if (!isValidTimeZone(timeZone)) {
    throw new Error(`Invalid timezone: ${timeZone}`);
  }

  const now = zoneParts(from, timeZone);
  const today = zonedTimeToUtc(
    now.year,
    now.month,
    now.day,
    parsed.hour,
    parsed.minute,
    timeZone,
  );
  if (today.getTime() > from.getTime()) return today;

  const tomorrow = addCalendarDays(now.year, now.month, now.day, 1);
  return zonedTimeToUtc(
    tomorrow.year,
    tomorrow.month,
    tomorrow.day,
    parsed.hour,
    parsed.minute,
    timeZone,
  );
}

/** A wall-clock label such as `2026-10-13 08:00` in the given zone. */
export function formatWallClock(date: Date, timeZone: string): string {
  const p = zoneParts(date, timeZone);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

/** A compact relative label such as `in 9h 12m` (or `now`/`overdue`). */
export function formatRelative(target: Date, from: Date): string {
  const deltaMs = target.getTime() - from.getTime();
  if (deltaMs <= 0) return "due now";
  const totalMinutes = Math.round(deltaMs / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return `in ${parts.join(" ")}`;
}
