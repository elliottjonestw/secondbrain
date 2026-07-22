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
