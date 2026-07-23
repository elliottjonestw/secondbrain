import { CLOUD_SETTING_KEYS, type CloudSettingKey, type CloudSettingsPatch } from "@secondbrain/shared";

/**
 * All SQL touching `space_settings` — the handful of settings that follow the
 * account instead of the device (Settings → Widgets).
 *
 * Every statement binds `space_id`, like every other db module here. The extra
 * rule this one carries is the KEY allowlist: nothing outside
 * `CLOUD_SETTING_KEYS` is ever read or written, which is what keeps the OpenAI
 * key and the iCloud password off the server no matter what a client sends.
 * The route validates too; this is the second lock on the same door, because
 * the cost of it being wrong is a secret in someone else's database.
 *
 * Values are opaque JSON strings. The Worker never parses them — it has no
 * reason to know what a watchlist looks like, and not knowing is what lets a
 * widget gain a field without a deploy.
 */

export type CloudSettings = Partial<Record<CloudSettingKey, unknown>>;

/** Everything stored for this space, as a plain object ready to serialize. */
export async function getSpaceSettings(db: D1Database, spaceId: string): Promise<CloudSettings> {
  const { results } = await db
    .prepare("SELECT key, value FROM space_settings WHERE space_id = ?")
    .bind(spaceId)
    .all<{ key: string; value: string }>();

  const out: CloudSettings = {};
  for (const row of results) {
    // A key that has since left the allowlist stays in the table but stops
    // being served — retiring a setting must not need a migration, and a row
    // nobody reads is harmless.
    if (!isCloudKey(row.key)) continue;
    try {
      out[row.key] = JSON.parse(row.value);
    } catch {
      // Corrupt JSON is treated as absent rather than fatal: one bad row must
      // not take down the whole settings read and with it the Widgets pane.
    }
  }
  return out;
}

/**
 * Apply a partial write, returning the full settings afterwards.
 *
 * Only the keys present are touched — this is a patch, not a replace, so two
 * devices changing different settings don't undo each other. An explicit
 * `null` deletes the key, which is how "no weather location" is expressed:
 * storing `null` would be indistinguishable from it, but deleting lets a fresh
 * client fall back to its own default.
 */
export async function updateSpaceSettings(
  db: D1Database,
  spaceId: string,
  patch: CloudSettingsPatch,
): Promise<CloudSettings> {
  const now = new Date().toISOString();
  const statements = [];

  for (const [key, value] of Object.entries(patch)) {
    if (!isCloudKey(key)) continue; // belt and braces; the route rejects these
    statements.push(
      value === null
        ? db
            .prepare("DELETE FROM space_settings WHERE space_id = ? AND key = ?")
            .bind(spaceId, key)
        : db
            .prepare(
              `INSERT INTO space_settings (space_id, key, value, updated_at)
               VALUES (?,?,?,?)
               ON CONFLICT(space_id, key) DO UPDATE SET value = excluded.value,
                                                        updated_at = excluded.updated_at`,
            )
            .bind(spaceId, key, JSON.stringify(value), now),
    );
  }

  // One batch, not a loop: each D1 statement is a ~105 ms round-trip to the
  // primary, and saving the Widgets pane touches several keys at once.
  if (statements.length) await db.batch(statements);

  return getSpaceSettings(db, spaceId);
}

function isCloudKey(key: string): key is CloudSettingKey {
  return (CLOUD_SETTING_KEYS as readonly string[]).includes(key);
}
