// Reading and writing VEVENTs on a CalDAV calendar.
//
// Reads are window-scoped `calendar-query` REPORTs — we ask the server for the
// events overlapping the visible date range rather than pulling the whole
// calendar, which is what keeps this workable against years of history.
// Writes are plain PUT/DELETE on the event's resource URL, guarded by ETags so
// a change made on another device surfaces as a conflict instead of being
// silently clobbered.

import {
  NS, CalDavError, davRequest, parseXml, multistatusResponses, textOf, propstatOk,
} from "./client";
import { buildCalendarData, expandRemoteEvent } from "./ical";
import type { CalDavAccount, CalDavCalendar } from "../settings";
import type { EventOccurrence, UnifiedEvent } from "../../types";

/** iCalendar UTC timestamp (basic format) — what time-range filters expect. */
function icalUtc(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!,
  );
}

function timeRangeQuery(start: Date, end: Date): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${icalUtc(start)}" end="${icalUtc(end)}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;
}

function uidQuery(uid: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:prop-filter name="UID">
          <c:text-match collation="i;octet">${escapeXml(uid)}</c:text-match>
        </c:prop-filter>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;
}

interface RemoteResource {
  href: string;
  etag: string | undefined;
  data: string;
}

/** Pull the (href, etag, calendar-data) triples out of a 207 Multi-Status. */
function readResources(xml: string, baseUrl: string): RemoteResource[] {
  const doc = parseXml(xml);
  const out: RemoteResource[] = [];
  for (const response of multistatusResponses(doc)) {
    const href = textOf(response, NS.dav, "href");
    const prop = propstatOk(response);
    if (!href || !prop) continue;
    const data = textOf(prop, NS.caldav, "calendar-data");
    if (!data) continue;
    out.push({
      href: new URL(href, baseUrl).toString(),
      etag: textOf(prop, NS.dav, "getetag")?.replace(/^W\//, "") ?? undefined,
      data,
    });
  }
  return out;
}

/** Every occurrence in one calendar overlapping [windowStart, windowEnd]. */
export async function fetchOccurrences(
  account: CalDavAccount,
  cal: CalDavCalendar,
  windowStart: Date,
  windowEnd: Date,
): Promise<EventOccurrence[]> {
  const res = await davRequest(account, cal.href, "REPORT", {
    body: timeRangeQuery(windowStart, windowEnd),
    depth: "1",
  });
  return readResources(res.text, res.url).flatMap((r) =>
    expandRemoteEvent(r.data, r.href, r.etag, cal, windowStart, windowEnd),
  );
}

/** Look up a single event by its iCal UID. Null when the calendar has no match. */
export async function fetchEventByUid(
  account: CalDavAccount,
  cal: CalDavCalendar,
  uid: string,
): Promise<UnifiedEvent | null> {
  const res = await davRequest(account, cal.href, "REPORT", { body: uidQuery(uid), depth: "1" });
  const resources = readResources(res.text, res.url);
  for (const r of resources) {
    // Expand across a wide window purely to recover the parsed UnifiedEvent;
    // we only need its fields, not its occurrences.
    const wide = expandRemoteEvent(
      r.data, r.href, r.etag, cal,
      new Date(0), new Date(8640000000000000),
    );
    if (wide[0]) return wide[0].event;
  }
  return null;
}

const ICS_HEADERS = { "Content-Type": "text/calendar; charset=utf-8" };

/**
 * Create a new event. The resource URL is the calendar href + {uid}.ics, and
 * If-None-Match: * makes the server reject a UID collision rather than
 * overwriting a stranger's event.
 */
export async function createRemoteEvent(
  account: CalDavAccount,
  cal: CalDavCalendar,
  ev: UnifiedEvent,
): Promise<{ href: string; etag: string | undefined }> {
  const href = new URL(`${encodeURIComponent(ev.id)}.ics`, cal.href.endsWith("/") ? cal.href : `${cal.href}/`).toString();
  const res = await davRequest(account, href, "PUT", {
    body: buildCalendarData(ev),
    headers: { ...ICS_HEADERS, "If-None-Match": "*" },
  });
  return { href, etag: res.etag ?? undefined };
}

/** Overwrite an existing event. Throws ConflictError (412) if it changed. */
export async function updateRemoteEvent(
  account: CalDavAccount,
  ev: UnifiedEvent,
): Promise<{ etag: string | undefined }> {
  if (!ev.href) throw new CalDavError("This event has no server address; reload the calendar and retry.");
  const res = await davRequest(account, ev.href, "PUT", {
    body: buildCalendarData(ev),
    headers: { ...ICS_HEADERS, ...(ev.etag ? { "If-Match": ev.etag } : {}) },
  });
  return { etag: res.etag ?? undefined };
}

/** Delete an event. Throws ConflictError (412) if it changed since we read it. */
export async function deleteRemoteEvent(account: CalDavAccount, ev: UnifiedEvent): Promise<void> {
  if (!ev.href) throw new CalDavError("This event has no server address; reload the calendar and retry.");
  await davRequest(account, ev.href, "DELETE", {
    headers: ev.etag ? { "If-Match": ev.etag } : {},
  });
}
