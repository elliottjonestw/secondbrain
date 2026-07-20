// Small date helpers built on date-fns, plus <input> value converters.
//
// This module holds the *active date-fns locale* for the whole app. lib/i18n.ts
// pushes it here whenever the language changes, which is why the helpers below
// keep their one-argument signatures — the ~40 existing call sites don't have to
// thread a locale through. The re-exported `format` is wrapped for the same
// reason: it injects the active locale, so a plain `format(d, "MMMM yyyy")`
// renders Chinese month names without the call site knowing about locales.

import {
  format as dfFormat,
  startOfDay,
  endOfDay,
  startOfWeek as dfStartOfWeek,
  endOfWeek as dfEndOfWeek,
  startOfMonth,
  endOfMonth,
  isSameDay,
  isToday,
  addDays,
} from "date-fns";
import { enUS } from "date-fns/locale";
import type { Locale } from "date-fns";

let activeLocale: Locale = enUS;

/** Set by lib/i18n.ts on init and on every language change. */
export function setDateLocale(locale: Locale): void {
  activeLocale = locale;
  formatters.clear();
}

export function dateLocale(): Locale {
  return activeLocale;
}

/** BCP 47 tag for the active locale, for the Intl.* APIs. */
function localeTag(): string {
  return activeLocale.code ?? "en-US";
}

// Display formatting goes through Intl.DateTimeFormat rather than date-fns
// patterns. A pattern like "MMM d" produces "7月 20" in Chinese where the
// correct form is "7月20日", and "h a" produces "1 下午" instead of "下午1時" —
// Intl knows each locale's actual conventions, so we don't encode them here.
// date-fns is still what decides which day the week starts on.
const formatters = new Map<string, Intl.DateTimeFormat>();

function fmt(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(options);
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(localeTag(), options);
    formatters.set(key, f);
  }
  return f;
}

export { startOfDay, endOfDay, startOfMonth, endOfMonth, isSameDay, isToday };

/** date-fns `format` with the active locale applied. Prefer the named helpers
 * below; use this directly only for one-off patterns. */
export function format(
  date: Date | number,
  pattern: string,
  options?: Parameters<typeof dfFormat>[2],
): string {
  return dfFormat(date, pattern, { locale: activeLocale, ...options });
}

// The week does not start on Sunday everywhere — the locale decides.
export function startOfWeek(d: Date): Date {
  return dfStartOfWeek(d, { locale: activeLocale });
}

export function endOfWeek(d: Date): Date {
  return dfEndOfWeek(d, { locale: activeLocale });
}

export function fmtTime(d: Date): string {
  return fmt({ hour: "numeric", minute: "2-digit" }).format(d);
}

export function fmtDate(d: Date): string {
  return fmt({ year: "numeric", month: "short", day: "numeric" }).format(d);
}

export function fmtDateTime(iso: string | null): string {
  if (!iso) return "";
  return fmt({
    year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  }).format(new Date(iso));
}

/** Day + month only, no year — used for birthdays. */
export function fmtMonthDay(d: Date): string {
  return fmt({ month: "short", day: "numeric" }).format(d);
}

/** Weekday + full date — the Today header. */
export function fmtFullDate(d: Date): string {
  return fmt({ weekday: "long", year: "numeric", month: "long", day: "numeric" }).format(d);
}

/** Month + year — the calendar's month-view title. */
export function fmtMonthYear(d: Date): string {
  return fmt({ year: "numeric", month: "long" }).format(d);
}

/** Hour-of-day label for the calendar's time gutter. */
export function fmtHour(hour: number): string {
  return fmt({ hour: "numeric" }).format(new Date(2020, 0, 1, hour));
}

/** Short weekday name for one date, e.g. "Mon" / "週一". */
export function fmtWeekdayShort(d: Date): string {
  return fmt({ weekday: "short" }).format(d);
}

/** Short weekday names in locale order, starting on the locale's first day. */
export function weekdayNames(): string[] {
  const start = startOfWeek(new Date());
  return Array.from({ length: 7 }, (_, i) => fmtWeekdayShort(addDays(start, i)));
}

/** "today" / "tomorrow" / "in 5 days", localized. */
export function fmtRelativeDays(days: number): string {
  const rtf = new Intl.RelativeTimeFormat(localeTag(), { numeric: "auto" });
  return rtf.format(days, "day");
}

/** Date -> value for <input type="datetime-local"> (local time, no seconds). */
export function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** value from <input type="datetime-local"> -> ISO string. */
export function fromLocalInput(v: string): string {
  return new Date(v).toISOString();
}

/** Date -> value for <input type="date">. */
export function toDateInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function isOverdue(iso: string | null): boolean {
  if (!iso) return false;
  return new Date(iso).getTime() < Date.now();
}
