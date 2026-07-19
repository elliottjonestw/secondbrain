// Recurrence expansion via the `rrule` package (RFC 5545). We never hand-roll
// recurrence math. Given an event and a visible date window, produce concrete
// occurrences for the calendar to render.

import { rrulestr } from "rrule";
import type { EventRow, EventOccurrence } from "../types";

function normalizeRule(rrule: string): string {
  return rrule.startsWith("RRULE:") || rrule.startsWith("DTSTART")
    ? rrule
    : `RRULE:${rrule}`;
}

/** Same calendar day (local) — used to match EXDATEs against occurrences. */
function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Expand one event into occurrences overlapping [windowStart, windowEnd].
 * Non-recurring events yield 0 or 1 occurrence.
 */
export function expandEvent(
  ev: EventRow,
  windowStart: Date,
  windowEnd: Date,
): EventOccurrence[] {
  const start = new Date(ev.dtstart);
  const durationMs =
    ev.dtend && ev.dtend !== "" ? new Date(ev.dtend).getTime() - start.getTime() : 0;

  const exdates: Date[] = ev.exdates ? JSON.parse(ev.exdates).map((d: string) => new Date(d)) : [];

  if (!ev.rrule) {
    const end = ev.dtend ? new Date(ev.dtend) : null;
    const effectiveEnd = end ?? start;
    if (effectiveEnd >= windowStart && start <= windowEnd) {
      return [{ event: ev, start, end, isRecurringInstance: false }];
    }
    return [];
  }

  let rule;
  try {
    rule = rrulestr(normalizeRule(ev.rrule), { dtstart: start });
  } catch {
    // Malformed rule — fall back to treating it as a single event.
    return [{ event: ev, start, end: ev.dtend ? new Date(ev.dtend) : null, isRecurringInstance: false }];
  }

  // Pad the window so multi-day recurrences that start before the window
  // still appear.
  const padStart = new Date(windowStart.getTime() - Math.max(durationMs, 0));
  const occurrences = rule.between(padStart, windowEnd, true);

  return occurrences
    .filter((occStart) => !exdates.some((ex) => sameDay(ex, occStart)))
    .map((occStart) => {
      const occEnd = durationMs ? new Date(occStart.getTime() + durationMs) : null;
      return {
        event: ev,
        start: occStart,
        end: occEnd,
        isRecurringInstance: true,
      };
    })
    .filter((o) => (o.end ?? o.start) >= windowStart && o.start <= windowEnd);
}

/** Expand many events across a window and sort chronologically. */
export function expandEvents(
  events: EventRow[],
  windowStart: Date,
  windowEnd: Date,
): EventOccurrence[] {
  return events
    .flatMap((ev) => expandEvent(ev, windowStart, windowEnd))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
}

// Human-readable summary of an RRULE for display in forms.
export function describeRrule(rrule: string | null): string {
  if (!rrule) return "Does not repeat";
  try {
    const rule = rrulestr(normalizeRule(rrule), { dtstart: new Date() });
    return rule.toText().replace(/^\w/, (c) => c.toUpperCase());
  } catch {
    return rrule;
  }
}
