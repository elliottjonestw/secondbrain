// Calendar registry + aggregation.
//
// The app has one built-in SQLite calendar and any number of connected CalDAV
// calendars. This module is the single place that knows about both: it lists
// them, merges their occurrences for a visible window, and routes every write
// to the right backend (db.ts for local, lib/caldav for remote). The calendar
// views and the AI assistant call *this*, never the two backends directly.
//
// Remote events are fetched live and never persisted — see README/CLAUDE for
// why. The only caching is the short-lived in-memory one below, which exists so
// re-rendering the same month doesn't re-hit the network.

import type { EventRow, EventOccurrence, EventSource, UnifiedEvent } from "../types";
import { LOCAL_CALENDAR_ID } from "../types";
import {
  listEvents, getEvent as getLocalEvent, upsertEvent, deleteEvent as deleteLocalEvent,
  addExdate, newId,
} from "../db";
import { expandEvents } from "./recurrence";
import {
  getCalendarSettings, saveCalendarSettings, saveAccountCalendars,
  type CalDavCalendar,
} from "./settings";
import {
  fetchOccurrences, fetchEventByUid, createRemoteEvent, updateRemoteEvent, deleteRemoteEvent,
} from "./caldav/events";

export interface CalendarInfo {
  id: string;
  name: string;
  color: string | null;
  source: EventSource;
  visible: boolean;
  readOnly: boolean;
}

/** The editable fields of an event, independent of where it is stored. */
export interface EventDraft {
  summary: string;
  description: string | null;
  location: string | null;
  dtstart: string;
  dtend: string | null;
  all_day: number;
  rrule: string | null;
  exdates: string | null;
  status: string;
  categories: string | null;
  color: string | null;
}

export const LOCAL_CALENDAR_NAME = "Second Brain";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Every calendar the app knows about, local first. */
export function listCalendars(): CalendarInfo[] {
  const s = getCalendarSettings();
  const local: CalendarInfo = {
    id: LOCAL_CALENDAR_ID,
    name: LOCAL_CALENDAR_NAME,
    color: null,
    source: "local",
    visible: s.localVisible,
    readOnly: false,
  };
  const remote = (s.account?.calendars ?? []).map<CalendarInfo>((c) => ({
    id: c.id,
    name: c.displayName,
    color: c.color,
    source: "caldav",
    visible: c.visible,
    readOnly: c.readOnly,
  }));
  return [local, ...remote];
}

export function getCalendar(id: string): CalendarInfo | undefined {
  return listCalendars().find((c) => c.id === id);
}

/** Where new events go when the caller doesn't name a calendar. Falls back to
 * local if the stored default points at a calendar that no longer exists. */
export function defaultCalendarId(): string {
  const { defaultCalendarId: id } = getCalendarSettings();
  return getCalendar(id) ? id : LOCAL_CALENDAR_ID;
}

/** Resolve a user- or model-supplied calendar name to a calendar (case-insensitive). */
export function findCalendarByName(name: string): CalendarInfo | undefined {
  const q = name.trim().toLowerCase();
  if (!q) return undefined;
  const all = listCalendars();
  return all.find((c) => c.name.toLowerCase() === q) ?? all.find((c) => c.name.toLowerCase().includes(q));
}

export function setCalendarVisible(id: string, visible: boolean): void {
  if (id === LOCAL_CALENDAR_ID) {
    saveCalendarSettings({ localVisible: visible });
  } else {
    const cals = getCalendarSettings().account?.calendars ?? [];
    saveAccountCalendars(cals.map((c) => (c.id === id ? { ...c, visible } : c)));
  }
  invalidateCache();
}

/** The stored CalDAV calendar record for an id, if the account has one. */
function remoteCalendar(id: string): CalDavCalendar | undefined {
  return getCalendarSettings().account?.calendars.find((c) => c.id === id);
}

// ---------------------------------------------------------------------------
// Local <-> unified mapping
// ---------------------------------------------------------------------------

export function localToUnified(row: EventRow): UnifiedEvent {
  return {
    source: "local",
    calendarId: LOCAL_CALENDAR_ID,
    id: row.id,
    color: row.color,
    summary: row.summary,
    description: row.description,
    location: row.location,
    dtstart: row.dtstart,
    dtend: row.dtend,
    all_day: row.all_day,
    rrule: row.rrule,
    exdates: row.exdates,
    status: row.status,
    categories: row.categories,
  };
}

/** The draft fields of an existing event, for partial-merge updates. */
export function toDraft(ev: UnifiedEvent): EventDraft {
  return {
    summary: ev.summary,
    description: ev.description,
    location: ev.location,
    dtstart: ev.dtstart,
    dtend: ev.dtend,
    all_day: ev.all_day,
    rrule: ev.rrule,
    exdates: ev.exdates,
    status: ev.status,
    categories: ev.categories,
    color: ev.color,
  };
}

// ---------------------------------------------------------------------------
// Session cache
//
// Keyed by calendar + window. Purely in-memory and short-lived: it stops a
// re-render or a quick back-and-forth from re-hitting the network, and it is
// dropped wholesale on any write so the UI never shows a stale event.
// ---------------------------------------------------------------------------
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; occurrences: EventOccurrence[] }>();

export function invalidateCache(): void {
  cache.clear();
}

function cacheKey(calendarId: string, start: Date, end: Date): string {
  return `${calendarId}|${start.getTime()}|${end.getTime()}`;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface OccurrencesResult {
  occurrences: EventOccurrence[];
  /** Per-calendar failures (offline, bad credentials). Local data still loads. */
  errors: string[];
}

/**
 * Occurrences from the *visible connected* calendars only.
 *
 * A calendar that fails is reported in `errors` rather than thrown — the local
 * calendar must keep working when iCloud is unreachable. Split out from
 * getOccurrences so callers with their own local-event query (the assistant,
 * which pre-filters in SQL) can reuse just the remote half.
 */
export async function getRemoteOccurrences(
  windowStart: Date,
  windowEnd: Date,
): Promise<OccurrencesResult> {
  const account = getCalendarSettings().account;
  const visible = (account?.calendars ?? []).filter((c) => c.visible);
  if (!account || visible.length === 0) return { occurrences: [], errors: [] };

  const errors: string[] = [];
  const batches = await Promise.all(
    visible.map(async (cal) => {
      const key = cacheKey(cal.id, windowStart, windowEnd);
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.occurrences;
      try {
        const occs = await fetchOccurrences(account, cal, windowStart, windowEnd);
        cache.set(key, { at: Date.now(), occurrences: occs });
        return occs;
      } catch (e) {
        errors.push(`${cal.displayName}: ${e instanceof Error ? e.message : String(e)}`);
        return [];
      }
    }),
  );

  return { occurrences: batches.flat(), errors };
}

/** Every occurrence from every *visible* calendar overlapping the window. */
export async function getOccurrences(
  windowStart: Date,
  windowEnd: Date,
): Promise<OccurrencesResult> {
  const localVisible = getCalendarSettings().localVisible;
  const [local, remote] = await Promise.all([
    localVisible
      ? listEvents().then((rows) => expandEvents(rows.map(localToUnified), windowStart, windowEnd))
      : Promise.resolve([] as EventOccurrence[]),
    getRemoteOccurrences(windowStart, windowEnd),
  ]);

  const occurrences = [...local, ...remote.occurrences].sort(
    (a, b) => a.start.getTime() - b.start.getTime(),
  );
  return { occurrences, errors: remote.errors };
}

/** Fetch a single event by calendar + id (local UUID or remote iCal UID). */
export async function getEventByRef(
  calendarId: string,
  id: string,
): Promise<UnifiedEvent | null> {
  if (calendarId === LOCAL_CALENDAR_ID) {
    const row = await getLocalEvent(id);
    return row ? localToUnified(row) : null;
  }
  const account = getCalendarSettings().account;
  const cal = remoteCalendar(calendarId);
  if (!account || !cal) return null;
  return fetchEventByUid(account, cal, id);
}

/** Find an event by id across every calendar — for callers holding only an id.
 * Costs one request per connected calendar, so prefer getEventByRef when the
 * calendar is known. */
export async function findEventById(id: string): Promise<UnifiedEvent | null> {
  const local = await getLocalEvent(id);
  if (local) return localToUnified(local);

  const account = getCalendarSettings().account;
  if (!account) return null;

  for (const cal of account.calendars) {
    try {
      const found = await fetchEventByUid(account, cal, id);
      if (found) return found;
    } catch {
      /* keep looking in the other calendars */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Writing — dispatched by calendar
// ---------------------------------------------------------------------------

function assertWritable(cal: CalendarInfo | undefined, calendarId: string): CalendarInfo {
  if (!cal) throw new Error(`Unknown calendar: ${calendarId}`);
  if (cal.readOnly) throw new Error(`"${cal.name}" is read-only.`);
  return cal;
}

/** Create an event in the given calendar. Returns its id. */
export async function createEvent(calendarId: string, draft: EventDraft): Promise<string> {
  const cal = assertWritable(getCalendar(calendarId), calendarId);

  if (cal.source === "local") {
    return upsertEvent({ ...draft });
  }

  const account = getCalendarSettings().account;
  const remote = remoteCalendar(calendarId);
  if (!account || !remote) throw new Error("That calendar account is no longer connected.");

  const ev: UnifiedEvent = {
    ...draft,
    source: "caldav",
    calendarId,
    id: newId(), // doubles as the iCal UID
    color: remote.color,
  };
  await createRemoteEvent(account, remote, ev);
  invalidateCache();
  return ev.id;
}

/** Apply a partial change to an existing event, wherever it lives. */
export async function updateEvent(
  ev: UnifiedEvent,
  patch: Partial<EventDraft>,
): Promise<void> {
  const merged = { ...toDraft(ev), ...patch };

  if (ev.source === "local") {
    await upsertEvent({ id: ev.id, ...merged });
    return;
  }

  const account = getCalendarSettings().account;
  if (!account) throw new Error("That calendar account is no longer connected.");
  assertWritable(getCalendar(ev.calendarId), ev.calendarId);
  await updateRemoteEvent(account, { ...ev, ...merged });
  invalidateCache();
}

export async function deleteEvent(ev: UnifiedEvent): Promise<void> {
  if (ev.source === "local") {
    await deleteLocalEvent(ev.id);
    return;
  }
  const account = getCalendarSettings().account;
  if (!account) throw new Error("That calendar account is no longer connected.");
  assertWritable(getCalendar(ev.calendarId), ev.calendarId);
  await deleteRemoteEvent(account, ev);
  invalidateCache();
}

/** Exclude a single occurrence of a recurring event ("skip this day"). */
export async function skipOccurrence(ev: UnifiedEvent, occurrence: Date): Promise<void> {
  if (ev.source === "local") {
    await addExdate(ev.id, occurrence.toISOString());
    return;
  }
  const existing: string[] = ev.exdates ? JSON.parse(ev.exdates) : [];
  const iso = occurrence.toISOString();
  if (!existing.includes(iso)) existing.push(iso);
  await updateEvent(ev, { exdates: JSON.stringify(existing) });
}
