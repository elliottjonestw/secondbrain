import {
  escapeLike,
  normalizeKey,
  queryTerms,
  type CustomFieldDef,
  type PersonCreate,
  type PersonQuery,
  type PersonRow,
  type PersonUpdate,
} from "@secondbrain/shared";
import { notFound } from "../http";

/**
 * All SQL touching `people` and `person_custom_fields`. Every statement binds
 * `space_id`.
 */

const COLUMNS = `id, full_name, given_name, family_name, additional_names,
  honorific_prefix, honorific_suffix, nickname, emails, phones, addresses,
  organization, title, birthday, urls, notes, photo, custom_fields, favorite,
  sequence, created_at, updated_at`;

// The order the INSERT/PATCH whitelist and bindings iterate. full_name first so
// createPerson can bind them positionally without repeating the list.
const WRITABLE = [
  "full_name", "given_name", "family_name", "additional_names",
  "honorific_prefix", "honorific_suffix", "nickname", "emails", "phones",
  "addresses", "organization", "title", "birthday", "urls", "notes", "photo",
  "custom_fields", "favorite",
] as const;

export async function listPeople(
  db: D1Database,
  spaceId: string,
  query: PersonQuery,
): Promise<PersonRow[]> {
  if (query.q && query.q.trim()) return searchPeople(db, spaceId, query.q);
  // Sort is client-side (favourites first, then Intl.Collator) — D1 has no ICU.
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM people WHERE space_id = ?`)
    .bind(spaceId)
    .all<PersonRow>();
  return results;
}

/**
 * LIKE search across name/nickname/org and the raw emails/phones JSON, ANDing
 * the terms. Matching the whole query as one substring would miss "Sam Acme"
 * for a Sam at Acme — the fields are separate columns. space_id is ANDed
 * outside the term groups so no term can reach another tenant.
 */
async function searchPeople(db: D1Database, spaceId: string, q: string): Promise<PersonRow[]> {
  const terms = queryTerms(q.trim());
  if (terms.length === 0) return listPeople(db, spaceId, {});
  const FIELDS = ["full_name", "nickname", "organization", "emails", "phones"];
  const clause = terms
    .map(() => `(${FIELDS.map((f) => `${f} LIKE ? ESCAPE '\\'`).join(" OR ")})`)
    .join(" AND ");
  const params = terms.flatMap((t) => FIELDS.map(() => `%${escapeLike(t)}%`));
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM people WHERE space_id = ? AND ${clause}`)
    .bind(spaceId, ...params)
    .all<PersonRow>();
  return results;
}

export async function getPerson(db: D1Database, spaceId: string, id: string): Promise<PersonRow | null> {
  return db
    .prepare(`SELECT ${COLUMNS} FROM people WHERE id = ? AND space_id = ?`)
    .bind(id, spaceId)
    .first<PersonRow>();
}

export async function createPerson(
  db: D1Database,
  spaceId: string,
  input: PersonCreate,
): Promise<PersonRow> {
  const existing = await getPerson(db, spaceId, input.id);
  if (existing) return existing; // idempotent on client id

  const now = new Date().toISOString();
  const cols = ["id", "space_id", ...WRITABLE, "sequence", "created_at", "updated_at"];
  const placeholders = cols.map(() => "?").join(",");
  const values = [
    input.id, spaceId,
    ...WRITABLE.map((c) => (input as Record<string, unknown>)[c] ?? null),
    0, now, now,
  ];
  await db
    .prepare(`INSERT INTO people (${cols.join(",")}) VALUES (${placeholders})`)
    .bind(...values)
    .run();

  const row = await getPerson(db, spaceId, input.id);
  if (!row) throw new Error("person vanished immediately after insert");
  return row;
}

export async function updatePerson(
  db: D1Database,
  spaceId: string,
  id: string,
  patch: PersonUpdate,
): Promise<PersonRow> {
  const existing = await getPerson(db, spaceId, id);
  if (!existing) throw notFound("No such person.");

  const sets: string[] = [];
  const params: unknown[] = [];
  for (const col of WRITABLE) {
    if (col in patch) {
      sets.push(`${col} = ?`);
      params.push((patch as Record<string, unknown>)[col]);
    }
  }
  sets.push("sequence = sequence + 1", "updated_at = ?");
  params.push(new Date().toISOString(), id, spaceId);

  await db
    .prepare(`UPDATE people SET ${sets.join(", ")} WHERE id = ? AND space_id = ?`)
    .bind(...params)
    .run();

  const row = await getPerson(db, spaceId, id);
  if (!row) throw notFound("No such person.");
  return row;
}

export async function deletePerson(db: D1Database, spaceId: string, id: string): Promise<void> {
  await db.prepare("DELETE FROM people WHERE id = ? AND space_id = ?").bind(id, spaceId).run();
}

// ---------------------------------------------------------------------------
// Custom-field label registry
// ---------------------------------------------------------------------------

export async function listCustomFields(db: D1Database, spaceId: string): Promise<CustomFieldDef[]> {
  const { results } = await db
    .prepare("SELECT id, label, position FROM person_custom_fields WHERE space_id = ? ORDER BY position ASC")
    .bind(spaceId)
    .all<CustomFieldDef>();
  return results;
}

/** Idempotent by label (NFC-normalized, case-insensitive) — returns the
 *  existing def or a freshly appended one. */
export async function ensureCustomField(
  db: D1Database,
  spaceId: string,
  rawLabel: string,
): Promise<CustomFieldDef> {
  const label = normalizeKey(rawLabel);
  const existing = await db
    .prepare("SELECT id, label, position FROM person_custom_fields WHERE space_id = ? AND label = ? COLLATE NOCASE")
    .bind(spaceId, label)
    .first<CustomFieldDef>();
  if (existing) return existing;

  const max = await db
    .prepare("SELECT MAX(position) AS m FROM person_custom_fields WHERE space_id = ?")
    .bind(spaceId)
    .first<{ m: number | null }>();
  const position = (max?.m ?? -1) + 1;
  const id = crypto.randomUUID();
  await db
    .prepare("INSERT INTO person_custom_fields (id, space_id, label, position) VALUES (?,?,?,?)")
    .bind(id, spaceId, label, position)
    .run();
  return { id, label, position };
}

/**
 * Delete a label and strip its value from every person that has it.
 *
 * Values are stripped FIRST, the def deleted LAST, so an interrupted call
 * leaves the def present with empty values (the editor still shows the field)
 * rather than a dangling def-less value — the same recovery ordering the local
 * version used. The per-person strips plus the delete run as one D1 batch.
 */
export async function deleteCustomFieldDef(db: D1Database, spaceId: string, id: string): Promise<void> {
  const def = await db
    .prepare("SELECT id, label, position FROM person_custom_fields WHERE id = ? AND space_id = ?")
    .bind(id, spaceId)
    .first<CustomFieldDef>();
  if (!def) return;

  const { results } = await db
    .prepare("SELECT id, custom_fields FROM people WHERE space_id = ? AND custom_fields IS NOT NULL")
    .bind(spaceId)
    .all<{ id: string; custom_fields: string }>();

  const now = new Date().toISOString();
  const stmts = [];
  for (const p of results) {
    let arr: { label: string; value: string }[];
    try {
      arr = JSON.parse(p.custom_fields);
    } catch {
      continue;
    }
    if (!Array.isArray(arr)) continue;
    const next = arr.filter((c) => c.label !== def.label);
    if (next.length !== arr.length) {
      stmts.push(
        db
          .prepare("UPDATE people SET custom_fields = ?, sequence = sequence + 1, updated_at = ? WHERE id = ? AND space_id = ?")
          .bind(next.length ? JSON.stringify(next) : null, now, p.id, spaceId),
      );
    }
  }
  stmts.push(db.prepare("DELETE FROM person_custom_fields WHERE id = ? AND space_id = ?").bind(id, spaceId));
  await db.batch(stmts);
}

export async function reorderCustomFields(db: D1Database, spaceId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.batch(
    ids.map((id, i) =>
      db
        .prepare("UPDATE person_custom_fields SET position = ? WHERE id = ? AND space_id = ?")
        .bind(i, id, spaceId),
    ),
  );
}
