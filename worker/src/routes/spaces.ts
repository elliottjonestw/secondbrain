import { Hono } from "hono";
import {
  customFieldCreateSchema,
  customFieldReorderSchema,
  eventCreateSchema,
  eventQuerySchema,
  eventUpdateSchema,
  itemTypeSchema,
  linkCreateSchema,
  listCreateSchema,
  listUpdateSchema,
  noteCreateSchema,
  noteImageCreateSchema,
  noteQuerySchema,
  noteUpdateSchema,
  personCreateSchema,
  personQuerySchema,
  personUpdateSchema,
  reminderCreateSchema,
  reminderQuerySchema,
  reminderUpdateSchema,
  tagAttachSchema,
  todoCreateSchema,
  todoQuerySchema,
  todoReorderSchema,
  todoUpdateSchema,
} from "@secondbrain/shared";
import type { AppEnv } from "../env";
import { badRequest, notFound } from "../http";
import { requireAuth } from "../middleware/auth";
import { authorize } from "../authorize";
import { createList, deleteList, listLists, updateList } from "../db/lists";
import {
  createTodo,
  deleteTodo,
  getTodo,
  listTodos,
  reorderTodos,
  updateTodo,
} from "../db/todos";
import {
  createReminder,
  deleteReminder,
  getReminder,
  listReminders,
  updateReminder,
} from "../db/reminders";
import {
  createPerson,
  deleteCustomFieldDef,
  deletePerson,
  ensureCustomField,
  getPerson,
  listCustomFields,
  listPeople,
  reorderCustomFields,
  updatePerson,
} from "../db/people";
import {
  createEvent,
  deleteEvent,
  getEvent,
  listEvents,
  updateEvent,
} from "../db/events";
import {
  createNote,
  deleteNote,
  getNote,
  listNotes,
  updateNote,
} from "../db/notes";
import {
  createNoteImage,
  deleteNoteImageBlobs,
  getNoteImageBytes,
  getNoteImageRow,
} from "../db/images";
import { clearSpaceData, exportTablePage, importTableRows } from "../db/backup";
import {
  createLink,
  deleteLink,
  itemIdsForTag,
  linksForItem,
  listTags,
  removeItemRelations,
  tagItem,
  tagsForItem,
  untagItem,
} from "../db/relations";

/**
 * Space-scoped domain routes: `/v1/spaces/:spaceId/(lists|todos)`.
 *
 * The space in the PATH — not inferred from the token — is what makes
 * `authorize` unmissable and sharing a straight extension: a second member of a
 * space calls the same URL, and only their membership row differs. Every
 * handler here calls `authorize` before any db helper; that is the rule the
 * whole tenancy model rests on.
 */
export const spaces = new Hono<AppEnv>();

// Identity on every route below; the space check is per-handler because it
// needs the action (read vs write).
spaces.use("/spaces/:spaceId/*", requireAuth());

const spaceId = (c: { req: { param: (k: string) => string } }) => c.req.param("spaceId");

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

spaces.get("/spaces/:spaceId/lists", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "read");
  return c.json(await listLists(c.env.DB, spaceId(c)));
});

spaces.post("/spaces/:spaceId/lists", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  const input = listCreateSchema.parse(await c.req.json());
  return c.json(await createList(c.env.DB, spaceId(c), input), 201);
});

spaces.patch("/spaces/:spaceId/lists/:id", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  const patch = listUpdateSchema.parse(await c.req.json());
  return c.json(await updateList(c.env.DB, spaceId(c), c.req.param("id"), patch));
});

spaces.delete("/spaces/:spaceId/lists/:id", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  await deleteList(c.env.DB, spaceId(c), c.req.param("id"));
  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// Todos
// ---------------------------------------------------------------------------

spaces.get("/spaces/:spaceId/todos", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "read");
  const query = todoQuerySchema.parse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );
  // `partial` rides in a header so the body stays a bare row array — the shape
  // db.ts already expects for a list. The assistant reads it to decide whether
  // to confirm a loose match before acting.
  const { rows, partial } = await listTodos(c.env.DB, spaceId(c), query);
  c.header("X-Partial-Match", partial ? "1" : "0");
  return c.json(rows);
});

// The reorder route is declared before "/todos/:id" so "reorder" is never
// swallowed as an id.
spaces.post("/spaces/:spaceId/todos/reorder", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  const { ids } = todoReorderSchema.parse(await c.req.json());
  await reorderTodos(c.env.DB, spaceId(c), ids);
  return c.body(null, 204);
});

spaces.post("/spaces/:spaceId/todos", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  const input = todoCreateSchema.parse(await c.req.json());
  return c.json(await createTodo(c.env.DB, spaceId(c), input), 201);
});

spaces.get("/spaces/:spaceId/todos/:id", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "read");
  const row = await getTodo(c.env.DB, spaceId(c), c.req.param("id"));
  if (!row) throw notFound("No such todo.");
  return c.json(row);
});

spaces.patch("/spaces/:spaceId/todos/:id", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  const body = await c.req.json().catch(() => null);
  if (body === null || typeof body !== "object") throw badRequest("Expected a JSON object.");
  const patch = todoUpdateSchema.parse(body);
  return c.json(await updateTodo(c.env.DB, spaceId(c), c.req.param("id"), patch));
});

spaces.delete("/spaces/:spaceId/todos/:id", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  await deleteTodo(c.env.DB, spaceId(c), c.req.param("id"));
  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

spaces.get("/spaces/:spaceId/reminders", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "read");
  const query = reminderQuerySchema.parse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );
  const { rows, partial } = await listReminders(c.env.DB, spaceId(c), query);
  c.header("X-Partial-Match", partial ? "1" : "0");
  return c.json(rows);
});

spaces.post("/spaces/:spaceId/reminders", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  const input = reminderCreateSchema.parse(await c.req.json());
  return c.json(await createReminder(c.env.DB, spaceId(c), input), 201);
});

spaces.get("/spaces/:spaceId/reminders/:id", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "read");
  const row = await getReminder(c.env.DB, spaceId(c), c.req.param("id"));
  if (!row) throw notFound("No such reminder.");
  return c.json(row);
});

spaces.patch("/spaces/:spaceId/reminders/:id", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  const body = await c.req.json().catch(() => null);
  if (body === null || typeof body !== "object") throw badRequest("Expected a JSON object.");
  const patch = reminderUpdateSchema.parse(body);
  return c.json(await updateReminder(c.env.DB, spaceId(c), c.req.param("id"), patch));
});

spaces.delete("/spaces/:spaceId/reminders/:id", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  await deleteReminder(c.env.DB, spaceId(c), c.req.param("id"));
  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// Custom-field labels (declared before /people/:id so "custom-fields" is never
// read as a person id)
// ---------------------------------------------------------------------------

spaces.get("/spaces/:spaceId/custom-fields", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "read");
  return c.json(await listCustomFields(c.env.DB, spaceId(c)));
});

spaces.post("/spaces/:spaceId/custom-fields", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  const { label } = customFieldCreateSchema.parse(await c.req.json());
  return c.json(await ensureCustomField(c.env.DB, spaceId(c), label), 201);
});

spaces.post("/spaces/:spaceId/custom-fields/reorder", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  const { ids } = customFieldReorderSchema.parse(await c.req.json());
  await reorderCustomFields(c.env.DB, spaceId(c), ids);
  return c.body(null, 204);
});

spaces.delete("/spaces/:spaceId/custom-fields/:id", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  await deleteCustomFieldDef(c.env.DB, spaceId(c), c.req.param("id"));
  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

spaces.get("/spaces/:spaceId/people", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "read");
  const query = personQuerySchema.parse(Object.fromEntries(new URL(c.req.url).searchParams));
  return c.json(await listPeople(c.env.DB, spaceId(c), query));
});

spaces.post("/spaces/:spaceId/people", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  const input = personCreateSchema.parse(await c.req.json());
  return c.json(await createPerson(c.env.DB, spaceId(c), input), 201);
});

spaces.get("/spaces/:spaceId/people/:id", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "read");
  const row = await getPerson(c.env.DB, spaceId(c), c.req.param("id"));
  if (!row) throw notFound("No such person.");
  return c.json(row);
});

spaces.patch("/spaces/:spaceId/people/:id", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  const body = await c.req.json().catch(() => null);
  if (body === null || typeof body !== "object") throw badRequest("Expected a JSON object.");
  const patch = personUpdateSchema.parse(body);
  return c.json(await updatePerson(c.env.DB, spaceId(c), c.req.param("id"), patch));
});

spaces.delete("/spaces/:spaceId/people/:id", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  await deletePerson(c.env.DB, spaceId(c), c.req.param("id"));
  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// Events (the built-in calendar; CalDAV lives only on the client)
// ---------------------------------------------------------------------------

spaces.get("/spaces/:spaceId/events", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "read");
  const query = eventQuerySchema.parse(Object.fromEntries(new URL(c.req.url).searchParams));
  return c.json(await listEvents(c.env.DB, spaceId(c), query));
});

spaces.post("/spaces/:spaceId/events", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  const input = eventCreateSchema.parse(await c.req.json());
  return c.json(await createEvent(c.env.DB, spaceId(c), input), 201);
});

spaces.get("/spaces/:spaceId/events/:id", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "read");
  const row = await getEvent(c.env.DB, spaceId(c), c.req.param("id"));
  if (!row) throw notFound("No such event.");
  return c.json(row);
});

spaces.patch("/spaces/:spaceId/events/:id", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  const body = await c.req.json().catch(() => null);
  if (body === null || typeof body !== "object") throw badRequest("Expected a JSON object.");
  const patch = eventUpdateSchema.parse(body);
  return c.json(await updateEvent(c.env.DB, spaceId(c), c.req.param("id"), patch));
});

spaces.delete("/spaces/:spaceId/events/:id", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  await deleteEvent(c.env.DB, spaceId(c), c.req.param("id"));
  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// Notes (markdown + trigram FTS). Images arrive in M4b.
// ---------------------------------------------------------------------------

spaces.get("/spaces/:spaceId/notes", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "read");
  const query = noteQuerySchema.parse(Object.fromEntries(new URL(c.req.url).searchParams));
  return c.json(await listNotes(c.env.DB, spaceId(c), query));
});

spaces.post("/spaces/:spaceId/notes", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  const input = noteCreateSchema.parse(await c.req.json());
  return c.json(await createNote(c.env.DB, spaceId(c), input), 201);
});

spaces.get("/spaces/:spaceId/notes/:id", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "read");
  const row = await getNote(c.env.DB, spaceId(c), c.req.param("id"));
  if (!row) throw notFound("No such note.");
  return c.json(row);
});

spaces.patch("/spaces/:spaceId/notes/:id", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  const body = await c.req.json().catch(() => null);
  if (body === null || typeof body !== "object") throw badRequest("Expected a JSON object.");
  const patch = noteUpdateSchema.parse(body);
  return c.json(await updateNote(c.env.DB, spaceId(c), c.req.param("id"), patch));
});

spaces.delete("/spaces/:spaceId/notes/:id", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  // deleteNote removes the note + its image ROWS and returns the blob keys;
  // purge the values too, so a deleted note leaves nothing behind in KV.
  const keys = await deleteNote(c.env.DB, spaceId(c), c.req.param("id"));
  await deleteNoteImageBlobs(c.env.IMAGES, keys);
  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// Note images (bytes in KV, metadata in D1)
// ---------------------------------------------------------------------------

spaces.post("/spaces/:spaceId/notes/:noteId/images", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  const input = noteImageCreateSchema.parse(await c.req.json());
  const meta = await createNoteImage(
    c.env.DB, c.env.IMAGES, spaceId(c), c.req.param("noteId"), input,
  );
  return c.json(meta, 201);
});

spaces.get("/spaces/:spaceId/images/:id", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "read");
  const row = await getNoteImageRow(c.env.DB, spaceId(c), c.req.param("id"));
  if (!row) throw notFound("No such image.");
  const bytes = await getNoteImageBytes(c.env.IMAGES, row);
  if (!bytes) throw notFound("Image bytes are missing.");

  // Dimensions ride in headers so the client can size the <img> before decode
  // without a second round-trip; they're in exposeHeaders so a browser build
  // can read them. An image is immutable for its id, so it caches hard.
  c.header("Content-Type", row.mime);
  c.header("X-Image-Width", String(row.width));
  c.header("X-Image-Height", String(row.height));
  c.header("Cache-Control", "private, max-age=31536000, immutable");
  return c.body(bytes);
});

// ---------------------------------------------------------------------------
// Tags + links (cross-cutting). `:type` is validated against the ItemType enum
// so a bad path segment is a 400, not an SQL surprise.
// ---------------------------------------------------------------------------

const itemType = (c: { req: { param: (k: string) => string } }) =>
  itemTypeSchema.parse(c.req.param("type"));

spaces.get("/spaces/:spaceId/tags", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "read");
  return c.json(await listTags(c.env.DB, spaceId(c)));
});

spaces.get("/spaces/:spaceId/tags/:name/item-ids", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "read");
  const type = itemTypeSchema.parse(new URL(c.req.url).searchParams.get("type"));
  const ids = await itemIdsForTag(c.env.DB, spaceId(c), type, c.req.param("name"));
  return c.json(ids);
});

spaces.get("/spaces/:spaceId/items/:type/:id/tags", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "read");
  return c.json(await tagsForItem(c.env.DB, spaceId(c), itemType(c), c.req.param("id")));
});

spaces.post("/spaces/:spaceId/items/:type/:id/tags", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  const { name } = tagAttachSchema.parse(await c.req.json());
  return c.json(await tagItem(c.env.DB, spaceId(c), itemType(c), c.req.param("id"), name), 201);
});

spaces.delete("/spaces/:spaceId/items/:type/:id/tags/:tagId", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  await untagItem(c.env.DB, spaceId(c), itemType(c), c.req.param("id"), c.req.param("tagId"));
  return c.body(null, 204);
});

spaces.get("/spaces/:spaceId/items/:type/:id/links", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "read");
  return c.json(await linksForItem(c.env.DB, spaceId(c), itemType(c), c.req.param("id")));
});

// Deletes every tag and link touching an item — called when the item itself is
// deleted (the item's own row is removed by its domain endpoint).
spaces.delete("/spaces/:spaceId/items/:type/:id/relations", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  await removeItemRelations(c.env.DB, spaceId(c), itemType(c), c.req.param("id"));
  return c.body(null, 204);
});

spaces.post("/spaces/:spaceId/links", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  const input = linkCreateSchema.parse(await c.req.json());
  return c.json(await createLink(c.env.DB, spaceId(c), input), 201);
});

spaces.delete("/spaces/:spaceId/links/:id", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  await deleteLink(c.env.DB, spaceId(c), c.req.param("id"));
  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// Backup: logical export/import, and the destructive "clear all data" wipe.
//
// Logical rather than a platform dump because `wrangler d1 export` refuses a
// database containing virtual tables and `notes_fts` is one. Paginated one
// table at a time because the free plan caps CPU at 10 ms per request, and
// serializing a whole account in one response is precisely the shape that
// breaks once a user's data grows. The client walks the tables.
// ---------------------------------------------------------------------------

spaces.get("/spaces/:spaceId/export/:table", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "read");
  const url = new URL(c.req.url);
  const limit = Math.min(Number(url.searchParams.get("limit")) || 500, 1000);
  try {
    return c.json(
      await exportTablePage(
        c.env.DB, spaceId(c), c.req.param("table"), url.searchParams.get("cursor"), limit,
      ),
    );
  } catch {
    throw badRequest("Unknown table.");
  }
});

// Additive: the client clears first, then posts each table. A restore is
// therefore several requests, and the client is responsible for ordering them —
// which is safe because the schema has no foreign keys at all (see CLAUDE.md).
spaces.post("/spaces/:spaceId/import/:table", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  const body = await c.req.json().catch(() => null);
  if (!body || !Array.isArray(body.rows)) throw badRequest("Expected { rows: [...] }.");
  if (body.rows.length > 1000) throw badRequest("Too many rows in one batch (max 1000).");
  try {
    const inserted = await importTableRows(c.env.DB, spaceId(c), c.req.param("table"), body.rows);
    return c.json({ inserted });
  } catch (err) {
    throw badRequest(err instanceof Error ? err.message : "Invalid rows.");
  }
});

// Wipes the space's content. Membership and the space itself survive — this is
// "empty my account", not "delete my account".
spaces.post("/spaces/:spaceId/data/clear", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  const keys = await clearSpaceData(c.env.DB, spaceId(c));
  await deleteNoteImageBlobs(c.env.IMAGES, keys);
  return c.body(null, 204);
});
