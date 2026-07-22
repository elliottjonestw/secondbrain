// CalDAV transport: authenticated WebDAV requests + XML helpers.
//
// This is a *network* client, not a data-access layer, so it deliberately lives
// outside db.ts (which owns SQLite and nothing else). Every request goes through
// tauri-plugin-http's fetch, which runs in Rust and so bypasses the CORS wall
// that blocks calling other origins from the tauri:// webview. Parsing the XML
// it returns is plain DOMParser work in JS — only the network hop needs Rust.

import { httpFetch as fetch } from "../httpFetch";
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

/** Basic auth header value, UTF-8 safe (btoa alone chokes on non-Latin-1). */
function basicAuth(account: CalDavAccount): string {
  const raw = `${account.username}:${account.appPassword}`;
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
      res = await fetch(target, {
        method,
        headers,
        body: opts.body,
        maxRedirections: 0, // see the note above — we re-attach auth ourselves
        connectTimeout: 20000,
      });
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
