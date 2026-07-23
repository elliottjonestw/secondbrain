import { randomBytes, sha256Base64, toBase64Url } from "../auth/crypto";

/**
 * All SQL for password reset and email verification.
 *
 * These tables are keyed by `user_id`, not `space_id` — they are identity, not
 * domain data, so the "every query filters by space" rule doesn't apply here
 * any more than it does to `users` or `sessions`. What replaces it is that
 * every lookup is by the token *hash*, which is unguessable: there is no
 * endpoint that takes a user id and returns a token.
 */

/** 30 minutes. Long enough to walk to another device, short enough that a
 *  link left in a mailbox is not a standing key to the account. */
const RESET_TTL_MS = 30 * 60 * 1000;

/** 24 hours. Verification is not urgent and a same-day click is realistic. */
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

/** 32 bytes, URL-safe. The same size and shape as a refresh token, because it
 *  is the same kind of thing: a bearer secret that grants account access. */
function newToken(): string {
  return toBase64Url(randomBytes(32));
}

/**
 * Mint a reset token, invalidating any the user already has.
 *
 * Superseding old tokens is what makes "I clicked the button three times"
 * behave: only the newest link works, so a stale one found later in a mailbox
 * is dead. It also keeps the table from growing per request, which is why
 * there is no cleanup job.
 */
export async function issuePasswordReset(db: D1Database, userId: string): Promise<string> {
  const token = newToken();
  const now = new Date();

  await db.batch([
    db.prepare("DELETE FROM password_resets WHERE user_id = ?").bind(userId),
    db
      .prepare(
        `INSERT INTO password_resets (token_hash, user_id, expires_at, created_at)
         VALUES (?,?,?,?)`,
      )
      .bind(
        await sha256Base64(token),
        userId,
        new Date(now.getTime() + RESET_TTL_MS).toISOString(),
        now.toISOString(),
      ),
  ]);

  return token;
}

/**
 * Redeem a reset token, returning the user it belongs to.
 *
 * `null` for every failure — unknown, expired, already used. The caller turns
 * all three into one message: distinguishing them tells someone holding a
 * stolen link whether it is worth hunting for a fresher one, and tells anyone
 * probing random tokens when they have found a real user.
 *
 * Marking the row used is conditional in SQL rather than checked in TS, so two
 * requests racing on the same token cannot both win: the second UPDATE matches
 * no rows.
 */
export async function consumePasswordReset(
  db: D1Database,
  token: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `UPDATE password_resets SET used_at = ?
        WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
        RETURNING user_id`,
    )
    .bind(new Date().toISOString(), await sha256Base64(token), new Date().toISOString())
    .first<{ user_id: string }>();

  return row?.user_id ?? null;
}

/**
 * Replace the account's credential material and sign every device out.
 *
 * The three KDF columns move together. `kdf_salt` is new because reusing the
 * old one would let anyone who had recorded a previous derived key replay it
 * against the new verifier; `kdf_params` is refreshed because a password
 * change is the only moment the work factor can be raised without locking the
 * account out.
 *
 * Revoking sessions is not housekeeping — it is most of the point. A reset is
 * what someone does when they think their password is known, and leaving the
 * attacker's existing refresh token alive would make the reset cosmetic. One
 * batch, so a partial failure cannot leave new credentials with old sessions
 * still valid.
 */
export async function applyNewPassword(
  db: D1Database,
  userId: string,
  next: { kdfSalt: string; kdfParams: string; verifierSalt: string; verifierHash: string },
): Promise<void> {
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        `UPDATE users SET kdf_salt = ?, kdf_params = ?, verifier_salt = ?,
                          verifier_hash = ?, updated_at = ?
          WHERE id = ?`,
      )
      .bind(next.kdfSalt, next.kdfParams, next.verifierSalt, next.verifierHash, now, userId),
    db
      .prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
      .bind(now, userId),
    // Any other outstanding link for this account dies with the password it
    // was issued against.
    db.prepare("DELETE FROM password_resets WHERE user_id = ?").bind(userId),
  ]);
}

export async function issueEmailVerification(
  db: D1Database,
  userId: string,
  emailNorm: string,
): Promise<string> {
  const token = newToken();
  const now = new Date();

  await db.batch([
    db.prepare("DELETE FROM email_verifications WHERE user_id = ?").bind(userId),
    db
      .prepare(
        `INSERT INTO email_verifications (token_hash, user_id, email_norm, expires_at, created_at)
         VALUES (?,?,?,?,?)`,
      )
      .bind(
        await sha256Base64(token),
        userId,
        emailNorm,
        new Date(now.getTime() + VERIFY_TTL_MS).toISOString(),
        now.toISOString(),
      ),
  ]);

  return token;
}

/**
 * Redeem a verification token. `false` for every failure, as above.
 *
 * The stored `email_norm` is compared against the account's current address, so
 * a link mailed to an old address cannot confirm a new one — the check is one
 * extra predicate and the alternative is a silently wrong "verified" badge.
 */
export async function consumeEmailVerification(
  db: D1Database,
  token: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  const row = await db
    .prepare(
      `UPDATE email_verifications SET used_at = ?
        WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
        RETURNING user_id, email_norm`,
    )
    .bind(now, await sha256Base64(token), now)
    .first<{ user_id: string; email_norm: string }>();

  if (!row) return false;

  // COALESCE, not a plain assignment: re-confirming an address that is already
  // verified must succeed (the caller asked "is this address confirmed?", and
  // it is) without rewriting the original timestamp. Matching on `email_norm`
  // in the WHERE is what makes a `null` row mean "the address changed since
  // this link was mailed" rather than "already done".
  const updated = await db
    .prepare(
      `UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?), updated_at = ?
        WHERE id = ? AND email_norm = ?
        RETURNING id`,
    )
    .bind(now, now, row.user_id, row.email_norm)
    .first<{ id: string }>();

  return updated !== null;
}
