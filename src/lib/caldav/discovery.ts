// CalDAV bootstrap (RFC 6764 / RFC 4791): find the user's principal, then their
// calendar-home collection, then enumerate the calendars inside it.
//
// Run once when the user connects; the result is cached in settings so normal
// use is just event fetches. Every step issues a fresh request to the absolute
// URL the previous step returned — see davRequest for why we never rely on
// redirect-following here.

import {
  NS, ICLOUD_CALDAV_URL, CalDavError, davRequest, parseXml,
  multistatusResponses, child, textOf, hrefIn, propstatOk,
} from "./client";
import type { CalDavAccount, CalDavCalendar } from "../settings";
import { CATEGORY_COLORS } from "../../components/ui";

const PROPFIND_PRINCIPAL = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`;

const PROPFIND_HOME = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><c:calendar-home-set/></d:prop>
</d:propfind>`;

const PROPFIND_CALENDARS = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/">
  <d:prop>
    <d:resourcetype/>
    <d:displayname/>
    <d:current-user-privilege-set/>
    <a:calendar-color/>
    <c:supported-calendar-component-set/>
  </d:prop>
</d:propfind>`;

/** Deterministic fallback colour so calendars keep the same tint across runs. */
function fallbackColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return CATEGORY_COLORS[hash % CATEGORY_COLORS.length];
}

/** Apple returns colours as #RRGGBBAA; CSS wants #RRGGBB. */
function normalizeColor(raw: string | null): string | null {
  if (!raw) return null;
  const v = raw.trim();
  return /^#[0-9a-f]{8}$/i.test(v) ? v.slice(0, 7) : /^#[0-9a-f]{6}$/i.test(v) ? v : null;
}

async function findPrincipal(account: CalDavAccount, entry: string): Promise<string> {
  const res = await davRequest(account, entry, "PROPFIND", { body: PROPFIND_PRINCIPAL, depth: "0" });
  const doc = parseXml(res.text);
  for (const response of multistatusResponses(doc)) {
    const prop = propstatOk(response);
    const url = hrefIn(child(prop ?? response, NS.dav, "current-user-principal"), res.url);
    if (url) return url;
  }
  throw new CalDavError("Signed in, but the server didn't return a user principal.");
}

async function findCalendarHome(account: CalDavAccount, principalUrl: string): Promise<string> {
  const res = await davRequest(account, principalUrl, "PROPFIND", { body: PROPFIND_HOME, depth: "0" });
  const doc = parseXml(res.text);
  for (const response of multistatusResponses(doc)) {
    const prop = propstatOk(response);
    const url = hrefIn(child(prop ?? response, NS.caldav, "calendar-home-set"), res.url);
    if (url) return url;
  }
  throw new CalDavError("Could not find the calendar home for this account.");
}

async function listCollections(account: CalDavAccount, homeUrl: string): Promise<CalDavCalendar[]> {
  const res = await davRequest(account, homeUrl, "PROPFIND", { body: PROPFIND_CALENDARS, depth: "1" });
  const doc = parseXml(res.text);
  const out: CalDavCalendar[] = [];

  for (const response of multistatusResponses(doc)) {
    const rawHref = textOf(response, NS.dav, "href");
    if (!rawHref) continue;
    const href = new URL(rawHref, res.url).toString();
    if (href.replace(/\/$/, "") === homeUrl.replace(/\/$/, "")) continue; // the home itself

    const prop = propstatOk(response);
    if (!prop) continue;

    // Keep only calendar collections that can hold events (iCloud also exposes
    // VTODO-only lists for Reminders, plus inbox/outbox/notification stubs).
    const resourcetype = child(prop, NS.dav, "resourcetype");
    if (!resourcetype || resourcetype.getElementsByTagNameNS(NS.caldav, "calendar").length === 0) continue;

    const comps = Array.from(prop.getElementsByTagNameNS(NS.caldav, "comp")).map((c) =>
      (c.getAttribute("name") ?? "").toUpperCase(),
    );
    const supportsVEVENT = comps.length === 0 || comps.includes("VEVENT");
    if (!supportsVEVENT) continue;

    // No write privilege advertised => treat as read-only (e.g. subscribed
    // holiday calendars), so the UI can stop the user before the server does.
    const privileges = child(prop, NS.dav, "current-user-privilege-set");
    const readOnly = privileges
      ? privileges.getElementsByTagNameNS(NS.dav, "write-content").length === 0 &&
        privileges.getElementsByTagNameNS(NS.dav, "write").length === 0 &&
        privileges.getElementsByTagNameNS(NS.dav, "all").length === 0
      : false;

    out.push({
      id: href,
      href,
      displayName: textOf(prop, NS.dav, "displayname") || "Untitled calendar",
      color: normalizeColor(textOf(prop, NS.apple, "calendar-color")) ?? fallbackColor(href),
      visible: true,
      supportsVEVENT: true,
      readOnly,
    });
  }

  return out.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/**
 * Connect an account: verify the credentials and enumerate its calendars.
 * Returns a fully-populated account ready to store in settings. Existing
 * visibility choices are preserved across a re-discovery.
 */
export async function discoverAccount(
  account: CalDavAccount,
  previous?: CalDavCalendar[],
): Promise<CalDavAccount> {
  const entry = account.provider === "icloud" ? ICLOUD_CALDAV_URL : ICLOUD_CALDAV_URL;
  const principalUrl = await findPrincipal(account, entry);
  const calendarHomeUrl = await findCalendarHome(account, principalUrl);
  const found = await listCollections(account, calendarHomeUrl);

  if (found.length === 0) {
    throw new CalDavError("Connected, but no event calendars were found on this account.");
  }

  const calendars = found.map((cal) => {
    const prior = previous?.find((p) => p.id === cal.id);
    return prior ? { ...cal, visible: prior.visible } : cal;
  });

  return { ...account, principalUrl, calendarHomeUrl, calendars };
}
