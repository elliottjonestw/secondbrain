/**
 * Durable daily budgets (migration 0007).
 *
 * The counterpart to `rateLimit.ts`: that one stops a burst, this one stops a
 * day. They are used together on the mail path — the binding absorbs a flood
 * in the seconds it takes to arrive, and this bounds what a patient caller can
 * spend over 24 hours, which is the only thing that actually protects a
 * provider quota measured per day.
 *
 * Every function here is on a rare path by construction. Do not reach for this
 * on anything a user touches repeatedly; that is what the binding is for.
 */

/** Daily ceilings. Each sits below the free-tier limit it guards, with the
 *  headroom being the margin for the operator's own testing. */
export const QUOTA_LIMITS = {
  /**
   * All outbound Resend mail, across every endpoint and every recipient.
   *
   * The circuit breaker. Resend's free tier is ~100 messages a day; 80 leaves
   * room to still receive a reset link yourself on a day somebody is abusing
   * the sign-up form.
   */
  mailGlobal: 80,
  /** One address's share of that budget. A real person registers once, and
   *  might legitimately ask for a reset a few times in a bad afternoon. */
  mailIp: 5,
  /**
   * Note-image uploads per user per day.
   *
   * KV's free tier allows 1,000 WRITES a day — by a wide margin the tightest
   * quota in this stack, far tighter than D1's 100k row writes — and one
   * upload is one write. 200 is well past any real day of note-taking while
   * leaving the deployment room for several such users.
   */
  imageUploads: 200,
} as const;

/** UTC date, 'YYYY-MM-DD'. UTC rather than local because the Worker has no
 *  local zone and the budget being guarded (Resend's) resets on its own clock
 *  anyway — the only property that matters is that every colo agrees. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Count one use against `bucket` and report whether it stayed within `limit`.
 *
 * One upsert with `RETURNING`, so the new count comes back without a second
 * read — the same shape, and the same reasoning, as `recordFailure` in
 * `auth/throttle.ts`. Every placeholder is anonymous and every value is bound
 * positionally, repeats included: D1 rejects a statement that mixes `?` with
 * numbered `?2` forms, so today's date is passed four times rather than
 * referenced four times.
 *
 * The increment happens even when the answer is "no". That over-counts a
 * refused attempt by design: once a budget is spent the counter only has to
 * stay tripped, and the alternative — read, decide, then write — is two
 * round-trips and a race between them.
 */
export async function consumeDailyQuota(
  db: D1Database,
  bucket: string,
  limit: number,
): Promise<boolean> {
  const date = today();

  const row = await db
    .prepare(
      `INSERT INTO quota (bucket, used, window_start)
       VALUES (?, 1, ?)
       ON CONFLICT(bucket) DO UPDATE SET
         used = CASE WHEN quota.window_start < ? THEN 1 ELSE quota.used + 1 END,
         window_start = CASE WHEN quota.window_start < ? THEN ? ELSE quota.window_start END
       RETURNING used`,
    )
    .bind(bucket, date, date, date, date)
    .first<{ used: number }>();

  return (row?.used ?? Number.MAX_SAFE_INTEGER) <= limit;
}
