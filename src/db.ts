// Data access layer. All business logic lives here in TypeScript, calling
// SQLite through tauri-plugin-sql. This is the ONLY module that touches the DB,
// which keeps the app portable to a plain browser build later (swap this file's
// backend without touching the UI).

import Database from "@tauri-apps/plugin-sql";
import { v4 as uuid } from "uuid";
import type {
  EventRow,
  ReminderRow,
  TodoRow,
  NoteRow,
  ListRow,
  TagRow,
  LinkRow,
  PersonRow,
  PersonCustomField,
  ItemType,
} from "./types";

let _db: Database | null = null;

/** Lazily open the DB. Migrations run automatically on first load. */
export async function db(): Promise<Database> {
  if (!_db) {
    _db = await Database.load("sqlite:secondbrain.db");
  }
  return _db;
}

export function newId(): string {
  return uuid();
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Trim and Unicode-normalize user text used as an identity key.
 *
 * macOS IMEs and pasted text can produce NFD (`e` + combining acute) where
 * typing gives NFC (single `é`). SQLite compares those byte-wise, so without
 * this the same-looking tag or label becomes two rows — `tags.name` is UNIQUE
 * under binary collation, and ensureTag matches exactly.
 */
export function normalizeKey(s: string): string {
  return s.normalize("NFC").trim();
}

/**
 * Locale-aware sort for display lists.
 *
 * SQLite has no COLLATE UNICODE without the ICU extension (not compiled in), so
 * `ORDER BY name` is code-point order and COLLATE NOCASE folds ASCII only —
 * which puts "Ärzte" after "Zebra" and sorts Chinese by codepoint. Sorting in
 * JS with Intl.Collator is the practical fix.
 */
export function collator(): Intl.Collator {
  return new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
}

function byName<T>(rows: T[], key: (row: T) => string): T[] {
  const c = collator();
  return [...rows].sort((a, b) => c.compare(key(a), key(b)));
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
export async function listEvents(): Promise<EventRow[]> {
  return (await db()).select<EventRow[]>("SELECT * FROM events ORDER BY dtstart ASC");
}

export async function getEvent(id: string): Promise<EventRow | undefined> {
  const rows = await (await db()).select<EventRow[]>("SELECT * FROM events WHERE id = ?", [id]);
  return rows[0];
}

export type EventInput = Omit<
  EventRow,
  "id" | "sequence" | "created_at" | "updated_at"
> & { id?: string };

export async function upsertEvent(input: EventInput): Promise<string> {
  const d = await db();
  const now = nowIso();
  if (input.id) {
    await d.execute(
      `UPDATE events SET summary=?, description=?, location=?, dtstart=?, dtend=?,
         all_day=?, rrule=?, exdates=?, status=?, categories=?, color=?,
         sequence=sequence+1, updated_at=? WHERE id=?`,
      [
        input.summary, input.description, input.location, input.dtstart, input.dtend,
        input.all_day, input.rrule, input.exdates, input.status, input.categories,
        input.color, now, input.id,
      ],
    );
    return input.id;
  }
  const id = newId();
  await d.execute(
    `INSERT INTO events (id, summary, description, location, dtstart, dtend, all_day,
       rrule, exdates, status, categories, color, sequence, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`,
    [
      id, input.summary, input.description, input.location, input.dtstart, input.dtend,
      input.all_day, input.rrule, input.exdates, input.status, input.categories,
      input.color, now, now,
    ],
  );
  return id;
}

/**
 * Insert-or-update an event while preserving a caller-supplied id (= iCal UID).
 * Used by ICS import so imported events keep their original stable UID as the
 * primary key, which CalDAV sync depends on.
 */
export async function upsertEventWithId(
  id: string,
  input: EventInput,
): Promise<void> {
  const existing = await getEvent(id);
  if (existing) {
    await upsertEvent({ ...input, id });
    return;
  }
  const now = nowIso();
  await (await db()).execute(
    `INSERT INTO events (id, summary, description, location, dtstart, dtend, all_day,
       rrule, exdates, status, categories, color, sequence, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`,
    [
      id, input.summary, input.description, input.location, input.dtstart, input.dtend,
      input.all_day, input.rrule, input.exdates, input.status, input.categories,
      input.color, now, now,
    ],
  );
}

/** Add an EXDATE (excluded ISO date) to a recurring event. */
export async function addExdate(eventId: string, iso: string): Promise<void> {
  const ev = await getEvent(eventId);
  if (!ev) return;
  const list: string[] = ev.exdates ? JSON.parse(ev.exdates) : [];
  if (!list.includes(iso)) list.push(iso);
  await (await db()).execute(
    "UPDATE events SET exdates=?, sequence=sequence+1, updated_at=? WHERE id=?",
    [JSON.stringify(list), nowIso(), eventId],
  );
}

export async function deleteEvent(id: string): Promise<void> {
  await (await db()).execute("DELETE FROM events WHERE id=?", [id]);
  await removeItemRelations("event", id);
}

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------
export async function listReminders(): Promise<ReminderRow[]> {
  return (await db()).select<ReminderRow[]>(
    "SELECT * FROM reminders ORDER BY completed ASC, due_at IS NULL, due_at ASC",
  );
}

export type ReminderInput = Omit<
  ReminderRow,
  "id" | "sequence" | "created_at" | "updated_at"
> & { id?: string };

export async function upsertReminder(input: ReminderInput): Promise<string> {
  const d = await db();
  const now = nowIso();
  if (input.id) {
    await d.execute(
      `UPDATE reminders SET title=?, notes=?, due_at=?, remind_at=?, rrule=?,
         priority=?, completed=?, completed_at=?, linked_todo_id=?,
         sequence=sequence+1, updated_at=? WHERE id=?`,
      [
        input.title, input.notes, input.due_at, input.remind_at, input.rrule,
        input.priority, input.completed, input.completed_at, input.linked_todo_id,
        now, input.id,
      ],
    );
    return input.id;
  }
  const id = newId();
  await d.execute(
    `INSERT INTO reminders (id, title, notes, due_at, remind_at, rrule, priority,
       completed, completed_at, linked_todo_id, sequence, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?)`,
    [
      id, input.title, input.notes, input.due_at, input.remind_at, input.rrule,
      input.priority, input.completed, input.completed_at, input.linked_todo_id,
      now, now,
    ],
  );
  return id;
}

export async function toggleReminder(id: string, completed: boolean): Promise<void> {
  await (await db()).execute(
    "UPDATE reminders SET completed=?, completed_at=?, sequence=sequence+1, updated_at=? WHERE id=?",
    [completed ? 1 : 0, completed ? nowIso() : null, nowIso(), id],
  );
}

export async function deleteReminder(id: string): Promise<void> {
  await (await db()).execute("DELETE FROM reminders WHERE id=?", [id]);
  await removeItemRelations("reminder", id);
}

// ---------------------------------------------------------------------------
// Lists + Todos
// ---------------------------------------------------------------------------
export async function listLists(): Promise<ListRow[]> {
  const rows = await (await db()).select<ListRow[]>("SELECT * FROM lists");
  return byName(rows, (l) => l.name);
}

export async function upsertList(input: Partial<ListRow> & { name: string }): Promise<string> {
  const d = await db();
  const name = normalizeKey(input.name);
  if (input.id) {
    await d.execute("UPDATE lists SET name=?, color=? WHERE id=?", [
      name, input.color ?? null, input.id,
    ]);
    return input.id;
  }
  const id = newId();
  await d.execute("INSERT INTO lists (id, name, color) VALUES (?,?,?)", [
    id, name, input.color ?? null,
  ]);
  return id;
}

export async function deleteList(id: string): Promise<void> {
  const d = await db();
  // Keep at least one list; rehome this list's tasks into another one.
  const others = await d.select<ListRow[]>("SELECT * FROM lists WHERE id != ? ORDER BY name", [id]);
  if (others.length === 0) return;
  await d.execute("UPDATE todos SET list_id=? WHERE list_id=?", [others[0].id, id]);
  await d.execute("DELETE FROM lists WHERE id=?", [id]);
}

export async function listTodos(): Promise<TodoRow[]> {
  return (await db()).select<TodoRow[]>(
    "SELECT * FROM todos ORDER BY position IS NULL, position ASC, created_at ASC",
  );
}

export type TodoInput = Omit<
  TodoRow,
  "id" | "sequence" | "created_at" | "updated_at"
> & { id?: string };

export async function upsertTodo(input: TodoInput): Promise<string> {
  const d = await db();
  const now = nowIso();
  if (input.id) {
    await d.execute(
      `UPDATE todos SET title=?, notes=?, list_id=?, due_at=?, priority=?,
         completed=?, completed_at=?, parent_todo_id=?, position=?,
         sequence=sequence+1, updated_at=? WHERE id=?`,
      [
        input.title, input.notes, input.list_id, input.due_at, input.priority,
        input.completed, input.completed_at, input.parent_todo_id, input.position,
        now, input.id,
      ],
    );
    return input.id;
  }
  const id = newId();
  await d.execute(
    `INSERT INTO todos (id, title, notes, list_id, due_at, priority, completed,
       completed_at, parent_todo_id, position, sequence, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?)`,
    [
      id, input.title, input.notes, input.list_id, input.due_at, input.priority,
      input.completed, input.completed_at, input.parent_todo_id, input.position,
      now, now,
    ],
  );
  return id;
}

export async function toggleTodo(id: string, completed: boolean): Promise<void> {
  await (await db()).execute(
    "UPDATE todos SET completed=?, completed_at=?, sequence=sequence+1, updated_at=? WHERE id=?",
    [completed ? 1 : 0, completed ? nowIso() : null, nowIso(), id],
  );
}

export async function reorderTodos(ids: string[]): Promise<void> {
  const d = await db();
  for (let i = 0; i < ids.length; i++) {
    await d.execute("UPDATE todos SET position=? WHERE id=?", [i, ids[i]]);
  }
}

export async function deleteTodo(id: string): Promise<void> {
  const d = await db();
  await d.execute("DELETE FROM todos WHERE parent_todo_id=?", [id]); // subtasks
  await d.execute("DELETE FROM todos WHERE id=?", [id]);
  await removeItemRelations("todo", id);
}

// ---------------------------------------------------------------------------
// Notes (+ FTS search)
// ---------------------------------------------------------------------------
export async function listNotes(): Promise<NoteRow[]> {
  return (await db()).select<NoteRow[]>(
    "SELECT * FROM notes ORDER BY pinned DESC, updated_at DESC",
  );
}

export type NoteInput = Omit<NoteRow, "id" | "created_at" | "updated_at"> & { id?: string };

export async function upsertNote(input: NoteInput): Promise<string> {
  const d = await db();
  const now = nowIso();
  if (input.id) {
    await d.execute(
      "UPDATE notes SET title=?, body=?, pinned=?, updated_at=? WHERE id=?",
      [input.title, input.body, input.pinned, now, input.id],
    );
    return input.id;
  }
  const id = newId();
  await d.execute(
    "INSERT INTO notes (id, title, body, pinned, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    [id, input.title, input.body, input.pinned, now, now],
  );
  return id;
}

export async function deleteNote(id: string): Promise<void> {
  await (await db()).execute("DELETE FROM notes WHERE id=?", [id]);
  await removeItemRelations("note", id);
}

/** Shortest query the trigram tokenizer can answer (see 005_fts_trigram.sql). */
const TRIGRAM_MIN = 3;

/**
 * Build an FTS5 MATCH expression, or null when the index can't answer it.
 *
 * Each whitespace-separated term becomes a quoted phrase, AND-ed together, so
 * multi-word Latin queries still work while a CJK query — which has no spaces
 * and so arrives as a single term — is substring-matched as a whole.
 *
 * Returns null if any term is shorter than three characters: the trigram
 * tokenizer silently matches nothing there, and Chinese words are very often
 * exactly two characters (北京, 會議). Callers must fall back to LIKE.
 */
function ftsMatchExpr(query: string): string | null {
  const terms = queryTerms(query);
  if (terms.length === 0) return null;
  if (terms.some((t) => [...t].length < TRIGRAM_MIN)) return null;
  return terms.map((t) => `"${t}"`).join(" AND ");
}

function queryTerms(query: string): string[] {
  return query.split(/\s+/).map((t) => t.replace(/"/g, "")).filter(Boolean);
}

/**
 * Full-text search over notes.
 *
 * Two paths on purpose: FTS5 (ranked) when the trigram index can answer the
 * query, plain LIKE otherwise. The LIKE path is not just an error fallback —
 * it is the *only* thing that can match short queries, which for Chinese means
 * most of them.
 */
export async function searchNotes(query: string): Promise<NoteRow[]> {
  const q = query.trim();
  if (!q) return [];
  const d = await db();

  // AND the terms, matching what the FTS path does. Matching the raw query as
  // one literal substring would make "北京 預算" fail on a note containing both
  // words apart — and for Chinese this is the path most queries take, so the
  // two paths have to agree.
  const likeSearch = () => {
    const terms = queryTerms(q);
    if (terms.length === 0) return Promise.resolve([] as NoteRow[]);
    const clause = terms.map(() => "(title LIKE ? OR body LIKE ?)").join(" AND ");
    const params = terms.flatMap((t) => [`%${t}%`, `%${t}%`]);
    return d.select<NoteRow[]>(
      `SELECT * FROM notes WHERE ${clause} ORDER BY updated_at DESC`,
      params,
    );
  };

  const match = ftsMatchExpr(q);
  if (!match) return likeSearch();

  try {
    return await d.select<NoteRow[]>(
      `SELECT n.* FROM notes n
       JOIN notes_fts f ON f.rowid = n.rowid
       WHERE notes_fts MATCH ?
       ORDER BY rank`,
      [match],
    );
  } catch {
    return likeSearch();
  }
}

// ---------------------------------------------------------------------------
// People (contacts, vCard-modeled). Attach to any item via `links`, tag via
// `item_tags` — both already accept item_type 'person', no schema change.
// ---------------------------------------------------------------------------
export async function listPeople(): Promise<PersonRow[]> {
  const rows = await (await db()).select<PersonRow[]>("SELECT * FROM people");
  return sortPeople(rows);
}

/** Favourites first, then locale-aware by name. */
function sortPeople(rows: PersonRow[]): PersonRow[] {
  const c = collator();
  return [...rows].sort(
    (a, b) => b.favorite - a.favorite || c.compare(a.full_name, b.full_name),
  );
}

export async function getPerson(id: string): Promise<PersonRow | undefined> {
  const rows = await (await db()).select<PersonRow[]>("SELECT * FROM people WHERE id = ?", [id]);
  return rows[0];
}

/** LIKE search over name/nickname/org and the raw JSON emails/phones text. */
export async function searchPeople(query: string): Promise<PersonRow[]> {
  const q = query.trim();
  if (!q) return listPeople();
  const like = `%${q}%`;
  const rows = await (await db()).select<PersonRow[]>(
    `SELECT * FROM people
     WHERE full_name LIKE ? OR nickname LIKE ? OR organization LIKE ?
        OR emails LIKE ? OR phones LIKE ?`,
    [like, like, like, like, like],
  );
  return sortPeople(rows);
}

export type PersonInput = Omit<
  PersonRow,
  "id" | "sequence" | "created_at" | "updated_at"
> & { id?: string };

export async function upsertPerson(input: PersonInput): Promise<string> {
  const d = await db();
  const now = nowIso();
  if (input.id) {
    await d.execute(
      `UPDATE people SET full_name=?, given_name=?, family_name=?, additional_names=?,
         honorific_prefix=?, honorific_suffix=?, nickname=?, emails=?, phones=?,
         addresses=?, organization=?, title=?, birthday=?, urls=?, notes=?, photo=?,
         custom_fields=?, favorite=?, sequence=sequence+1, updated_at=? WHERE id=?`,
      [
        input.full_name, input.given_name, input.family_name, input.additional_names,
        input.honorific_prefix, input.honorific_suffix, input.nickname, input.emails,
        input.phones, input.addresses, input.organization, input.title, input.birthday,
        input.urls, input.notes, input.photo, input.custom_fields, input.favorite,
        now, input.id,
      ],
    );
    return input.id;
  }
  const id = newId();
  await d.execute(
    `INSERT INTO people (id, full_name, given_name, family_name, additional_names,
       honorific_prefix, honorific_suffix, nickname, emails, phones, addresses,
       organization, title, birthday, urls, notes, photo, custom_fields, favorite,
       sequence, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`,
    [
      id, input.full_name, input.given_name, input.family_name, input.additional_names,
      input.honorific_prefix, input.honorific_suffix, input.nickname, input.emails,
      input.phones, input.addresses, input.organization, input.title, input.birthday,
      input.urls, input.notes, input.photo, input.custom_fields, input.favorite,
      now, now,
    ],
  );
  return id;
}

/**
 * Insert-or-update a person while preserving a caller-supplied id (= vCard UID).
 * For future .vcf import so imported contacts keep their original stable UID as
 * the primary key, which CardDAV sync depends on. Mirrors upsertEventWithId.
 */
export async function upsertPersonWithId(id: string, input: PersonInput): Promise<void> {
  const existing = await getPerson(id);
  if (existing) {
    await upsertPerson({ ...input, id });
    return;
  }
  const now = nowIso();
  await (await db()).execute(
    `INSERT INTO people (id, full_name, given_name, family_name, additional_names,
       honorific_prefix, honorific_suffix, nickname, emails, phones, addresses,
       organization, title, birthday, urls, notes, photo, custom_fields, favorite,
       sequence, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`,
    [
      id, input.full_name, input.given_name, input.family_name, input.additional_names,
      input.honorific_prefix, input.honorific_suffix, input.nickname, input.emails,
      input.phones, input.addresses, input.organization, input.title, input.birthday,
      input.urls, input.notes, input.photo, input.custom_fields, input.favorite,
      now, now,
    ],
  );
}

export async function deletePerson(id: string): Promise<void> {
  await (await db()).execute("DELETE FROM people WHERE id=?", [id]);
  await removeItemRelations("person", id);
}

// --- Global custom-field labels (shared across all people) -------------------
// The label set is global — a field you add shows on every person. Values stay
// per-person in people.custom_fields, keyed by label.
export interface CustomFieldDef { id: string; label: string; position: number }

export async function listCustomFields(): Promise<CustomFieldDef[]> {
  return (await db()).select<CustomFieldDef[]>(
    "SELECT * FROM person_custom_fields ORDER BY position ASC, label COLLATE NOCASE ASC",
  );
}

/** Add a global custom-field label if it doesn't already exist (case-insensitive). */
export async function ensureCustomField(label: string): Promise<CustomFieldDef> {
  const d = await db();
  const trimmed = normalizeKey(label);
  const existing = await d.select<CustomFieldDef[]>(
    "SELECT * FROM person_custom_fields WHERE label = ? COLLATE NOCASE", [trimmed],
  );
  if (existing[0]) return existing[0];
  const max = await d.select<{ m: number | null }[]>("SELECT MAX(position) m FROM person_custom_fields");
  const position = (max[0]?.m ?? -1) + 1;
  const id = newId();
  await d.execute("INSERT INTO person_custom_fields (id, label, position) VALUES (?,?,?)", [id, trimmed, position]);
  return { id, label: trimmed, position };
}

/** Delete a global custom field and strip its values from every person. */
export async function deleteCustomFieldDef(id: string): Promise<void> {
  const d = await db();
  const rows = await d.select<CustomFieldDef[]>("SELECT * FROM person_custom_fields WHERE id = ?", [id]);
  const def = rows[0];
  if (!def) return;
  await d.execute("DELETE FROM person_custom_fields WHERE id = ?", [id]);
  const people = await d.select<{ id: string; custom_fields: string | null }[]>(
    "SELECT id, custom_fields FROM people WHERE custom_fields IS NOT NULL",
  );
  for (const p of people) {
    let arr: PersonCustomField[];
    try { arr = JSON.parse(p.custom_fields!); } catch { continue; }
    if (!Array.isArray(arr)) continue;
    const next = arr.filter((c) => c.label !== def.label);
    if (next.length !== arr.length) {
      await d.execute(
        "UPDATE people SET custom_fields = ?, sequence = sequence + 1, updated_at = ? WHERE id = ?",
        [next.length ? JSON.stringify(next) : null, nowIso(), p.id],
      );
    }
  }
}

export async function reorderCustomFields(ids: string[]): Promise<void> {
  const d = await db();
  for (let i = 0; i < ids.length; i++) {
    await d.execute("UPDATE person_custom_fields SET position = ? WHERE id = ?", [i, ids[i]]);
  }
}

// ---------------------------------------------------------------------------
// Tags (shared across all item types)
// ---------------------------------------------------------------------------
export async function listTags(): Promise<TagRow[]> {
  const rows = await (await db()).select<TagRow[]>("SELECT * FROM tags");
  return byName(rows, (t) => t.name);
}

export async function ensureTag(name: string): Promise<TagRow> {
  const d = await db();
  const trimmed = normalizeKey(name);
  const existing = await d.select<TagRow[]>("SELECT * FROM tags WHERE name=?", [trimmed]);
  if (existing[0]) return existing[0];
  const id = newId();
  await d.execute("INSERT INTO tags (id, name) VALUES (?,?)", [id, trimmed]);
  return { id, name: trimmed };
}

export async function tagItem(name: string, type: ItemType, itemId: string): Promise<void> {
  const tag = await ensureTag(name);
  await (await db()).execute(
    "INSERT OR IGNORE INTO item_tags (tag_id, item_type, item_id, created_at) VALUES (?,?,?,?)",
    [tag.id, type, itemId, nowIso()],
  );
}

export async function untagItem(tagId: string, type: ItemType, itemId: string): Promise<void> {
  await (await db()).execute(
    "DELETE FROM item_tags WHERE tag_id=? AND item_type=? AND item_id=?",
    [tagId, type, itemId],
  );
}

export async function tagsForItem(type: ItemType, itemId: string): Promise<TagRow[]> {
  return (await db()).select<TagRow[]>(
    `SELECT t.* FROM tags t JOIN item_tags it ON it.tag_id = t.id
     WHERE it.item_type=? AND it.item_id=? ORDER BY t.name`,
    [type, itemId],
  );
}

// ---------------------------------------------------------------------------
// Links (generic any-to-any references)
// ---------------------------------------------------------------------------
export async function createLink(
  sourceType: ItemType,
  sourceId: string,
  targetType: ItemType,
  targetId: string,
): Promise<void> {
  await (await db()).execute(
    `INSERT INTO links (id, source_type, source_id, target_type, target_id, created_at)
     VALUES (?,?,?,?,?,?)`,
    [newId(), sourceType, sourceId, targetType, targetId, nowIso()],
  );
}

export async function deleteLink(id: string): Promise<void> {
  await (await db()).execute("DELETE FROM links WHERE id=?", [id]);
}

/** All links touching an item, from either direction. */
export async function linksForItem(type: ItemType, id: string): Promise<LinkRow[]> {
  return (await db()).select<LinkRow[]>(
    `SELECT * FROM links WHERE (source_type=? AND source_id=?) OR (target_type=? AND target_id=?)`,
    [type, id, type, id],
  );
}

/** Flat list of every item as a link target (type, id, label). */
export async function allLinkTargets(): Promise<
  { type: ItemType; id: string; label: string }[]
> {
  const d = await db();
  const events = await d.select<{ id: string; summary: string }[]>("SELECT id, summary FROM events");
  const reminders = await d.select<{ id: string; title: string }[]>("SELECT id, title FROM reminders");
  const todos = await d.select<{ id: string; title: string }[]>("SELECT id, title FROM todos");
  const notes = await d.select<{ id: string; title: string | null }[]>("SELECT id, title FROM notes");
  const people = await d.select<{ id: string; full_name: string }[]>("SELECT id, full_name FROM people");
  return [
    ...events.map((e) => ({ type: "event" as ItemType, id: e.id, label: e.summary })),
    ...reminders.map((r) => ({ type: "reminder" as ItemType, id: r.id, label: r.title })),
    ...todos.map((t) => ({ type: "todo" as ItemType, id: t.id, label: t.title })),
    ...notes.map((n) => ({ type: "note" as ItemType, id: n.id, label: n.title || "(untitled)" })),
    ...people.map((p) => ({ type: "person" as ItemType, id: p.id, label: p.full_name })),
  ];
}

/** Human-readable label for any item, used when rendering links/search. */
export async function getItemLabel(type: ItemType, id: string): Promise<string> {
  const d = await db();
  const table = { event: "events", reminder: "reminders", todo: "todos", note: "notes", person: "people" }[type];
  const col = type === "event" ? "summary" : type === "person" ? "full_name" : "title";
  const rows = await d.select<{ label: string | null }[]>(
    `SELECT ${col} AS label FROM ${table} WHERE id=?`,
    [id],
  );
  return rows[0]?.label || "(untitled)";
}

/** Remove tags + links referencing an item that is being deleted. */
async function removeItemRelations(type: ItemType, id: string): Promise<void> {
  const d = await db();
  await d.execute("DELETE FROM item_tags WHERE item_type=? AND item_id=?", [type, id]);
  await d.execute(
    "DELETE FROM links WHERE (source_type=? AND source_id=?) OR (target_type=? AND target_id=?)",
    [type, id, type, id],
  );
}
