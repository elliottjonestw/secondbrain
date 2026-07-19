// Small date helpers built on date-fns, plus <input> value converters.

import {
  format,
  startOfDay,
  endOfDay,
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
  isSameDay,
  isToday,
} from "date-fns";

export { format, startOfDay, endOfDay, startOfWeek, endOfWeek, startOfMonth, endOfMonth, isSameDay, isToday };

export function fmtTime(d: Date): string {
  return format(d, "h:mm a");
}

export function fmtDate(d: Date): string {
  return format(d, "EEE, MMM d");
}

export function fmtDateTime(iso: string | null): string {
  if (!iso) return "";
  return format(new Date(iso), "MMM d, h:mm a");
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
