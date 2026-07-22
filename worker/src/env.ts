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
  /** Note-image bytes. D1 caps a row at 2 MB, so images can't live in a column. */
  IMAGES: R2Bucket;

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
