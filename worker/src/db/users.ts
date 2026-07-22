import type { Role, SpaceMembership } from "@secondbrain/shared";

/**
 * All SQL touching identity. Routes call these; they never write queries
 * inline. Same rule the client's db.ts follows, for the same reason — one
 * place to audit, and in this codebase that audit is specifically "does every
 * query filter by the right tenant?".
 */

export interface UserRow {
  id: string;
  email: string;
  email_norm: string;
  kdf_salt: string;
  kdf_params: string;
  verifier_salt: string;
  verifier_hash: string;
  created_at: string;
  updated_at: string;
}

export async function findUserByEmail(
  db: D1Database,
  emailNorm: string,
): Promise<UserRow | null> {
  return db
    .prepare("SELECT * FROM users WHERE email_norm = ?")
    .bind(emailNorm)
    .first<UserRow>();
}

export async function findUserById(db: D1Database, id: string): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
}

export interface NewUser {
  id: string;
  email: string;
  emailNorm: string;
  kdfSalt: string;
  kdfParams: string;
  verifierSalt: string;
  verifierHash: string;
  spaceId: string;
  spaceName: string;
  now: string;
}

/**
 * Create the user, their personal space, and the owner membership as one
 * batch.
 *
 * `D1.batch()` is a single implicit transaction, which matters twice over: a
 * user with no space is unusable and invisible to every later query, and each
 * separate statement would otherwise cost its own ~105 ms round-trip to the
 * primary.
 *
 * Default lists are created here rather than by a migration because migration
 * 002 used to seed them with the fixed ids 'personal'/'work', and fixed ids
 * cannot exist once rows are per-space. This is where ensureDefaultLists'
 * "always at least one list" invariant now lives.
 */
export async function createUserWithSpace(
  db: D1Database,
  u: NewUser,
  defaultLists: { id: string; name: string; color: string }[],
): Promise<void> {
  const stmts = [
    db
      .prepare(
        `INSERT INTO users (id, email, email_norm, kdf_salt, kdf_params,
                            verifier_salt, verifier_hash, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        u.id, u.email, u.emailNorm, u.kdfSalt, u.kdfParams,
        u.verifierSalt, u.verifierHash, u.now, u.now,
      ),
    db
      .prepare("INSERT INTO spaces (id, name, created_at, updated_at) VALUES (?,?,?,?)")
      .bind(u.spaceId, u.spaceName, u.now, u.now),
    db
      .prepare(
        "INSERT INTO space_members (space_id, user_id, role, created_at) VALUES (?,?,?,?)",
      )
      .bind(u.spaceId, u.id, "owner" satisfies Role, u.now),
    ...defaultLists.map((l) =>
      db
        .prepare("INSERT INTO lists (id, space_id, name, color) VALUES (?,?,?,?)")
        .bind(l.id, u.spaceId, l.name, l.color),
    ),
  ];
  await db.batch(stmts);
}

/** The spaces a user can see, with their role in each. */
export async function listMemberships(
  db: D1Database,
  userId: string,
): Promise<SpaceMembership[]> {
  const { results } = await db
    .prepare(
      `SELECT m.space_id, s.name, m.role
       FROM space_members m
       JOIN spaces s ON s.id = m.space_id
       WHERE m.user_id = ?
       ORDER BY s.created_at`,
    )
    .bind(userId)
    .all<{ space_id: string; name: string; role: Role }>();
  return results.map((r) => ({ space_id: r.space_id, name: r.name, role: r.role }));
}
