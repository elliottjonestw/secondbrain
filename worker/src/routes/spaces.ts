import { Hono } from "hono";
import {
  customFieldCreateSchema,
  customFieldReorderSchema,
  listCreateSchema,
  listUpdateSchema,
  personCreateSchema,
  personQuerySchema,
  personUpdateSchema,
  reminderCreateSchema,
  reminderQuerySchema,
  reminderUpdateSchema,
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
