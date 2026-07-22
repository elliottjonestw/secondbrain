import {
  normalizeKey,
  type ItemType,
  type LinkCreate,
  type LinkRow,
  type TagRow,
} from "@secondbrain/shared";

/**
 * All SQL touching `tags`, `item_tags` and `links` — the connective tissue that
 * joins the domains. Every statement binds `space_id`.
 *
 * These key items by (item_type, item_id) strings, so a note's tags and links
 * live here in D1 even while the note ROW is still local (until M4): the join
 * tables never dereference the id, they only store it.
 */

export async function listTags(db: D1Database, spaceId: string): Promise<TagRow[]> {
  const { results } = await db
    .prepare("SELECT id, name FROM tags WHERE space_id = ?")
    .bind(spaceId)
    .all<TagRow>();
  return results; // client sorts with Intl.Collator
}

/** Idempotent by NFC-normalized name (unique per space) — returns existing or
 *  freshly created. Same shape as ensureCustomField. */
export async function ensureTag(db: D1Database, spaceId: string, rawName: string): Promise<TagRow> {
  const name = normalizeKey(rawName);
  const existing = await db
    .prepare("SELECT id, name FROM tags WHERE space_id = ? AND name = ?")
    .bind(spaceId, name)
    .first<TagRow>();
  if (existing) return existing;

  const id = crypto.randomUUID();
  try {
    await db.prepare("INSERT INTO tags (id, space_id, name) VALUES (?,?,?)").bind(id, spaceId, name).run();
  } catch (e) {
    // A concurrent insert of the same name: re-read the winner.
    if (e instanceof Error && /UNIQUE constraint failed/i.test(e.message)) {
      const row = await db
        .prepare("SELECT id, name FROM tags WHERE space_id = ? AND name = ?")
        .bind(spaceId, name)
        .first<TagRow>();
      if (row) return row;
    }
    throw e;
  }
  return { id, name };
}

/** Ensure the tag exists, then attach it to the item (idempotent). */
export async function tagItem(
  db: D1Database,
  spaceId: string,
  type: ItemType,
  itemId: string,
  rawName: string,
): Promise<TagRow> {
  const tag = await ensureTag(db, spaceId, rawName);
  await db
    .prepare(
      `INSERT OR IGNORE INTO item_tags (tag_id, space_id, item_type, item_id, created_at)
       VALUES (?,?,?,?,?)`,
    )
    .bind(tag.id, spaceId, type, itemId, new Date().toISOString())
    .run();
  return tag;
}

export async function untagItem(
  db: D1Database,
  spaceId: string,
  type: ItemType,
  itemId: string,
  tagId: string,
): Promise<void> {
  await db
    .prepare("DELETE FROM item_tags WHERE space_id = ? AND tag_id = ? AND item_type = ? AND item_id = ?")
    .bind(spaceId, tagId, type, itemId)
    .run();
}

export async function tagsForItem(
  db: D1Database,
  spaceId: string,
  type: ItemType,
  itemId: string,
): Promise<TagRow[]> {
  const { results } = await db
    .prepare(
      `SELECT t.id, t.name FROM tags t
       JOIN item_tags it ON it.tag_id = t.id
       WHERE it.space_id = ? AND it.item_type = ? AND it.item_id = ?`,
    )
    .bind(spaceId, type, itemId)
    .all<TagRow>();
  return results;
}

/** Item ids of a given type carrying a tag (by name). Powers the assistant's
 *  `tag:` filters. */
export async function itemIdsForTag(
  db: D1Database,
  spaceId: string,
  type: ItemType,
  tagName: string,
): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT it.item_id FROM item_tags it
       JOIN tags t ON t.id = it.tag_id
       WHERE it.space_id = ? AND it.item_type = ? AND t.name = ?`,
    )
    .bind(spaceId, type, normalizeKey(tagName))
    .all<{ item_id: string }>();
  return results.map((r) => r.item_id);
}

export async function createLink(db: D1Database, spaceId: string, input: LinkCreate): Promise<LinkRow> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO links (id, space_id, source_type, source_id, target_type, target_id, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .bind(id, spaceId, input.source_type, input.source_id, input.target_type, input.target_id, now)
    .run();
  return { id, ...input, created_at: now };
}

export async function deleteLink(db: D1Database, spaceId: string, id: string): Promise<void> {
  await db.prepare("DELETE FROM links WHERE id = ? AND space_id = ?").bind(id, spaceId).run();
}

/** All links touching an item, from either direction. */
export async function linksForItem(
  db: D1Database,
  spaceId: string,
  type: ItemType,
  id: string,
): Promise<LinkRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, source_type, source_id, target_type, target_id, created_at
       FROM links
       WHERE space_id = ?
         AND ((source_type = ? AND source_id = ?) OR (target_type = ? AND target_id = ?))`,
    )
    .bind(spaceId, type, id, type, id)
    .all<LinkRow>();
  return results;
}

/**
 * Remove every tag and link touching an item — called when the item is deleted.
 * Works for any type, including notes (whose row is local but whose relations
 * live here). One batch, so a delete can't half-succeed.
 */
export async function removeItemRelations(
  db: D1Database,
  spaceId: string,
  type: ItemType,
  id: string,
): Promise<void> {
  await db.batch([
    db
      .prepare("DELETE FROM item_tags WHERE space_id = ? AND item_type = ? AND item_id = ?")
      .bind(spaceId, type, id),
    db
      .prepare(
        `DELETE FROM links WHERE space_id = ?
           AND ((source_type = ? AND source_id = ?) OR (target_type = ? AND target_id = ?))`,
      )
      .bind(spaceId, type, id, type, id),
  ]);
}
