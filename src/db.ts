// Data access layer. The public facade the whole UI calls; its function
// signatures are the app's contract.
//
// MID-MIGRATION (M2): todos and lists are served by the Cloudflare Worker (see
// lib/api.ts); everything else still uses local SQLite through
// tauri-plugin-sql. The switch is invisible to callers because the exported
// signatures are unchanged — a view calling listTodos() cannot tell which
// backend answered. Remaining domains follow in M3.

import Database from "@tauri-apps/plugin-sql";
import { v4 as uuid } from "uuid";
import type {
  EventRow,
  ReminderRow,
  TodoRow,
  NoteRow,
  NoteImageRow,
  ListRow,
  TagRow,
  LinkRow,
  PersonRow,
  ItemType,
} from "./types";
import type { TodoCreate, TodoUpdate, ReminderCreate, CustomFieldDef } from "@secondbrain/shared";
import { apiRequest, ApiError, OfflineError } from "./lib/api";
import { getCurrentSpaceId } from "./lib/authStore";
import { networkFirst } from "./lib/cache";

// Ranking helpers now live in @secondbrain/shared so the Worker runs the same
// code (one copy of the phrasing-bug fix CLAUDE.md documents). Re-exported here
// because ai.ts and SearchView import them from db. db.ts itself no longer
// searches locally, so it doesn't use them directly.
export { queryTerms, escapeLike, anyTermClause, matchQuery } from "@secondbrain/shared";

/** Build a space-scoped API path, or throw if no session is active. The throw
 *  is a programmer-error guard: the AuthGate guarantees a session before any
 *  view that calls these mounts. */
function spacePath(suffix: string): string {
  const spaceId = getCurrentSpaceId();
  if (!spaceId) throw new Error("No active space — not signed in.");
  return `/v1/spaces/${spaceId}${suffix}`;
}

/** The slice of `tauri-plugin-sql`'s Database this module actually uses. Both
 *  the native backend and the browser dev backend satisfy it. */
export interface SqlDb {
  select<T>(query: string, params?: unknown[]): Promise<T>;
  execute(query: string, params?: unknown[]): Promise<{ rowsAffected: number; lastInsertId: number }>;
}

let _db: SqlDb | null = null;
// The in-flight open promise, so concurrent first-callers of db() share one
// open instead of racing into the init branch (the browser backend's
// loadBrowserDb + resetAndSeedDemo would otherwise run twice in parallel, and
// the seeder's own db() call could re-enter before `_db` is assigned).
let _dbPromise: Promise<SqlDb> | null = null;

// isTauri lives in lib/platform.ts (so the API client can use it without a
// cycle) and is re-exported here for the callers that import it from db.
export { isTauri } from "./lib/platform";
import { isTauri } from "./lib/platform";

/**
 * Lazily open the DB. Migrations run automatically on first load.
 *
 * Outside Tauri there is no plugin to call, so a wasm SQLite stands in — see
 * `lib/browserDb.ts`. It exists so the UI can be exercised in a browser; it is
 * seeded with demo data and never persists.
 */
export function db(): Promise<SqlDb> {
  if (_db) return Promise.resolve(_db);
  if (!_dbPromise) {
    _dbPromise = (async () => {
      let opened: SqlDb;
      if (isTauri()) {
        opened = (await Database.load("sqlite:secondbrain.db")) as SqlDb;
      } else {
        const { loadBrowserDb } = await import("./lib/browserDb");
        opened = await loadBrowserDb();
        // Seed only after the backend is assigned below: the seeder calls db()
        // itself, and doing this inside loadBrowserDb() would re-enter this
        // branch forever.
      }
      _db = opened;
      if (!isTauri()) {
        const { resetAndSeedDemo } = await import("./lib/demo");
        await resetAndSeedDemo();
      }
      return opened;
    })();
  }
  return _dbPromise;
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
// Events — the built-in calendar, served by the Worker (M3c). CalDAV calendars
// are unaffected: calendars.ts still fetches those live and merges them with
// these. Only calendars.ts and ai.ts call these helpers (architecture rule 3).
// ---------------------------------------------------------------------------
export async function listEvents(): Promise<EventRow[]> {
  return networkFirst(`events:${getCurrentSpaceId()}`, () =>
    apiRequest<EventRow[]>(spacePath("/events")),
  );
}

export async function getEvent(id: string): Promise<EventRow | undefined> {
  try {
    return await apiRequest<EventRow>(spacePath(`/events/${id}`));
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return undefined;
    throw e;
  }
}

export type EventInput = Omit<
  EventRow,
  "id" | "sequence" | "created_at" | "updated_at"
> & { id?: string };

/** The writable event fields, in one place so create and update agree. */
function eventBody(input: EventInput): Omit<EventInput, "id"> {
  const { id: _id, ...fields } = input;
  return fields;
}

export async function upsertEvent(input: EventInput): Promise<string> {
  if (input.id) {
    await apiRequest<EventRow>(spacePath(`/events/${input.id}`), { method: "PATCH", body: eventBody(input) });
    return input.id;
  }
  const id = newId();
  await apiRequest<EventRow>(spacePath("/events"), { method: "POST", body: { id, ...eventBody(input) } });
  return id;
}

/**
 * Insert-or-update an event while preserving a caller-supplied id (= iCal UID),
 * for ICS import. Create-with-id when new, PATCH when it exists.
 */
export async function upsertEventWithId(id: string, input: EventInput): Promise<void> {
  if (await getEvent(id)) {
    await apiRequest<EventRow>(spacePath(`/events/${id}`), { method: "PATCH", body: eventBody(input) });
    return;
  }
  await apiRequest<EventRow>(spacePath("/events"), { method: "POST", body: { id, ...eventBody(input) } });
}

/** Add an EXDATE (excluded ISO date) to a recurring event. Read-modify-write:
 *  the server has no exdate-append endpoint, and this isn't a hot path. */
export async function addExdate(eventId: string, iso: string): Promise<void> {
  const ev = await getEvent(eventId);
  if (!ev) return;
  const list: string[] = ev.exdates ? JSON.parse(ev.exdates) : [];
  if (list.includes(iso)) return;
  list.push(iso);
  await apiRequest<EventRow>(spacePath(`/events/${eventId}`), {
    method: "PATCH",
    body: { exdates: JSON.stringify(list) },
  });
}

export async function deleteEvent(id: string): Promise<void> {
  await apiRequest<void>(spacePath(`/events/${id}`), { method: "DELETE" });
  await removeItemRelations("event", id); // links/tags still local until M3d
}

// ---------------------------------------------------------------------------
// Reminders — served by the Worker (M3). Same remote pattern as todos/lists.
// ---------------------------------------------------------------------------
export async function listReminders(): Promise<ReminderRow[]> {
  return networkFirst(`reminders:${getCurrentSpaceId()}`, () =>
    apiRequest<ReminderRow[]>(spacePath("/reminders")),
  );
}

export async function getReminder(id: string): Promise<ReminderRow | undefined> {
  try {
    return await apiRequest<ReminderRow>(spacePath(`/reminders/${id}`));
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return undefined;
    throw e;
  }
}

export type ReminderInput = Omit<
  ReminderRow,
  "id" | "sequence" | "created_at" | "updated_at"
> & { id?: string };

export async function upsertReminder(input: ReminderInput): Promise<string> {
  // Not annotated ReminderUpdate: that would widen every field to optional and
  // break the create body's required shape. The values are all concrete.
  const fields = {
    title: input.title,
    notes: input.notes,
    due_at: input.due_at,
    remind_at: input.remind_at,
    rrule: input.rrule,
    priority: input.priority,
    completed: input.completed as 0 | 1,
    completed_at: input.completed_at,
    linked_todo_id: input.linked_todo_id,
  };
  if (input.id) {
    await apiRequest<ReminderRow>(spacePath(`/reminders/${input.id}`), { method: "PATCH", body: fields });
    return input.id;
  }
  const id = newId();
  await apiRequest<ReminderRow>(spacePath("/reminders"), {
    method: "POST",
    body: { id, ...fields } satisfies ReminderCreate,
  });
  return id;
}

export async function toggleReminder(id: string, completed: boolean): Promise<void> {
  await apiRequest<ReminderRow>(spacePath(`/reminders/${id}`), {
    method: "PATCH",
    body: { completed: completed ? 1 : 0, completed_at: completed ? nowIso() : null },
  });
}

export async function deleteReminder(id: string): Promise<void> {
  await apiRequest<void>(spacePath(`/reminders/${id}`), { method: "DELETE" });
  await removeItemRelations("reminder", id); // links/tags still local until M3d
}

// ---------------------------------------------------------------------------
// Lists + Todos — served by the Cloudflare Worker (M2). Signatures unchanged.
//
// Reads go through networkFirst: fresh from the server when online, the last
// snapshot when offline. Writes have no offline fallback by design — they throw
// OfflineError, which the UI surfaces as "can't save, you're offline". Client-
// generated ids (newId) make every create idempotent on retry.
// ---------------------------------------------------------------------------

export async function listLists(): Promise<ListRow[]> {
  const rows = await networkFirst(`lists:${getCurrentSpaceId()}`, () =>
    apiRequest<ListRow[]>(spacePath("/lists")),
  );
  // Sort client-side with Intl.Collator: D1 has no ICU, so the server's
  // ORDER BY name is only a stable default, not locale-correct.
  return byName(rows, (l) => l.name);
}

export async function upsertList(input: Partial<ListRow> & { name: string }): Promise<string> {
  const name = normalizeKey(input.name);
  if (input.id) {
    await apiRequest<ListRow>(spacePath(`/lists/${input.id}`), {
      method: "PATCH",
      body: { name, color: input.color ?? null },
    });
    return input.id;
  }
  const id = newId();
  await apiRequest<ListRow>(spacePath("/lists"), {
    method: "POST",
    body: { id, name, color: input.color ?? null },
  });
  return id;
}

export async function deleteList(id: string): Promise<void> {
  // The server rehomes this list's todos onto a survivor and refuses to delete
  // the last one (409). The old local guard "silently do nothing if it's the
  // last list" is gone on purpose — a refusal the UI can report beats a delete
  // that looks like it worked and didn't.
  await apiRequest<void>(spacePath(`/lists/${id}`), { method: "DELETE" });
}

/**
 * Formerly seeded Personal/Work into local SQLite. The Worker now creates both
 * (with per-space UUID ids) when an account registers, so this is a no-op kept
 * only so existing callers — the demo seeder — still compile. The "always at
 * least one list" invariant now lives in registration and the server's
 * last-list delete refusal.
 */
export async function ensureDefaultLists(): Promise<void> {
  /* no-op: lists are provisioned server-side at registration */
}

export async function listTodos(): Promise<TodoRow[]> {
  return networkFirst(`todos:${getCurrentSpaceId()}`, () =>
    apiRequest<TodoRow[]>(spacePath("/todos")),
  );
}

export async function getTodo(id: string): Promise<TodoRow | undefined> {
  try {
    return await apiRequest<TodoRow>(spacePath(`/todos/${id}`));
  } catch (e) {
    // A missing todo is `undefined` here, matching the old SELECT-returns-empty
    // contract; anything else (offline, auth) still throws.
    if (e instanceof ApiError && e.status === 404) return undefined;
    throw e;
  }
}

export type TodoInput = Omit<
  TodoRow,
  "id" | "sequence" | "created_at" | "updated_at"
> & { id?: string };

export async function upsertTodo(input: TodoInput): Promise<string> {
  if (input.id) {
    // A full-field PATCH: the caller (TodosView, ai.ts) has already merged, so
    // every field is present and this replaces them. The partial-merge
    // machinery still applies — absent keys would be left alone — it just
    // happens that none are absent here.
    const patch: TodoUpdate = {
      title: input.title,
      notes: input.notes,
      list_id: input.list_id,
      due_at: input.due_at,
      priority: input.priority,
      completed: input.completed as 0 | 1,
      completed_at: input.completed_at,
      parent_todo_id: input.parent_todo_id,
      position: input.position,
    };
    await apiRequest<TodoRow>(spacePath(`/todos/${input.id}`), { method: "PATCH", body: patch });
    return input.id;
  }
  const id = newId();
  const body: TodoCreate = {
    id,
    title: input.title,
    notes: input.notes,
    list_id: input.list_id,
    due_at: input.due_at,
    priority: input.priority,
    completed: input.completed as 0 | 1,
    completed_at: input.completed_at,
    parent_todo_id: input.parent_todo_id,
    position: input.position,
  };
  await apiRequest<TodoRow>(spacePath("/todos"), { method: "POST", body });
  return id;
}

export async function toggleTodo(id: string, completed: boolean): Promise<void> {
  await apiRequest<TodoRow>(spacePath(`/todos/${id}`), {
    method: "PATCH",
    body: { completed: completed ? 1 : 0, completed_at: completed ? nowIso() : null },
  });
}

export async function reorderTodos(ids: string[]): Promise<void> {
  await apiRequest<void>(spacePath("/todos/reorder"), { method: "POST", body: { ids } });
}

export async function deleteTodo(id: string): Promise<void> {
  await apiRequest<void>(spacePath(`/todos/${id}`), { method: "DELETE" });
  // Links and tags for this todo still live in local SQLite until M3, so they
  // are cleaned up here; the server already removed the todo and its subtasks.
  await removeItemRelations("todo", id);
}

// ---------------------------------------------------------------------------
// Notes — served by the Worker (M4), including the trigram FTS search. Note
// IMAGES are still local SQLite until M4b (bytes move to R2 then).
// ---------------------------------------------------------------------------
export async function listNotes(): Promise<NoteRow[]> {
  return networkFirst(`notes:${getCurrentSpaceId()}`, () =>
    apiRequest<NoteRow[]>(spacePath("/notes")),
  );
}

export async function getNote(id: string): Promise<NoteRow | undefined> {
  try {
    return await apiRequest<NoteRow>(spacePath(`/notes/${id}`));
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return undefined;
    throw e;
  }
}

export type NoteInput = Omit<NoteRow, "id" | "created_at" | "updated_at"> & { id?: string };

export async function upsertNote(input: NoteInput): Promise<string> {
  const fields = { title: input.title, body: input.body, pinned: input.pinned as 0 | 1 };
  if (input.id) {
    await apiRequest<NoteRow>(spacePath(`/notes/${input.id}`), { method: "PATCH", body: fields });
    return input.id;
  }
  const id = newId();
  await apiRequest<NoteRow>(spacePath("/notes"), { method: "POST", body: { id, ...fields } });
  return id;
}

export async function deleteNote(id: string): Promise<void> {
  await apiRequest<void>(spacePath(`/notes/${id}`), { method: "DELETE" });
  // The server removed the note's image ROWS; the local image BYTES (still in
  // SQLite until M4b) are cleaned up here so they don't linger.
  await (await db()).execute("DELETE FROM note_images WHERE note_id=?", [id]);
  await removeItemRelations("note", id);
}

// --- Note images -------------------------------------------------------------
// Referenced from the note body as `sbimg:<id>`. Editing a reference out of the
// markdown deliberately does NOT delete the row: saves are debounced mid-edit,
// so cutting an image to paste it lower down would destroy it between
// keystrokes. Rows are reclaimed when the whole note goes.

export async function insertNoteImage(
  noteId: string,
  img: { mime: string; data: string; width: number; height: number },
): Promise<string> {
  const id = newId();
  await (await db()).execute(
    "INSERT INTO note_images (id, note_id, mime, data, width, height, created_at) VALUES (?,?,?,?,?,?,?)",
    [id, noteId, img.mime, img.data, img.width, img.height, nowIso()],
  );
  return id;
}

export async function getNoteImage(id: string): Promise<NoteImageRow | undefined> {
  const rows = await (await db()).select<NoteImageRow[]>(
    "SELECT * FROM note_images WHERE id = ?",
    [id],
  );
  return rows[0];
}

// searchRows (the local term-search-over-a-table helper) is gone: todos,
// reminders and events all search server-side now, each ranking with the same
// shared matchQuery. Notes keep their own FTS path (still local until M4).

/** Global-search helpers: one row per match, ranked, no filters. */
export async function searchReminders(query: string): Promise<ReminderRow[]> {
  const q = query.trim();
  if (!q) return [];
  try {
    return await apiRequest<ReminderRow[]>(spacePath(`/reminders?q=${encodeURIComponent(q)}`));
  } catch (e) {
    if (e instanceof OfflineError) return [];
    throw e;
  }
}

/** Remote search (M2). The server ranks with the same shared helpers, so the
 *  result order matches the other search paths. Offline it degrades to empty
 *  rather than throwing — the global search bar just omits todos until the
 *  network returns, which reads better than a whole-search error. */
export async function searchTodos(query: string): Promise<TodoRow[]> {
  const q = query.trim();
  if (!q) return [];
  try {
    return await apiRequest<TodoRow[]>(spacePath(`/todos?q=${encodeURIComponent(q)}`));
  } catch (e) {
    if (e instanceof OfflineError) return [];
    throw e;
  }
}

/** Built-in-calendar events only, ranked server-side. The remote (CalDAV) half
 *  is windowed and lives in calendars.ts. Offline degrades to empty. */
export async function searchEventRows(query: string): Promise<EventRow[]> {
  const q = query.trim();
  if (!q) return [];
  try {
    return await apiRequest<EventRow[]>(spacePath(`/events?q=${encodeURIComponent(q)}`));
  } catch (e) {
    if (e instanceof OfflineError) return [];
    throw e;
  }
}

/**
 * Full-text search over notes (M4). The trigram-FTS-or-LIKE decision now lives
 * server-side (worker/src/db/notes.ts); both paths AND the terms and agree, and
 * the LIKE path still carries sub-3-character queries (most Chinese words).
 * Offline degrades to empty, like the other searches.
 */
export async function searchNotes(query: string): Promise<NoteRow[]> {
  const q = query.trim();
  if (!q) return [];
  try {
    return await apiRequest<NoteRow[]>(spacePath(`/notes?q=${encodeURIComponent(q)}`));
  } catch (e) {
    if (e instanceof OfflineError) return [];
    throw e;
  }
}

// ---------------------------------------------------------------------------
// People (contacts, vCard-modeled). Attach to any item via `links`, tag via
// `item_tags` — both already accept item_type 'person', no schema change.
// ---------------------------------------------------------------------------
export async function listPeople(): Promise<PersonRow[]> {
  const rows = await networkFirst(`people:${getCurrentSpaceId()}`, () =>
    apiRequest<PersonRow[]>(spacePath("/people")),
  );
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
  try {
    return await apiRequest<PersonRow>(spacePath(`/people/${id}`));
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return undefined;
    throw e;
  }
}

/** LIKE search over name/nickname/org and the raw JSON emails/phones text.
 *  The AND-terms logic now lives server-side (db/people.ts). */
export async function searchPeople(query: string): Promise<PersonRow[]> {
  const q = query.trim();
  if (!q) return listPeople();
  try {
    const rows = await apiRequest<PersonRow[]>(spacePath(`/people?q=${encodeURIComponent(q)}`));
    return sortPeople(rows);
  } catch (e) {
    if (e instanceof OfflineError) return [];
    throw e;
  }
}

export type PersonInput = Omit<
  PersonRow,
  "id" | "sequence" | "created_at" | "updated_at"
> & { id?: string };

/** The writable person fields, in one place so create and update agree. */
function personBody(input: PersonInput): Omit<PersonInput, "id"> {
  const { id: _id, ...fields } = input;
  return fields;
}

export async function upsertPerson(input: PersonInput): Promise<string> {
  if (input.id) {
    await apiRequest<PersonRow>(spacePath(`/people/${input.id}`), {
      method: "PATCH",
      body: personBody(input),
    });
    return input.id;
  }
  const id = newId();
  await apiRequest<PersonRow>(spacePath("/people"), {
    method: "POST",
    body: { id, ...personBody(input) },
  });
  return id;
}

/**
 * Insert-or-update a person while preserving a caller-supplied id (= vCard UID),
 * for future .vcf import. Create-with-id when new, PATCH when it exists.
 */
export async function upsertPersonWithId(id: string, input: PersonInput): Promise<void> {
  if (await getPerson(id)) {
    await apiRequest<PersonRow>(spacePath(`/people/${id}`), { method: "PATCH", body: personBody(input) });
    return;
  }
  await apiRequest<PersonRow>(spacePath("/people"), { method: "POST", body: { id, ...personBody(input) } });
}

export async function deletePerson(id: string): Promise<void> {
  await apiRequest<void>(spacePath(`/people/${id}`), { method: "DELETE" });
  await removeItemRelations("person", id); // links/tags still local until M3d
}

// --- Global custom-field labels (shared across all people) -------------------
// The label set is global — a field you add shows on every person. Values stay
// per-person in people.custom_fields, keyed by label. CustomFieldDef lives in
// @secondbrain/shared (the Worker returns it); re-exported for existing callers.
export type { CustomFieldDef } from "@secondbrain/shared";

export async function listCustomFields(): Promise<CustomFieldDef[]> {
  const rows = await networkFirst(`custom_fields:${getCurrentSpaceId()}`, () =>
    apiRequest<CustomFieldDef[]>(spacePath("/custom-fields")),
  );
  // Position wins; the label tiebreak sorts locale-aware (D1 can't). Matches
  // listTags/listPeople.
  const c = collator();
  return [...rows].sort((a, b) => a.position - b.position || c.compare(a.label, b.label));
}

/** Add a global custom-field label if it doesn't already exist. Idempotent by
 *  label server-side, so a retry returns the same def. */
export async function ensureCustomField(label: string): Promise<CustomFieldDef> {
  return apiRequest<CustomFieldDef>(spacePath("/custom-fields"), {
    method: "POST",
    body: { label: normalizeKey(label) },
  });
}

/** Delete a global custom field; the server strips its value from every person
 *  (values first, def last) in one batch. */
export async function deleteCustomFieldDef(id: string): Promise<void> {
  await apiRequest<void>(spacePath(`/custom-fields/${id}`), { method: "DELETE" });
}

export async function reorderCustomFields(ids: string[]): Promise<void> {
  await apiRequest<void>(spacePath("/custom-fields/reorder"), { method: "POST", body: { ids } });
}

// ---------------------------------------------------------------------------
// Tags + Links — served by the Worker (M3d). These key items by (type, id), so
// a note's tags/links live in D1 even though the note ROW is still local until
// M4. removeItemRelations therefore hits the server for every type.
// ---------------------------------------------------------------------------
export async function listTags(): Promise<TagRow[]> {
  const rows = await networkFirst(`tags:${getCurrentSpaceId()}`, () =>
    apiRequest<TagRow[]>(spacePath("/tags")),
  );
  return byName(rows, (t) => t.name);
}

// ensureTag was removed with the M3d migration: a tag only ever exists attached
// to an item, and the server ensures it as part of tagItem. There is no
// standalone "create a tag" flow in the app.

export async function tagItem(name: string, type: ItemType, itemId: string): Promise<void> {
  await apiRequest<TagRow>(spacePath(`/items/${type}/${itemId}/tags`), {
    method: "POST",
    body: { name: normalizeKey(name) },
  });
}

export async function untagItem(tagId: string, type: ItemType, itemId: string): Promise<void> {
  await apiRequest<void>(spacePath(`/items/${type}/${itemId}/tags/${tagId}`), { method: "DELETE" });
}

export async function tagsForItem(type: ItemType, itemId: string): Promise<TagRow[]> {
  const rows = await apiRequest<TagRow[]>(spacePath(`/items/${type}/${itemId}/tags`));
  return byName(rows, (t) => t.name);
}

/** Item ids of a type carrying a tag (by name). Powers the assistant's filters. */
export async function itemIdsForTag(type: ItemType, tagName: string): Promise<string[]> {
  return apiRequest<string[]>(
    spacePath(`/tags/${encodeURIComponent(normalizeKey(tagName))}/item-ids?type=${type}`),
  );
}

export async function createLink(
  sourceType: ItemType,
  sourceId: string,
  targetType: ItemType,
  targetId: string,
): Promise<void> {
  await apiRequest<LinkRow>(spacePath("/links"), {
    method: "POST",
    body: { source_type: sourceType, source_id: sourceId, target_type: targetType, target_id: targetId },
  });
}

export async function deleteLink(id: string): Promise<void> {
  await apiRequest<void>(spacePath(`/links/${id}`), { method: "DELETE" });
}

/** All links touching an item, from either direction. */
export async function linksForItem(type: ItemType, id: string): Promise<LinkRow[]> {
  return apiRequest<LinkRow[]>(spacePath(`/items/${type}/${id}/links`));
}

/**
 * Flat list of every item as a link target (type, id, label).
 *
 * Composed from the already-remote domain lists (each networkFirst-cached) plus
 * a local notes query — notes are the one domain whose rows are still local
 * (until M4). When notes move, the local read is swapped for listNotes() and
 * this becomes a pure composition.
 */
export async function allLinkTargets(): Promise<
  { type: ItemType; id: string; label: string }[]
> {
  const [events, reminders, todos, notes, people] = await Promise.all([
    listEvents(), listReminders(), listTodos(), listNotes(), listPeople(),
  ]);
  return [
    ...events.map((e) => ({ type: "event" as ItemType, id: e.id, label: e.summary })),
    ...reminders.map((r) => ({ type: "reminder" as ItemType, id: r.id, label: r.title })),
    ...todos.map((t) => ({ type: "todo" as ItemType, id: t.id, label: t.title })),
    ...notes.map((n) => ({ type: "note" as ItemType, id: n.id, label: n.title || "(untitled)" })),
    ...people.map((p) => ({ type: "person" as ItemType, id: p.id, label: p.full_name })),
  ];
}

/**
 * Human-readable label for any item, used when rendering links/search.
 *
 * Reuses the per-type remote getters (one request each) for the migrated
 * domains and a local lookup for notes. Links are few per item, so the handful
 * of requests when a detail panel opens is acceptable.
 */
export async function getItemLabel(type: ItemType, id: string): Promise<string> {
  switch (type) {
    case "event": return (await getEvent(id))?.summary || "(untitled)";
    case "reminder": return (await getReminder(id))?.title || "(untitled)";
    case "todo": return (await getTodo(id))?.title || "(untitled)";
    case "person": return (await getPerson(id))?.full_name || "(untitled)";
    case "note": return (await getNote(id))?.title || "(untitled)";
  }
}

// ---------------------------------------------------------------------------
// Full data export / import (backup + restore, see lib/backup.ts)
//
// A backup is every row of every user table, preserved verbatim (ids,
// timestamps, sequence) so a restored DB is byte-identical to the original and
// stays CalDAV/CardDAV-syncable. The two secret-bearing settings (OpenAI key,
// CalDAV account) live in localStorage, not here, so they never travel in a
// table dump — backup.ts decides which settings to include.
// ---------------------------------------------------------------------------

/** Every user-data table. `notes_fts` is a virtual FTS mirror kept in sync by
 *  triggers, so it is never exported or imported directly. No FK cascades
 *  exist, so insert order doesn't matter. `note_images` is included so a backup
 *  round-trips the bytes a note's `sbimg:` reference points at — without it,
 *  restore would leave every image broken, and clearAllData would orphan rows. */
export const DATA_TABLES = [
  "tags", "item_tags", "links", "events", "reminders", "lists", "todos",
  "notes", "note_images", "people", "person_custom_fields",
] as const;

export type DataTable = (typeof DATA_TABLES)[number];

type Row = Record<string, unknown>;

/** Read every user table verbatim, keyed by table name. */
export async function exportTables(): Promise<Record<DataTable, Row[]>> {
  const d = await db();
  const out = {} as Record<DataTable, Row[]>;
  for (const t of DATA_TABLES) {
    out[t] = await d.select<Row[]>(`SELECT * FROM ${t}`);
  }
  return out;
}

/**
 * Replace ALL user data with the supplied rows. Destructive: every existing
 * row of every table is deleted first, then the given rows are inserted with
 * their stored columns, so ids/timestamps/sequence survive a round-trip.
 *
 * Only columns that actually exist on each table are inserted — a stray or
 * renamed column in the file is dropped rather than throwing, and the column
 * whitelist also stops arbitrary JSON keys reaching the SQL string.
 *
 * Atomicity: tauri-plugin-sql multiplexes calls across a pool of connections,
 * so a `BEGIN` in one `execute` and a `COMMIT` in another can land on different
 * connections and leak a dangling transaction. We therefore don't rely on a
 * cross-call transaction — instead we snapshot the current data first and, if
 * any table's swap throws, restore the snapshot so the user is never left with
 * a half-empty DB. Every row is validated up front (each must be a plain
 * object) so a malformed file is rejected before anything is deleted.
 *
 * Identity keys (tags.name, lists.name, person_custom_fields.label) are
 * NFC-normalized on insert, so a backup produced elsewhere can't reintroduce
 * the NFD/NFC duplicate bug that normalizeKey exists to prevent.
 */
export async function importTables(
  tables: Partial<Record<DataTable, Row[]>>,
): Promise<void> {
  const d = await db();

  // Validate + normalize every row BEFORE touching the DB, so a malformed file
  // is rejected with nothing deleted.
  const allowedByTable = new Map<DataTable, Set<string>>();
  for (const t of DATA_TABLES) allowedByTable.set(t, await columnsOf(t));
  const cleanedByTable = new Map<DataTable, { cols: string[]; params: unknown[] }[]>();
  for (const table of DATA_TABLES) {
    const rows = tables[table] ?? [];
    if (!rows.length) continue;
    const allowed = allowedByTable.get(table)!;
    const identityCol = IDENTITY_KEY_COLS[table];
    const cleaned: { cols: string[]; params: unknown[] }[] = [];
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        throw new Error(`Invalid row in backup table "${table}"`);
      }
      const cols = Object.keys(row).filter((c) => allowed.has(c));
      if (!cols.length) continue;
      cleaned.push({
        cols,
        params: cols.map((c) =>
          c === identityCol ? normalizeKey(String(row[c])) : row[c],
        ),
      });
    }
    if (cleaned.length) cleanedByTable.set(table, cleaned);
  }

  // Snapshot the current data so we can fully roll back if any table swap fails.
  const snapshot = await exportTables();

  try {
    for (const table of DATA_TABLES) {
      await d.execute(`DELETE FROM ${table}`);
      const cleaned = cleanedByTable.get(table);
      if (!cleaned) continue;
      for (const { cols, params } of cleaned) {
        const placeholders = cols.map(() => "?").join(",");
        await d.execute(
          `INSERT INTO ${table} (${cols.join(",")}) VALUES (${placeholders})`,
          params,
        );
      }
    }
  } catch (err) {
    // Roll the whole DB back to the pre-import state.
    await restoreSnapshot(snapshot).catch(() => { /* best-effort; the original error wins */ });
    throw err;
  }
  // A backup with no lists (or one that omitted the lists table) must not leave
  // the app unable to hold a todo — re-seed the defaults if the wipe left none.
  await ensureDefaultLists();
}

/** Re-apply a snapshot from exportTables. Used to roll back a failed import. */
async function restoreSnapshot(snapshot: Record<DataTable, Row[]>): Promise<void> {
  const d = await db();
  for (const table of DATA_TABLES) {
    await d.execute(`DELETE FROM ${table}`);
    const allowed = await columnsOf(table);
    for (const row of snapshot[table] ?? []) {
      const cols = Object.keys(row).filter((c) => allowed.has(c));
      if (!cols.length) continue;
      await d.execute(
        `INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
        cols.map((c) => row[c]),
      );
    }
  }
}

/** The set of real column names on a table (via PRAGMA table_info). */
async function columnsOf(table: DataTable): Promise<Set<string>> {
  const info = await (await db()).select<{ name: string }[]>(`PRAGMA table_info(${table})`);
  return new Set(info.map((c) => c.name));
}

/**
 * Columns whose value is an identity key compared under binary collation, so
 * they must be NFC-normalized on restore exactly like the TS write paths do.
 * Absent from the map => no normalization.
 */
const IDENTITY_KEY_COLS: Partial<Record<DataTable, string>> = {
  tags: "name",
  lists: "name",
  person_custom_fields: "label",
};

/** Remove tags + links referencing an item that is being deleted. Server-side
 *  now (M3d): tags/links live in D1 for every type, notes included. */
async function removeItemRelations(type: ItemType, id: string): Promise<void> {
  await apiRequest<void>(spacePath(`/items/${type}/${id}/relations`), { method: "DELETE" });
}
