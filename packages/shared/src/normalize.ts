/**
 * Identity-key normalization, shared by client and Worker.
 *
 * This lives here rather than in the client because it is now enforced
 * SERVER-SIDE: with several devices writing to one database, a normalization
 * that only some clients apply is not a normalization at all. The client may
 * still call it to keep its optimistic state consistent, but the Worker's call
 * is the one that decides what is stored.
 */

/**
 * Trim and Unicode-normalize user text used as an identity key.
 *
 * macOS IMEs and pasted text can produce NFD (`e` + combining acute) where
 * typing gives NFC (single `é`). SQLite — D1 included — compares those
 * byte-wise, so without this the same-looking tag or label becomes two rows:
 * `tags(space_id, name)` is UNIQUE under binary collation.
 */
export function normalizeKey(s: string): string {
  return s.normalize("NFC").trim();
}

/**
 * The lookup key for an account, stored as `users.email_norm`.
 *
 * Lowercased as well as NFC-normalized, so `Elliott@Example.com` and
 * `elliott@example.com` are one account. The address as typed is kept
 * separately in `users.email` for display — folding case for lookup is correct,
 * but showing someone their address back in a case they did not choose is not.
 */
export function normalizeEmail(s: string): string {
  return normalizeKey(s).toLowerCase();
}
