import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";
import { unauthorized } from "../http";
import { verifyAccessToken } from "../auth/tokens";

/**
 * Resolve `Authorization: Bearer <access token>` into `c.get("userId")`.
 *
 * Verification is a local HMAC with no database round-trip, which is what
 * makes it affordable to put on every request: at ~105 ms per D1 hop, a
 * session lookup per request would dominate the entire API's latency.
 *
 * This establishes *who* the caller is and nothing more. What they may reach
 * is a separate question answered by `authorize()` against `space_members`,
 * which arrives with the first domain endpoints in M2. Keeping the two apart
 * is deliberate: identity is cheap and stateless, authorization is neither,
 * and conflating them is how a permission check ends up skipped on the one
 * endpoint nobody thought about.
 */
export function requireAuth(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header("Authorization") ?? "";
    const [scheme, token] = header.split(" ");

    if (scheme?.toLowerCase() !== "bearer" || !token) {
      throw unauthorized("Sign in to continue.");
    }

    const secret = c.env.JWT_SECRET;
    if (!secret) throw new Error("JWT_SECRET is not configured for this environment");

    c.set("userId", await verifyAccessToken(secret, token));
    await next();
  };
}
