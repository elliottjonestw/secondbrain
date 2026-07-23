import type { RateLimiter } from "./env";
import { ApiError } from "./http";

/**
 * Per-caller caps on the routes that reach out to somebody else's server.
 *
 * `auth_throttle` (migration 0002) is the other limiter in this codebase and
 * they answer different questions. That one counts *failures* against an
 * account and locks it, which needs durable, globally-consistent state and is
 * worth a D1 round-trip because it runs at most once per sign-in. This one
 * counts *successes* on hot paths — a calendar refresh is dozens of relayed
 * requests — where a ~105 ms hop to D1 per call would be the dominant cost of
 * the feature, so it uses Cloudflare's in-colo limiter instead.
 *
 * Keys are always scoped by user id. Keying by IP would punish everyone behind
 * one NAT for one person's traffic, and these routes are authenticated anyway,
 * so the identity we actually care about is available.
 */

/**
 * Consume one unit, or throw 429.
 *
 * The message names the resource rather than the limit. Telling a caller the
 * exact budget and window is telling an abusive one precisely how to pace
 * itself, and an honest user hitting this is looking at a bug, not a quota
 * they can plan around.
 */
export async function enforceRateLimit(
  limiter: RateLimiter | undefined,
  key: string,
  message: string,
): Promise<void> {
  // A missing binding is a deployment fault, not a request fault — same
  // treatment the auth secrets get. Failing open here would silently leave the
  // relay unlimited, which is the exact condition this exists to remove.
  if (!limiter) throw new Error("Rate limit binding is not configured for this environment");

  const { success } = await limiter.limit({ key });
  if (!success) throw new ApiError("rate_limited", message);
}
