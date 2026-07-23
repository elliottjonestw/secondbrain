import { Hono } from "hono";
import type { AppEnv } from "../env";
import { badRequest } from "../http";
import { requireAuth } from "../middleware/auth";
import { enforceRateLimit } from "../rateLimit";

/**
 * A deliberately narrow proxy for Yahoo's quote endpoints.
 *
 * It exists for exactly one reason: Yahoo sends no `Access-Control-Allow-Origin`
 * header, so a browser cannot call it at all. The desktop app doesn't need this
 * — `tauri-plugin-http` runs outside the browser's origin rules — and still
 * calls Yahoo directly, so this costs Worker quota only for web clients.
 *
 * Everything about the shape here is about NOT being an open proxy:
 *
 *  - **It never accepts a URL.** The client passes a symbol or a query string;
 *    the upstream URL is built here from a constant. A `?url=` parameter would
 *    turn this into an SSRF tool and a free bandwidth relay for anyone who
 *    found it.
 *  - **It requires a session.** Without `requireAuth` this is an open relay
 *    that anyone could point at our 100k requests/day.
 *  - **It is rate-limited per user** (`QUOTE_LIMIT`). A session is not a blank
 *    cheque: authentication says who is relaying, the limit says how much. A
 *    watchlist refresh is a handful of calls, so the budget is generous and
 *    only abuse reaches it.
 *  - **The two upstream paths are fixed**, and `range`/`interval` are checked
 *    against an allowlist rather than forwarded, so the query string can't be
 *    used to smuggle anything.
 *  - **Only JSON comes back**, with upstream headers dropped. Passing Yahoo's
 *    response headers through would let it set cookies on our origin.
 *
 * Yahoo remains what CLAUDE.md says it is: undocumented, with no stability
 * guarantee. This proxy inherits that — it is not a promise the endpoint keeps
 * working, and every failure path still degrades to "Couldn't reach the
 * markets" in the card.
 */
export const quotes = new Hono<AppEnv>();

quotes.use("/quotes/*", requireAuth());

// One budget across both upstream paths — they cost the same and an attacker
// has no reason to prefer either, so splitting them would only double the
// total a stolen session can spend.
quotes.use("/quotes/*", async (c, next) => {
  await enforceRateLimit(
    c.env.QUOTE_LIMIT,
    `quotes:${c.get("userId")}`,
    "Too many market requests. Wait a moment and try again.",
  );
  await next();
});

const CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart";
const SEARCH_URL = "https://query1.finance.yahoo.com/v1/finance/search";

/** Yahoo blocks requests with no plausible user agent. */
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36";

/** Tickers only: letters, digits, and the separators Yahoo uses for
 *  exchanges and indices (`0700.HK`, `^GSPC`, `BRK-B`). Anything else can't be
 *  a symbol and has no business in a path segment. */
const SYMBOL = /^[A-Za-z0-9.^=-]{1,20}$/;

const RANGES = new Set(["1d", "5d", "1mo", "3mo", "6mo", "1y", "5y", "max"]);
const INTERVALS = new Set(["1m", "5m", "15m", "30m", "1h", "1d", "1wk", "1mo"]);

/** Fetch upstream and hand back the JSON, or a 502 the client can treat as
 *  "no quote". Never throws upstream's body or headers at the caller. */
async function passThrough(url: string): Promise<Response> {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) {
    return Response.json(
      { error: { code: "bad_gateway", message: "The quote service is unavailable." } },
      { status: 502 },
    );
  }
  const body = await res.text();
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      // Quotes are delayed anyway; a minute of shared caching takes repeated
      // watchlist loads off both Yahoo and our request budget.
      "Cache-Control": "private, max-age=60",
    },
  });
}

quotes.get("/quotes/chart/:symbol", async (c) => {
  const symbol = c.req.param("symbol");
  if (!SYMBOL.test(symbol)) throw badRequest("Not a valid symbol.");

  const url = new URL(c.req.url);
  const range = url.searchParams.get("range") ?? "1d";
  const interval = url.searchParams.get("interval") ?? "5m";
  if (!RANGES.has(range) || !INTERVALS.has(interval)) throw badRequest("Unsupported range or interval.");

  return passThrough(
    `${CHART_URL}/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`,
  );
});

quotes.get("/quotes/search", async (c) => {
  const q = new URL(c.req.url).searchParams.get("q")?.trim() ?? "";
  if (!q || q.length > 64) throw badRequest("Provide a search query.");

  const params = new URLSearchParams({ q, quotesCount: "8", newsCount: "0" });
  return passThrough(`${SEARCH_URL}?${params}`);
});
