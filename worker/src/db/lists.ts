import { normalizeKey, type ListCreate, type ListRow, type ListUpdate } from "@secondbrain/shared";
import { conflict, notFound } from "../http";

/**
 * All SQL touching `lists`. Every statement binds `space_id`; there is no query
 * here that could return another space's rows. Routes call these — they never
 * write SQL inline.
 */

/** Sorted by name in SQLite only as a stable default; the client re-sorts with
 *  Intl.Collator, which D1 (no ICU) cannot do. */
export async function listLists(db: D1Database, spaceId: string): Promise<ListRow[]> {
  const { results } = await db
    .prepare("SELECT id, name, color FROM lists WHERE space_id = ? ORDER BY name")
    .bind(spaceId)
    .all<ListRow>();
  return results;
}

export async function createList(
  db: D1Database,
  spaceId: string,
  input: ListCreate,
): Promise<ListRow> {
  // NFC-normalize server-side: macOS IMEs emit NFD, D1 compares byte-wise, and
  // a client-side-only normalization is unenforceable once several devices
  // write. This is the authoritative normalization; the index is
  // (space_id, name COLLATE NOCASE).
  const name = normalizeKey(input.name);
  // Pre-check for a readable 409 instead of a raw UNIQUE failure.
  await assertNameFree(db, spaceId, name, null);
  try {
    await db
      .prepare("INSERT INTO lists (id, space_id, name, color) VALUES (?,?,?,?)")
      .bind(input.id, spaceId, name, input.color ?? null)
      .run();
  } catch (e) {
    // A concurrent insert that beat the pre-check still lands here.
    if (isUniqueViolation(e)) throw conflict(`A list named "${name}" already exists.`);
    throw e;
  }
  return { id: input.id, name, color: input.color ?? null };
}

export async function updateList(
  db: D1Database,
  spaceId: string,
  id: string,
  patch: ListUpdate,
): Promise<ListRow> {
  const existing = await getList(db, spaceId, id);
  if (!existing) throw notFound("No such list.");

  const name = patch.name !== undefined ? normalizeKey(patch.name) : undefined;
  if (name !== undefined && name !== existing.name) {
    await assertNameFree(db, spaceId, name, id);
  }

  const next: ListRow = {
    id,
    name: name ?? existing.name,
    color: "color" in patch ? patch.color ?? null : existing.color,
  };

  try {
    await db
      .prepare("UPDATE lists SET name = ?, color = ? WHERE id = ? AND space_id = ?")
      .bind(next.name, next.color, id, spaceId)
      .run();
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict(`A list named "${next.name}" already exists.`);
    throw e;
  }
  return next;
}

/**
 * Delete a list, rehoming its todos onto another list in the same space.
 *
 * Mirrors the local app's contract: never leave a todo pointing at a list that
 * no longer exists, and never delete the last list out from under the UI (the
 * caller enforces "at least one"; this just refuses to strand todos). Done as a
 * batch so the rehome and the delete are one transaction.
 */
export async function deleteList(db: D1Database, spaceId: string, id: string): Promise<void> {
  const survivor = await db
    .prepare("SELECT id FROM lists WHERE space_id = ? AND id != ? ORDER BY name LIMIT 1")
    .bind(spaceId, id)
    .first<{ id: string }>();

  if (!survivor) throw conflict("You can't delete your only list.");

  await db.batch([
    db
      .prepare("UPDATE todos SET list_id = ? WHERE list_id = ? AND space_id = ?")
      .bind(survivor.id, id, spaceId),
    db.prepare("DELETE FROM lists WHERE id = ? AND space_id = ?").bind(id, spaceId),
  ]);
}

async function getList(db: D1Database, spaceId: string, id: string): Promise<ListRow | null> {
  return db
    .prepare("SELECT id, name, color FROM lists WHERE id = ? AND space_id = ?")
    .bind(id, spaceId)
    .first<ListRow>();
}

async function assertNameFree(
  db: D1Database,
  spaceId: string,
  name: string,
  exceptId: string | null,
): Promise<void> {
  const clash = await db
    .prepare(
      `SELECT id FROM lists
       WHERE space_id = ? AND name = ? COLLATE NOCASE ${exceptId ? "AND id != ?" : ""}`,
    )
    .bind(...(exceptId ? [spaceId, name, exceptId] : [spaceId, name]))
    .first<{ id: string }>();
  if (clash) throw conflict(`A list named "${name}" already exists.`);
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Error && /UNIQUE constraint failed/i.test(e.message);
}
