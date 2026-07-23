import { clearSpaceData } from "./backup";

/**
 * Deleting an account, permanently.
 *
 * The hard part is not the user row, it is deciding what happens to the spaces
 * they belong to. A space is a container that can outlive any one member once
 * sharing lands, so the rule is:
 *
 *   - a space where this user is the ONLY member is deleted outright, contents
 *     and all — nobody is left who could ever reach it, so keeping it is just
 *     an orphan holding personal data;
 *   - a space with other members loses this user's membership and nothing else.
 *     Their rows stay, because those rows are the space's, not theirs, and
 *     silently deleting a shared calendar because one person left would be a
 *     data-loss bug wearing a privacy hat.
 *
 * Today every account has exactly one space with exactly one member, so only
 * the first branch ever runs. The second exists because getting it wrong later
 * is unrecoverable, and the cost of writing it now is one COUNT.
 */

/**
 * Delete everything belonging to `userId`, returning the KV blob keys the
 * caller must purge.
 *
 * KV is not part of a D1 batch and cannot be rolled back, so the bytes are
 * deleted AFTER the rows commit, and the keys are returned rather than deleted
 * here — the same contract `clearSpaceData` and `deleteNote` already use.
 * Ordering it this way means the worst failure leaves unreferenced bytes in KV
 * (invisible, and reclaimable) rather than live rows pointing at bytes that no
 * longer exist.
 */
export async function deleteAccount(db: D1Database, userId: string): Promise<string[]> {
  const { results: memberships } = await db
    .prepare(
      `SELECT m.space_id,
              (SELECT COUNT(*) FROM space_members o WHERE o.space_id = m.space_id) AS members
         FROM space_members m
        WHERE m.user_id = ?`,
    )
    .bind(userId)
    .all<{ space_id: string; members: number }>();

  const soleSpaces = memberships.filter((m) => m.members <= 1).map((m) => m.space_id);

  // Content first, space by space. `clearSpaceData` is already the audited
  // "delete every domain row in this space" statement list — reimplementing the
  // table walk here is how one table gets forgotten when a twelfth is added.
  const blobKeys: string[] = [];
  for (const spaceId of soleSpaces) {
    blobKeys.push(...(await clearSpaceData(db, spaceId)));
  }

  // Then identity, in one batch so an account can never end up half-deleted —
  // a user row without memberships is unusable, and memberships without a user
  // are unreachable rows nobody will ever notice.
  await db.batch([
    ...soleSpaces.map((id) => db.prepare("DELETE FROM spaces WHERE id = ?").bind(id)),
    db.prepare("DELETE FROM space_members WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM password_resets WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM email_verifications WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM users WHERE id = ?").bind(userId),
  ]);

  return blobKeys;
}
