import { Hono } from "hono";
import type { AppEnv } from "../env";
import { badRequest } from "../http";
import { requireAuth } from "../middleware/auth";
import { enforceRateLimit } from "../rateLimit";

/**
 * The RSS relay: fetch a feed the user subscribed to and hand back its bytes.
 *
 * This is the one route in the app that takes a URL from the client, and
 * `worker/src/routes/quotes.ts` says at length why that shape is normally
 * forbidden — a `?url=` parameter is an SSRF tool and a free bandwidth relay.
 * It is here anyway because RSS has no other shape: the whole feature is "read
 * the feed at an address I chose", so there is no symbol to pass instead.
 *
 * It is needed on BOTH platforms, which is the difference from quotes and
 * CalDAV. On the web, feeds overwhelmingly send no `Access-Control-Allow-Origin`
 * and the browser refuses before the request leaves. On the desktop the HTTP
 * plugin has no CORS problem, but every host it may reach must be listed in
 * `capabilities/default.json`, and an arbitrary subscription list is by
 * definition not a list we can write at build time. (Widening that capability
 * to `https://*` would hand any XSS in the webview a general-purpose HTTP
 * client running outside the browser's origin rules — much worse than the cost
 * of relaying.) So `rss.ts` calls this on every platform.
 *
 * What keeps it from being an open proxy:
 *
 *  - **A session is required.** Without it this is an anonymous relay pointed
 *    at our 100k requests/day.
 *  - **Per-user rate limit** (`FEED_LIMIT`). A Today page load is one request
 *    per subscribed feed, and the client caches for 30 minutes on top, so the
 *    budget is generous and only abuse reaches it.
 *  - **https only, and no credentials in the URL.** `http://` is refused
 *    outright rather than upgraded — silently changing the scheme of somebody's
 *    request is worse than failing it — and a `user:pass@` authority is
 *    rejected so this can't be used to replay credentials at a third party.
 *  - **Private and loopback addresses are refused** (see `isBlockedHost`). A
 *    Worker has no private network to pivot into, so this is defence in depth
 *    rather than the only thing standing between a caller and an internal
 *    service, but "no other reason to fetch it" makes it free to enforce.
 *  - **Redirects are followed manually, at most `MAX_HOPS`**, with every hop
 *    re-validated by the same rules. `redirect: "follow"` would let a public
 *    URL bounce to a blocked one behind our back.
 *  - **The response is capped at `MAX_BYTES`** and returned as JSON with a
 *    declared content type, not streamed through. Upstream headers are dropped
 *    entirely, so the origin can never set a cookie on ours.
 *  - **Nothing is parsed here.** Feed XML is parsed in the client with
 *    `DOMParser`, which Workers has no equivalent of and which would be a
 *    second XML implementation to keep in step. This route moves bytes.
 *
 * **Never log the URL or the body.** Observability is on, so a feed URL — which
 * can carry a private token, e.g. a paywalled or per-user feed — would land in
 * log retention. Same rule, and the same reason, as `routes/dav.ts`.
 */
export const feed = new Hono<AppEnv>();

feed.use("/feed", requireAuth());

feed.use("/feed", async (c, next) => {
  await enforceRateLimit(
    c.env.FEED_LIMIT,
    `feed:${c.get("userId")}`,
    "Too many feed requests. Wait a moment and try again.",
  );
  await next();
});

/** Enough for a large feed with full article bodies; small enough that this
 *  can't be used to move files. Truncation is treated as a failure rather than
 *  handed back half-parsed. */
const MAX_BYTES = 2 * 1024 * 1024;

/** Feed hosts redirect for ordinary reasons — apex to www, a move to a new
 *  platform, a CDN. Three hops covers those without becoming a crawler. */
const MAX_HOPS = 3;

/** Some publishers refuse a request with no user agent. */
const UA = "Sekunda/1.0 (+feed reader)";

feed.get("/feed", async (c) => {
  const raw = new URL(c.req.url).searchParams.get("url")?.trim() ?? "";
  if (!raw) throw badRequest("Provide a feed URL.");
  if (raw.length > 2048) throw badRequest("That URL is too long.");

  let target = parseFeedUrl(raw);
  let res: Response | null = null;

  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    res = await fetch(target, {
      method: "GET",
      redirect: "manual",
      headers: {
        // No `*/*`: naming what we can read is what makes a server that has
        // both HTML and a feed at one address hand back the feed.
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5",
        "User-Agent": UA,
      },
    }).catch(() => null);

    if (!res) return unavailable();

    const location = res.status >= 300 && res.status < 400 ? res.headers.get("Location") : null;
    if (!location) break;
    if (hop === MAX_HOPS) return unavailable();
    // Resolved against the current URL so a relative Location works, then put
    // through the same checks as the original — that re-validation is the
    // entire point of following redirects by hand.
    target = parseFeedUrl(new URL(location, target).toString());
  }

  if (!res || !res.ok) return unavailable();

  // Content-Length is advisory (absent on a chunked response), so it is a cheap
  // early exit, not the enforcement. The real check is on the bytes read.
  const declared = Number(res.headers.get("Content-Length") ?? "0");
  if (declared > MAX_BYTES) return tooLarge();

  const body = await res.text().catch(() => null);
  if (body === null) return unavailable();
  // Byte length, not string length: the cap is about transfer, and multi-byte
  // CJK content would otherwise sail past it at three bytes per counted char.
  if (new TextEncoder().encode(body).length > MAX_BYTES) return tooLarge();

  return Response.json(
    { content_type: res.headers.get("Content-Type") ?? "", body },
    {
      headers: {
        // Feeds update in minutes at best, and the client caches for 30 minutes
        // anyway. A few minutes of shared caching takes repeated Today loads
        // off both the publisher and our request budget.
        "Cache-Control": "private, max-age=300",
      },
    },
  );
});

/**
 * Parse and vet a candidate URL, throwing a 400 if it is one we won't fetch.
 *
 * Throws rather than returning null so every call site — the original URL and
 * each redirect hop — fails the same way without having to remember to check.
 */
function parseFeedUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest("That doesn't look like a URL.");
  }

  // No http: upgrading it silently would change the request the user asked for,
  // and relaying plaintext on their behalf is worse than saying no.
  if (url.protocol !== "https:") throw badRequest("Feed URLs must start with https://.");
  if (url.username || url.password) throw badRequest("Feed URLs can't carry credentials.");
  if (isBlockedHost(url.hostname)) throw badRequest("That address can't be fetched.");

  return url.toString();
}

/**
 * Hosts with no legitimate reason to appear in a subscription: loopback, the
 * link-local metadata address, and the RFC 1918 / RFC 4193 private ranges.
 *
 * This is a string check on the hostname, not a DNS resolution — a Worker
 * cannot resolve a name before fetching it, so a public name pointing at a
 * private address still gets through. That residual hole is why this is defence
 * in depth and not the load-bearing control: the load-bearing ones are that the
 * route is authenticated, rate-limited, and returns only a capped body with
 * upstream headers dropped, and that a Cloudflare Worker has no private network
 * of ours to reach in the first place.
 */
function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;
  // IPv6 loopback and unique-local (fc00::/7), including v4-mapped forms.
  if (host === "::1" || /^f[cd][0-9a-f]{2}:/.test(host)) return true;
  if (host.startsWith("::ffff:")) return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = v4.slice(1).map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true; // multicast and reserved
  }

  return false;
}

/** One failure shape for every upstream problem. The client's card degrades to
 *  "couldn't reach this feed" either way, and distinguishing a 404 from a
 *  timeout here would only tell a caller how our fetches behave. */
function unavailable(): Response {
  return Response.json(
    { error: { code: "bad_gateway", message: "Couldn't fetch that feed." } },
    { status: 502 },
  );
}

function tooLarge(): Response {
  return Response.json(
    { error: { code: "bad_request", message: "That feed is too large to read." } },
    { status: 400 },
  );
}
