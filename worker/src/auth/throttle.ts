import { ApiError } from "../http";

/**
 * Failed-attempt throttling for the auth endpoints.
 *
 * Two buckets are checked for every attempt — the address being targeted and
 * the address it's coming from. The email bucket is what protects one account
 * from a focused campaign; the IP bucket is what stops one client working
 * through a list of addresses, which the email bucket alone would never see.
 */

/**
 * Thresholds differ by bucket kind, and the gap is the point.
 *
 * An email bucket names exactly one account, so ten failures is already well
 * past honest mistyping and locking is a favour to that account's owner. An IP
 * bucket is shared: a household behind NAT, an office, a university, a mobile
 * carrier's CGNAT can be thousands of unrelated people. Applying the strict
 * per-account number to a shared address means one person's fat fingers — or
 * one attacker deliberately failing logins — locks out every innocent user
 * behind it, which turns the protection into a denial-of-service vector.
 *
 * So the IP bucket is a backstop against sweeping many addresses, set high
 * enough that only clearly abusive volume reaches it, while the email bucket
 * does the real work of protecting an individual account.
 */
const MAX_FAILS_EMAIL = 10;
const MAX_FAILS_IP = 50;

/** Rolling window, and also how long a lock lasts once tripped. */
const WINDOW_MS = 15 * 60 * 1000;

export function emailBucket(emailNorm: string): string {
  return `email:${emailNorm}`;
}

export function ipBucket(ip: string): string {
  return `ip:${ip}`;
}

function maxFailsFor(bucket: string): number {
  return bucket.startsWith("ip:") ? MAX_FAILS_IP : MAX_FAILS_EMAIL;
}

/**
 * The caller's address, per Cloudflare.
 *
 * `CF-Connecting-IP` is set by the edge and cannot be spoofed by the client;
 * `X-Forwarded-For` can be, so it is deliberately not consulted. The fallback
 * only applies to local development, where the header is absent.
 */
export function clientIp(req: Request): string {
  return req.headers.get("CF-Connecting-IP") ?? "local";
}

interface ThrottleRow {
  fails: number;
  window_start: string;
  locked_until: string | null;
}

/** Throws 429 if any bucket is currently locked. Call before doing any work. */
export async function assertNotLocked(db: D1Database, buckets: string[]): Promise<void> {
  const placeholders = buckets.map(() => "?").join(",");
  const { results } = await db
    .prepare(
      `SELECT locked_until FROM auth_throttle
       WHERE bucket IN (${placeholders}) AND locked_until IS NOT NULL`,
    )
    .bind(...buckets)
    .all<{ locked_until: string }>();

  const now = Date.now();
  const soonest = results
    .map((r) => new Date(r.locked_until).getTime())
    .filter((t) => t > now)
    .sort((a, b) => a - b)[0];

  if (soonest) {
    const mins = Math.max(1, Math.ceil((soonest - now) / 60000));
    throw new ApiError(
      "rate_limited",
      `Too many attempts. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`,
    );
  }
}

/**
 * Record a failure against each bucket, locking any that cross the threshold.
 *
 * One upsert per bucket with `RETURNING`, so the count comes back without a
 * second read — at ~105 ms per D1 round-trip, read-then-write would double the
 * cost of the path an attacker is trying to spam.
 */
export async function recordFailure(db: D1Database, buckets: string[]): Promise<void> {
  const now = new Date();
  const nowIso = now.toISOString();
  const cutoff = new Date(now.getTime() - WINDOW_MS).toISOString();
  const lockUntil = new Date(now.getTime() + WINDOW_MS).toISOString();

  for (const bucket of buckets) {
    // A window that has aged out resets the counter rather than continuing it,
    // so occasional typos over weeks never accumulate into a lockout.
    // Every placeholder is anonymous and every value is bound positionally,
    // repeats included. D1 rejects a statement that mixes `?` with numbered
    // `?2` forms ("Wrong number of parameter bindings"), so the cutoff is
    // passed twice rather than referenced twice.
    const row = await db
      .prepare(
        `INSERT INTO auth_throttle (bucket, fails, window_start)
         VALUES (?, 1, ?)
         ON CONFLICT(bucket) DO UPDATE SET
           fails = CASE WHEN auth_throttle.window_start < ? THEN 1
                        ELSE auth_throttle.fails + 1 END,
           window_start = CASE WHEN auth_throttle.window_start < ? THEN ?
                              ELSE auth_throttle.window_start END
         RETURNING fails, window_start, locked_until`,
      )
      .bind(bucket, nowIso, cutoff, cutoff, nowIso)
      .first<ThrottleRow>();

    if (row && row.fails >= maxFailsFor(bucket)) {
      await db
        .prepare("UPDATE auth_throttle SET locked_until = ? WHERE bucket = ?")
        .bind(lockUntil, bucket)
        .run();
    }
  }
}

/** Clear a bucket after a genuine success. */
export async function clearBucket(db: D1Database, bucket: string): Promise<void> {
  await db.prepare("DELETE FROM auth_throttle WHERE bucket = ?").bind(bucket).run();
}
