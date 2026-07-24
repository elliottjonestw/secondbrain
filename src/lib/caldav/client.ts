// CalDAV transport: authenticated WebDAV requests + XML helpers.
//
// This is a *network* client, not a data-access layer, so it deliberately lives
// outside db.ts. Parsing the XML is plain DOMParser work in JS — only the
// network hop needs help, and it needs a different kind on each platform:
//
//   * In the app, tauri-plugin-http's fetch runs in Rust and so bypasses the
//     CORS wall that blocks calling other origins from the tauri:// webview.
//     iCloud is reached DIRECTLY; nothing touches our server.
//   * On the web that's impossible — iCloud sends no CORS headers and
//     PROPFIND/REPORT always preflight — so requests are relayed through the
//     Worker's /v1/dav route.
//
// The relay means the user's app-specific password and calendar contents pass
// through our Worker in plaintext. That is a real privacy cost, accepted
// deliberately so connected calendars work on the web; worker/src/routes/dav.ts
// documents what keeps it tolerable and what hardening is still owed. The
// desktop path is unaffected and still talks to Apple directly.

import { httpFetch } from "../httpFetch";
import { isTauri } from "../platform";
import { apiRequest } from "../api";
import { getCalDavPassword } from "../secrets";
import type { CalDavAccount } from "../settings";

export const NS = {
  dav: "DAV:",
  caldav: "urn:ietf:params:xml:ns:caldav",
  apple: "http://apple.com/ns/ical/",
} as const;

/** Where iCloud CalDAV discovery starts (it redirects to a per-user shard). */
export const ICLOUD_CALDAV_URL = "https://caldav.icloud.com/";

export class CalDavError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "CalDavError";
  }
}

/** Thrown on 412 — the resource changed on the server since we read it. */
export class ConflictError extends CalDavError {
  constructor(message = "This event was changed elsewhere. Reload and try again.") {
    super(message, 412);
    this.name = "ConflictError";
  }
}

/**
 * Basic auth header value, UTF-8 safe (btoa alone chokes on non-Latin-1).
 *
 * The password is read from `secrets.ts` rather than taken off the account,
 * which is what keeps `CalDavAccount` credential-free everywhere else. An empty
 * one produces a header iCloud rejects with a 401 — the same outcome as a wrong
 * password, and the same thing the user has to do about it.
 */
function basicAuth(account: CalDavAccount): string {
  const raw = `${account.username}:${getCalDavPassword()}`;
  const bytes = new TextEncoder().encode(raw);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `Basic ${btoa(bin)}`;
}

export interface DavResponse {
  status: number;
  text: string;
  etag: string | null;
  url: string; // the URL that finally served the request (after redirects)
}

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const MAX_MANUAL_REDIRECTS = 5;

/** Statuses the Response constructor refuses to pair with a body. DELETE
 *  returns 204, so reconstructing a proxied response without this throws. */
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

/**
 * One WebDAV hop, by whichever route this platform has.
 *
 * The web path rebuilds a real `Response` from the relay's JSON envelope, so
 * the redirect loop below is identical on both platforms — it reads `.status`,
 * `.headers.get()` and `.text()` and cannot tell which transport answered.
 *
 * A JSON envelope rather than proxying the verb itself: sending PROPFIND to our
 * own Worker from a browser would need the method in the CORS preflight
 * allowlist, and the bodies are small XML/iCalendar text either way.
 */
async function davFetch(
  target: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<Response> {
  if (isTauri()) {
    return httpFetch(target, {
      method,
      headers,
      body,
      maxRedirections: 0, // see the note below — we re-attach auth ourselves
      connectTimeout: 20000,
    });
  }

  const relayed = await apiRequest<{
    status: number;
    headers: Record<string, string>;
    body: string;
  }>("/v1/dav", { method: "POST", body: { url: target, method, headers, body } });

  return new Response(
    NULL_BODY_STATUS.has(relayed.status) ? null : relayed.body,
    { status: relayed.status, headers: relayed.headers },
  );
}

/**
 * Issue an authenticated WebDAV request.
 *
 * Redirects are followed *by hand* (maxRedirections: 0) because reqwest — which
 * backs tauri-plugin-http — strips the Authorization header when a redirect
 * crosses to a different host. iCloud always redirects the well-known entry
 * point to a per-user shard (pNN-caldav.icloud.com), so letting it auto-follow
 * silently produces a 401. Re-attaching auth on each hop is the whole fix.
 */
export async function davRequest(
  account: CalDavAccount,
  url: string,
  method: string,
  opts: { body?: string; depth?: "0" | "1"; headers?: Record<string, string> } = {},
): Promise<DavResponse> {
  let target = url;

  for (let hop = 0; hop <= MAX_MANUAL_REDIRECTS; hop++) {
    const headers: Record<string, string> = {
      Authorization: basicAuth(account),
      ...(opts.depth ? { Depth: opts.depth } : {}),
      ...(opts.body ? { "Content-Type": "application/xml; charset=utf-8" } : {}),
      ...opts.headers,
    };

    let res: Response;
    try {
      res = await davFetch(target, method, headers, opts.body);
    } catch (e) {
      throw new CalDavError(
        `Could not reach the calendar server. Check your connection. (${e instanceof Error ? e.message : String(e)})`,
      );
    }

    if (REDIRECT_CODES.has(res.status)) {
      const location = res.headers.get("location");
      if (!location) throw new CalDavError(`Server redirected without a Location header.`, res.status);
      target = new URL(location, target).toString();
      continue;
    }

    const text = await res.text();

    if (res.status === 401 || res.status === 403) {
      throw new CalDavError(
        "Sign-in was rejected. Check your Apple ID and make sure the password is an app-specific password.",
        res.status,
      );
    }
    if (res.status === 412) throw new ConflictError();
    if (!res.ok && res.status !== 207) {
      throw new CalDavError(`Calendar server error (${res.status}). ${text.slice(0, 200)}`, res.status);
    }

    return { status: res.status, text, etag: res.headers.get("etag"), url: target };
  }

  throw new CalDavError("Too many redirects from the calendar server.");
}

// --- XML helpers -----------------------------------------------------------

export function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    throw new CalDavError("The calendar server returned a response we couldn't parse.");
  }
  return doc;
}

/** Every <response> element of a 207 Multi-Status document. */
export function multistatusResponses(doc: Document): Element[] {
  return Array.from(doc.getElementsByTagNameNS(NS.dav, "response"));
}

/** First descendant with the given namespace + local name, or null. */
export function child(el: Element | Document, ns: string, name: string): Element | null {
  return el.getElementsByTagNameNS(ns, name)[0] ?? null;
}

/** Trimmed text of the first matching descendant, or null. */
export function textOf(el: Element | Document, ns: string, name: string): string | null {
  const found = child(el, ns, name);
  const value = found?.textContent?.trim();
  return value ? value : null;
}

/**
 * The <href> inside a property, resolved to an absolute URL against the request
 * URL. CalDAV servers return site-relative paths like /1234/calendars/home/.
 */
export function hrefIn(el: Element | null, baseUrl: string): string | null {
  if (!el) return null;
  const href = textOf(el, NS.dav, "href");
  return href ? new URL(href, baseUrl).toString() : null;
}

/**
 * Whether a <response> reports a successful status for its properties. Servers
 * return 404 propstats alongside 200 ones; we only trust the 200 block.
 */
export function propstatOk(response: Element): Element | null {
  for (const ps of Array.from(response.getElementsByTagNameNS(NS.dav, "propstat"))) {
    const status = textOf(ps, NS.dav, "status") ?? "";
    if (/\s20\d\s/.test(status)) return child(ps, NS.dav, "prop");
  }
  return null;
}
