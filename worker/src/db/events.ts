import {
  anyTermClause,
  matchQuery,
  queryTerms,
  type EventCreate,
  type EventQuery,
  type EventRow,
  type EventUpdate,
} from "@secondbrain/shared";
import { notFound } from "../http";

/**
 * All SQL touching `events` — the built-in "Second Brain" calendar only.
 * CalDAV calendars are never stored (live fetch by design), so nothing here
 * knows about them; that merge stays entirely client-side in calendars.ts.
 *
 * listEvents returns every event, unfiltered by time: recurrence expansion
 * happens on the client (rrule), so the server can't window a recurring series
 * without re-implementing expansion. The single-user dataset is small enough
 * that returning all rows is cheaper than that complexity.
 */

const COLUMNS = `id, summary, description, location, dtstart, dtend, all_day,
                 rrule, exdates, status, categories, color, sequence,
                 created_at, updated_at`;

export async function listEvents(
  db: D1Database,
  spaceId: string,
  query: EventQuery,
): Promise<EventRow[]> {
  if (query.q && query.q.trim()) return searchEvents(db, spaceId, query.q);
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM events WHERE space_id = ? ORDER BY dtstart ASC`)
    .bind(spaceId)
    .all<EventRow>();
  return results;
}

/** Term search over summary/description/location, ranked with the shared
 *  helpers so it agrees with the global search bar. All-time, like the local
 *  calendar was — the caller (calendars.ts) documents that the window shown to
 *  the user is a CalDAV-only concern. */
async function searchEvents(db: D1Database, spaceId: string, q: string): Promise<EventRow[]> {
  const terms = queryTerms(q.trim());
  if (terms.length === 0) return [];
  const { clause, params } = anyTermClause(terms, ["summary", "description", "location"]);
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM events WHERE space_id = ? AND ${clause}`)
    .bind(spaceId, ...params)
    .all<EventRow>();
  return matchQuery(results, q, (e) => [e.summary, e.description, e.location]).rows;
}

export async function getEvent(db: D1Database, spaceId: string, id: string): Promise<EventRow | null> {
  return db
    .prepare(`SELECT ${COLUMNS} FROM events WHERE id = ? AND space_id = ?`)
    .bind(id, spaceId)
    .first<EventRow>();
}

const WRITABLE = [
  "summary", "description", "location", "dtstart", "dtend", "all_day",
  "rrule", "exdates", "status", "categories", "color",
] as const;

export async function createEvent(
  db: D1Database,
  spaceId: string,
  input: EventCreate,
): Promise<EventRow> {
  const existing = await getEvent(db, spaceId, input.id);
  if (existing) return existing; // idempotent on client id (= iCal UID)

  const now = new Date().toISOString();
  const cols = ["id", "space_id", ...WRITABLE, "sequence", "created_at", "updated_at"];
  const values = [
    input.id, spaceId,
    ...WRITABLE.map((c) => (input as Record<string, unknown>)[c] ?? null),
    0, now, now,
  ];
  await db
    .prepare(`INSERT INTO events (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
    .bind(...values)
    .run();

  const row = await getEvent(db, spaceId, input.id);
  if (!row) throw new Error("event vanished immediately after insert");
  return row;
}

export async function updateEvent(
  db: D1Database,
  spaceId: string,
  id: string,
  patch: EventUpdate,
): Promise<EventRow> {
  const existing = await getEvent(db, spaceId, id);
  if (!existing) throw notFound("No such event.");

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
    .prepare(`UPDATE events SET ${sets.join(", ")} WHERE id = ? AND space_id = ?`)
    .bind(...params)
    .run();

  const row = await getEvent(db, spaceId, id);
  if (!row) throw notFound("No such event.");
  return row;
}

export async function deleteEvent(db: D1Database, spaceId: string, id: string): Promise<void> {
  await db.prepare("DELETE FROM events WHERE id = ? AND space_id = ?").bind(id, spaceId).run();
}
