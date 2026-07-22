import { sign, verify } from "hono/jwt";
import { randomBytes, sha256Base64, toBase64Url } from "./crypto";
import { unauthorized } from "../http";

/**
 * Access tokens are stateless JWTs; refresh tokens are opaque random strings
 * stored hashed in D1.
 *
 * The split is what keeps the free tier viable: verifying an access token is
 * an HMAC with no database round-trip, so the ~105 ms D1 hop is paid only on
 * the refresh path (every 15 minutes) rather than on every request.
 */

/** 15 minutes. Short enough that a leaked access token expires before it's
 *  much use; long enough that refreshes are rare. */
export const ACCESS_TTL_SECONDS = 15 * 60;

/** 60 days of inactivity before a device has to sign in again. Each refresh
 *  issues a new token with a new 60-day window, so an active device never
 *  gets logged out. */
const REFRESH_TTL_SECONDS = 60 * 24 * 60 * 60;

export interface AccessClaims {
  sub: string;
  exp: number;
}

/**
 * Pinned explicitly on both sign and verify.
 *
 * Verifying with whatever algorithm the token's own header claims is the
 * classic JWT failure — it lets an attacker re-sign a token under an algorithm
 * we never intended, `none` being the worst case. Naming it here means the
 * header is checked against our expectation rather than obeyed.
 */
const JWT_ALG = "HS256" as const;

export async function signAccessToken(secret: string, userId: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ACCESS_TTL_SECONDS;
  return sign({ sub: userId, exp }, secret, JWT_ALG);
}

/** Returns the user id, or throws `unauthorized`. */
export async function verifyAccessToken(secret: string, token: string): Promise<string> {
  try {
    const claims = (await verify(token, secret, JWT_ALG)) as unknown as AccessClaims;
    if (!claims?.sub) throw new Error("no subject");
    return claims.sub;
  } catch {
    // Deliberately opaque: expired, malformed and wrong-signature are all the
    // same to a caller, and distinguishing them tells an attacker which part
    // of a forged token to fix.
    throw unauthorized("Your session has expired. Sign in again.");
  }
}

export interface IssuedRefresh {
  token: string;
  sessionId: string;
  familyId: string;
}

interface SessionRow {
  id: string;
  user_id: string;
  family_id: string;
  replaced_by: string | null;
  expires_at: string;
  revoked_at: string | null;
}

/** Issue a brand-new refresh token starting a new family (i.e. a fresh login). */
export async function createSession(
  db: D1Database,
  userId: string,
  deviceLabel: string | null,
): Promise<IssuedRefresh> {
  return insertSession(db, userId, crypto.randomUUID(), deviceLabel);
}

async function insertSession(
  db: D1Database,
  userId: string,
  familyId: string,
  deviceLabel: string | null,
): Promise<IssuedRefresh> {
  const token = toBase64Url(randomBytes(32));
  const id = crypto.randomUUID();
  const now = new Date();
  const expires = new Date(now.getTime() + REFRESH_TTL_SECONDS * 1000);

  await db
    .prepare(
      `INSERT INTO sessions (id, user_id, family_id, token_hash, device_label,
                             expires_at, created_at, last_used_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .bind(
      id, userId, familyId, await sha256Base64(token), deviceLabel,
      expires.toISOString(), now.toISOString(), now.toISOString(),
    )
    .run();

  return { token, sessionId: id, familyId };
}

/**
 * Exchange a refresh token for a new one, rotating it.
 *
 * Rotation gives theft detection for free. Each token is single-use: once
 * exchanged, its row records `replaced_by`. If a token that has already been
 * rotated is presented again, there are two copies in circulation — the
 * legitimate device and an attacker — and there is no way to tell which is
 * which. The safe response is to revoke the whole family, forcing a real
 * sign-in that the attacker cannot complete without the password.
 */
export async function rotateSession(
  db: D1Database,
  presentedToken: string,
): Promise<{ refresh: IssuedRefresh; userId: string }> {
  const hash = await sha256Base64(presentedToken);
  const row = await db
    .prepare(
      `SELECT id, user_id, family_id, replaced_by, expires_at, revoked_at
       FROM sessions WHERE token_hash = ?`,
    )
    .bind(hash)
    .first<SessionRow>();

  if (!row) throw unauthorized("Session not recognised. Sign in again.");

  if (row.replaced_by || row.revoked_at) {
    await revokeFamily(db, row.family_id);
    throw unauthorized("Session reuse detected. All sessions were signed out.");
  }

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    throw unauthorized("Your session has expired. Sign in again.");
  }

  const next = await insertSession(db, row.user_id, row.family_id, null);
  await db
    .prepare("UPDATE sessions SET replaced_by = ?, last_used_at = ? WHERE id = ?")
    .bind(next.sessionId, new Date().toISOString(), row.id)
    .run();

  return { refresh: next, userId: row.user_id };
}

export async function revokeFamily(db: D1Database, familyId: string): Promise<void> {
  await db
    .prepare("UPDATE sessions SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL")
    .bind(new Date().toISOString(), familyId)
    .run();
}

/** Sign out one device. Unknown tokens succeed silently — logout must not
 *  double as a probe for whether a token is valid. */
export async function revokeByToken(db: D1Database, presentedToken: string): Promise<void> {
  const hash = await sha256Base64(presentedToken);
  const row = await db
    .prepare("SELECT family_id FROM sessions WHERE token_hash = ?")
    .bind(hash)
    .first<{ family_id: string }>();
  if (row) await revokeFamily(db, row.family_id);
}
