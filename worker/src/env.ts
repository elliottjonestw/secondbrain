/**
 * The Worker's bindings and configuration.
 *
 * `Bindings` is what Cloudflare injects; `Variables` is what our own
 * middleware puts on the request context. Hono is typed with both so a route
 * that reads `c.get("user")` before the auth middleware has run is a compile
 * error rather than a runtime `undefined`.
 */

export interface Bindings {
  DB: D1Database;
  /**
   * Note-image bytes. D1 caps a row at 2 MB, so images can't live in a column.
   *
   * KV rather than R2: enabling R2 requires a payment method on the Cloudflare
   * account even to use its free tier, and a card on file is precisely the risk
   * we're avoiding — free-plan products fail closed with errors instead of
   * billing an overage, so an abusive spike costs availability, never money.
   * KV is included in the Workers free plan with no card. See docs/cloud-migration-plan.md §4.6.
   */
  IMAGES: KVNamespace;

  ENVIRONMENT: "development" | "staging" | "production";
  /** Comma-separated allowlist; see corsMiddleware. */
  ALLOWED_ORIGINS: string;

  /**
   * Where the web build is served from, used to build the links in reset and
   * verification emails. No trailing slash.
   *
   * It is a var rather than derived from the request's Origin header on
   * purpose: a link is minted from whatever value is here, and taking it from
   * an attacker-controllable header would let anyone have us mail a valid
   * token pointed at their own site.
   */
  APP_URL: string;
  /** `From:` on outbound mail. Must be an address on a domain verified in Resend. */
  EMAIL_FROM: string;

  /**
   * Per-user caps on the two proxy routes. Cloudflare's rate-limiting binding
   * rather than a D1 counter: this runs in-colo in about a millisecond, where
   * a D1 row would add a ~105 ms round-trip to the primary to EVERY relayed
   * CalDAV call — on a calendar refresh that is dozens of them — and burn
   * write quota doing it.
   *
   * The trade is that the counter is per-colo, so a caller spread across
   * datacentres gets the limit several times over. That is the right trade for
   * what these limits defend against: one stolen session being used as a relay
   * comes from one client in one place, and genuinely distributed abuse runs
   * into the Worker's own 100k requests/day before it matters here.
   */
  DAV_LIMIT: RateLimiter;
  QUOTE_LIMIT: RateLimiter;
  /** Outbound mail, keyed by address AND by IP — see routes/auth.ts. */
  EMAIL_LIMIT: RateLimiter;

  // Secrets — set with `wrangler secret put`, never in wrangler.toml.
  // Absent until M1; typed optional so M0 compiles without them.
  /** HMAC key for signing access-token JWTs. */
  JWT_SECRET?: string;
  /**
   * Mixed into the stored password verifier, and used to derive the decoy KDF
   * salts returned for unknown email addresses.
   *
   * Kept separate from JWT_SECRET because the two have opposite rotation
   * properties: rotating JWT_SECRET just signs everyone out, while rotating
   * this one invalidates every stored verifier — i.e. locks every account out
   * permanently. It must be set once and never changed.
   */
  AUTH_PEPPER?: string;
  /**
   * Resend API key, for reset and verification mail.
   *
   * Optional in the type because an environment can be deployed without it,
   * and the code has to behave predictably when it is: every mail-sending
   * endpoint refuses identically for every address rather than half-working.
   * See `sendEmail`.
   */
  RESEND_API_KEY?: string;
  /**
   * Cloudflare Turnstile secret, for the bot check on register and login.
   *
   * Optional in the type because an environment can run without it — and when
   * it is unset the check is skipped entirely, so a dev or staging deploy needs
   * no captcha to sign in. Its presence is what ARMS server-side enforcement
   * for browser-origin requests (see `turnstileRequired`). Set it TOGETHER with
   * the web build's `VITE_TURNSTILE_SITE_KEY`: a secret with no matching site
   * key locks web users out, because the widget that mints the token never
   * renders. The desktop app is never affected either way.
   */
  TURNSTILE_SECRET_KEY?: string;
}

/**
 * Cloudflare's rate-limiting binding. Not exported by @cloudflare/workers-types
 * at the version pinned here, so it is declared rather than imported.
 */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** Request-scoped values set by middleware. */
export interface Variables {
  requestId: string;
  /**
   * Set by `requireAuth`. Typed as always-present rather than optional so that
   * reading it in a route that forgot the middleware is a type error instead of
   * a runtime `undefined` that silently reads as "no user".
   */
  userId: string;
}

export type AppEnv = { Bindings: Bindings; Variables: Variables };

/** True only in local development. Guards anything that must never be reachable
 *  in a deployed environment — the dev seed endpoint above all. */
export function isDevelopment(env: Bindings): boolean {
  return env.ENVIRONMENT === "development";
}
