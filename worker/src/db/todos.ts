import {
  anyTermClause,
  matchQuery,
  queryTerms,
  type TodoCreate,
  type TodoQuery,
  type TodoRow,
  type TodoUpdate,
} from "@secondbrain/shared";
import { notFound } from "../http";

/**
 * All SQL touching `todos`. Every statement binds `space_id`.
 *
 * Timestamps and `sequence` are set here, never accepted from the client: they
 * exist for CalDAV/CardDAV compatibility and clock skew between a user's
 * devices would corrupt them.
 */

const COLUMNS = `id, title, notes, list_id, due_at, priority, completed,
                 completed_at, parent_todo_id, position, sequence,
                 created_at, updated_at`;

export async function listTodos(
  db: D1Database,
  spaceId: string,
  query: TodoQuery,
): Promise<{ rows: TodoRow[]; partial: boolean }> {
  // A search query ranks with the shared helpers so results agree with the
  // global search bar and the assistant. Without `q` it's a plain ordered list.
  if (query.q && query.q.trim()) {
    return searchTodos(db, spaceId, query.q);
  }

  const filters: string[] = ["space_id = ?"];
  const params: unknown[] = [spaceId];
  if (query.list_id) {
    filters.push("list_id = ?");
    params.push(query.list_id);
  }
  if (query.completed) {
    filters.push("completed = ?");
    params.push(Number(query.completed));
  }

  const { results } = await db
    .prepare(
      `SELECT ${COLUMNS} FROM todos WHERE ${filters.join(" AND ")}
       ORDER BY position IS NULL, position ASC, created_at ASC`,
    )
    .bind(...params)
    .all<TodoRow>();
  return { rows: results, partial: false };
}

async function searchTodos(
  db: D1Database,
  spaceId: string,
  q: string,
): Promise<{ rows: TodoRow[]; partial: boolean }> {
  const terms = queryTerms(q.trim());
  if (terms.length === 0) return { rows: [], partial: false };

  // SQL narrows to rows hitting ANY term (indexed prefilter), JS ranks. The
  // space_id predicate is ANDed OUTSIDE the term OR-group, so a term can never
  // widen the query past this tenant.
  const { clause, params } = anyTermClause(terms, ["title", "notes"]);
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM todos WHERE space_id = ? AND ${clause}`)
    .bind(spaceId, ...params)
    .all<TodoRow>();

  return matchQuery(results, q, (r) => [r.title, r.notes]);
}

export async function getTodo(
  db: D1Database,
  spaceId: string,
  id: string,
): Promise<TodoRow | null> {
  return db
    .prepare(`SELECT ${COLUMNS} FROM todos WHERE id = ? AND space_id = ?`)
    .bind(id, spaceId)
    .first<TodoRow>();
}

/**
 * Create a todo. Idempotent on the client-supplied id: a retried create (flaky
 * mobile network) finds the row already there and returns it unchanged rather
 * than erroring or duplicating.
 */
export async function createTodo(
  db: D1Database,
  spaceId: string,
  input: TodoCreate,
): Promise<TodoRow> {
  const existing = await getTodo(db, spaceId, input.id);
  if (existing) return existing;

  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO todos (id, space_id, title, notes, list_id, due_at, priority,
         completed, completed_at, parent_todo_id, position, sequence,
         created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?)`,
    )
    .bind(
      input.id, spaceId, input.title, input.notes, input.list_id, input.due_at,
      input.priority, input.completed, input.completed_at, input.parent_todo_id,
      input.position, now, now,
    )
    .run();

  const row = await getTodo(db, spaceId, input.id);
  if (!row) throw new Error("todo vanished immediately after insert");
  return row;
}

/**
 * Partial-merge update. Only columns whose key is PRESENT in `patch` change;
 * an absent key leaves the stored value alone, an explicit `null` clears it.
 * Column names come from a fixed whitelist, never from the request, so a
 * crafted key cannot reach the SQL.
 */
const PATCHABLE = [
  "title", "notes", "list_id", "due_at", "priority",
  "completed", "completed_at", "parent_todo_id", "position",
] as const;

export async function updateTodo(
  db: D1Database,
  spaceId: string,
  id: string,
  patch: TodoUpdate,
): Promise<TodoRow> {
  const existing = await getTodo(db, spaceId, id);
  if (!existing) throw notFound("No such todo.");

  const sets: string[] = [];
  const params: unknown[] = [];
  for (const col of PATCHABLE) {
    if (col in patch) {
      sets.push(`${col} = ?`);
      params.push((patch as Record<string, unknown>)[col]);
    }
  }

  // sequence and updated_at always move on a write; that's the whole point of a
  // write reaching here.
  sets.push("sequence = sequence + 1", "updated_at = ?");
  params.push(new Date().toISOString(), id, spaceId);

  await db
    .prepare(`UPDATE todos SET ${sets.join(", ")} WHERE id = ? AND space_id = ?`)
    .bind(...params)
    .run();

  const row = await getTodo(db, spaceId, id);
  if (!row) throw notFound("No such todo.");
  return row;
}

/**
 * Delete a todo and its subtasks in one batch.
 *
 * Explicit rather than relying on ON DELETE CASCADE: this schema has no foreign
 * keys (the local one didn't either, and D1's PRAGMA wouldn't fire mid-request
 * anyway), so children are removed by hand — matching the local `deleteTodo`.
 */
export async function deleteTodo(db: D1Database, spaceId: string, id: string): Promise<void> {
  await db.batch([
    db
      .prepare("DELETE FROM todos WHERE parent_todo_id = ? AND space_id = ?")
      .bind(id, spaceId),
    db.prepare("DELETE FROM todos WHERE id = ? AND space_id = ?").bind(id, spaceId),
  ]);
}

/**
 * Reorder in one write. Each id is scoped to the space, so an id from another
 * tenant slipped into the list updates nothing rather than reaching across.
 */
export async function reorderTodos(
  db: D1Database,
  spaceId: string,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  const now = new Date().toISOString();
  await db.batch(
    ids.map((id, i) =>
      db
        .prepare("UPDATE todos SET position = ?, updated_at = ? WHERE id = ? AND space_id = ?")
        .bind(i, now, id, spaceId),
    ),
  );
}
