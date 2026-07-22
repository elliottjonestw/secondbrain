import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { badRequest } from "../http";
import { requireAuth } from "../middleware/auth";

/**
 * A CalDAV relay for the WEB build only, because iCloud sends no CORS headers
 * and CalDAV's PROPFIND/REPORT always preflight. The desktop app does not use
 * this — `tauri-plugin-http` reaches iCloud directly from Rust — so nothing
 * here is on the desktop path.
 *
 * ---------------------------------------------------------------------------
 * PRIVACY: READ THIS BEFORE EXTENDING IT
 * ---------------------------------------------------------------------------
 * Every request through here carries the user's **iCloud app-specific password**
 * in plaintext (HTTP Basic) and returns their **calendar contents**. TLS
 * terminates at this Worker, so both are visible to it in memory. That is
 * unavoidable for any proxy — a relay that could not read the traffic could not
 * forward it — and it is a deliberate, accepted trade for making connected
 * calendars work on the web.
 *
 * The properties that make it *tolerable*, all of which must be preserved:
 *
 *   - **Nothing is stored.** No logging of URLs, headers or bodies; no D1
 *     write; no KV write. The credential exists for the life of one request.
 *     `[observability]` is on in wrangler.toml, which logs *metadata* — never
 *     add a `console.log` of a request or response here, or the password lands
 *     in Cloudflare's log retention.
 *   - **It is not an open relay.** A session is required, and the upstream host
 *     must be iCloud. Without the host check this is an SSRF tool that can also
 *     reach Cloudflare's own internal metadata endpoints.
 *   - **Redirects are NOT followed here.** iCloud bounces the entry point to a
 *     per-user shard, and the client re-attaches auth per hop precisely because
 *     reqwest drops it across hosts. Following redirects in the Worker would
 *     silently forward the credential to whatever Location iCloud returned.
 *
 * Known hardening still owed (the user has accepted this for now):
 *   - No rate limit, so a compromised session can use this as a relay to iCloud.
 *   - The credential still lives in the browser's localStorage on the published
 *     origin, where any XSS on that domain reads it. The proxy does not change
 *     that, and it is the more serious of the two exposures.
 */
export const dav = new Hono<AppEnv>();

dav.use("/dav", requireAuth());

/** Only iCloud. This single check is what stops the relay being an SSRF tool. */
function isAllowedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "icloud.com" || h.endsWith(".icloud.com");
}

/** Forwarded upstream. An allowlist, so nothing else the client sets is
 *  relayed — a `Host` or `X-Forwarded-For` passthrough would be a way to
 *  confuse the upstream about who is calling. */
const FORWARD_REQUEST_HEADERS = new Set([
  "authorization", "depth", "content-type", "if-match", "if-none-match", "prefer",
]);

/** Returned to the client. Also an allowlist — relaying `set-cookie` would let
 *  iCloud set cookies scoped to our own origin. */
const RETURN_RESPONSE_HEADERS = new Set([
  "etag", "location", "content-type", "dav", "allow", "content-length",
]);

const davSchema = z.object({
  url: z.string().url(),
  // WebDAV verbs plus the ordinary ones the client uses. MKCALENDAR and friends
  // are absent because nothing in this app creates calendars.
  method: z.enum(["GET", "PUT", "DELETE", "OPTIONS", "PROPFIND", "REPORT"]),
  headers: z.record(z.string(), z.string()).optional(),
  // XML or iCalendar text. Bounded well above a realistic event; a calendar
  // object that big is a bug, not a use case.
  body: z.string().max(1_000_000).optional(),
});

dav.post("/dav", async (c) => {
  const parsed = davSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw badRequest("Expected { url, method, headers?, body? }.");
  const { url, method, headers = {}, body } = parsed.data;

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw badRequest("Not a valid URL.");
  }
  if (target.protocol !== "https:") throw badRequest("Only https is relayed.");
  if (!isAllowedHost(target.hostname)) throw badRequest("That host is not relayed.");

  const upstreamHeaders = new Headers();
  for (const [k, v] of Object.entries(headers)) {
    if (FORWARD_REQUEST_HEADERS.has(k.toLowerCase())) upstreamHeaders.set(k, v);
  }

  let res: Response;
  try {
    res = await fetch(target.toString(), {
      method,
      headers: upstreamHeaders,
      body,
      // See the note above: the client re-signs each hop itself.
      redirect: "manual",
    });
  } catch {
    // Deliberately vague, and deliberately not logging the cause — the URL can
    // name a calendar and the failure is not worth a credential in a log line.
    throw badRequest("Could not reach the calendar server.");
  }

  const out: Record<string, string> = {};
  for (const [k, v] of res.headers.entries()) {
    if (RETURN_RESPONSE_HEADERS.has(k.toLowerCase())) out[k] = v;
  }

  return c.json({ status: res.status, headers: out, body: await res.text() });
});
