// AI assistant — read-only, tool-calling architecture.
//
// Instead of stuffing the entire dataset into every request (which doesn't
// scale), the model is given a set of read-only *tools* and pulls only the data
// it needs to answer a question. Every tool is filtered, paginated (bounded
// `limit`), and reports a `total` count + `truncated` flag, so large datasets
// never blow the context window. This also lays the groundwork for future
// write tools: adding them is just more entries in TOOLS + executeTool.
//
// Requests go through tauri-plugin-http's fetch (runs in Rust), which bypasses
// the browser CORS restriction that blocks calling api.openai.com from the
// webview.

import { fetch } from "@tauri-apps/plugin-http";
import { format } from "date-fns";
import type { EventRow, ItemType } from "../types";
import {
  db, listLists, listTags, linksForItem, tagsForItem, getItemLabel,
  upsertTodo, upsertEvent, upsertReminder, upsertNote, upsertList, tagItem, nowIso,
} from "../db";
import { expandEvents } from "./recurrence";
import { getSettings } from "./settings";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

// Internal OpenAI wire-format message (includes tool plumbing the UI never sees).
interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
interface OAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

const PRIORITY = ["none", "low", "medium", "high"];
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const MAX_TOOL_ROUNDS = 8; // safety cap on the agentic loop

function clampLimit(n: unknown): number {
  const v = typeof n === "number" && n > 0 ? Math.floor(n) : DEFAULT_LIMIT;
  return Math.min(v, MAX_LIMIT);
}

function parseDate(s: unknown, endOfDay = false): Date | null {
  if (typeof s !== "string" || !s.trim()) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s.trim());
  const d = new Date(dateOnly ? `${s.trim()}T${endOfDay ? "23:59:59" : "00:00:00"}` : s);
  return isNaN(d.getTime()) ? null : d;
}

/** Coerce a value to an ISO string, or null if absent/invalid. */
function asIso(v: unknown, endOfDay = false): string | null {
  const d = parseDate(v, endOfDay);
  return d ? d.toISOString() : null;
}

/** Coerce a priority value (0–3 or a name) to an integer. */
function asPriority(v: unknown): number {
  if (typeof v === "number") return Math.max(0, Math.min(3, Math.floor(v)));
  const i = PRIORITY.indexOf(String(v ?? "").toLowerCase());
  return i >= 0 ? i : 0;
}

const WRITE_TABLES = { event: "events", reminder: "reminders", todo: "todos", note: "notes" } as const;

async function getRowById(table: string, id: unknown): Promise<any | null> {
  if (typeof id !== "string" || !id) return null;
  const d = await db();
  const rows = await d.select<any[]>(`SELECT * FROM ${table} WHERE id = ?`, [id]);
  return rows[0] ?? null;
}

/** Resolve a list name to its id (case-insensitive); null if not found. */
async function resolveListId(name: unknown): Promise<string | null> {
  if (typeof name !== "string" || !name.trim()) return null;
  const lists = await listLists();
  return lists.find((l) => l.name.toLowerCase() === name.trim().toLowerCase())?.id ?? null;
}

/** item_ids that carry a given tag name, for a given item type. */
async function idsForTag(type: string, tagName: string): Promise<Set<string>> {
  const d = await db();
  const rows = await d.select<{ item_id: string }[]>(
    "SELECT it.item_id FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_type = ? AND t.name = ?",
    [type, tagName],
  );
  return new Set(rows.map((r) => r.item_id));
}

// ---------------------------------------------------------------------------
// Tool schemas advertised to the model (OpenAI function-calling format)
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_overview",
      description:
        "Get a high-level overview of the user's data: counts of events/todos/reminders/notes, the names of all lists and tags, and the current date/time. Call this first when you need orientation.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "search_todos",
      description: "Search to-do tasks with optional filters. Returns compact records including ids.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Case-insensitive text to match in the title or notes." },
          list: { type: "string", description: "List name to filter by (e.g. 'Work')." },
          status: { type: "string", enum: ["all", "active", "completed"], description: "Default 'active'." },
          min_priority: { type: "integer", description: "0 none, 1 low, 2 medium, 3 high." },
          due_before: { type: "string", description: "ISO date/datetime; only tasks due before this." },
          due_after: { type: "string", description: "ISO date/datetime; only tasks due after this." },
          tag: { type: "string", description: "Tag name (without #)." },
          limit: { type: "integer", description: `Max results (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).` },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_events",
      description:
        "Get calendar events within a date range. Recurring events are expanded into concrete occurrences. If start/end are omitted, defaults to the next 30 days.",
      parameters: {
        type: "object",
        properties: {
          start: { type: "string", description: "ISO date/datetime for the window start." },
          end: { type: "string", description: "ISO date/datetime for the window end." },
          query: { type: "string", description: "Case-insensitive text to match in the summary/description/location." },
          tag: { type: "string", description: "Tag name (without #)." },
          limit: { type: "integer", description: `Max occurrences (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).` },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_reminders",
      description: "Search reminders with optional filters. Returns compact records including ids.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Case-insensitive text to match in the title or notes." },
          status: { type: "string", enum: ["all", "active", "completed"], description: "Default 'active'." },
          flagged: { type: "boolean", description: "Only priority > 0 when true." },
          due_before: { type: "string", description: "ISO date/datetime." },
          due_after: { type: "string", description: "ISO date/datetime." },
          tag: { type: "string", description: "Tag name (without #)." },
          limit: { type: "integer", description: `Max results (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).` },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_notes",
      description:
        "Full-text search over notes by keyword (returns title + body snippet), or the most recent notes when no query is given.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keywords for full-text search." },
          pinned: { type: "boolean", description: "Only pinned notes when true." },
          limit: { type: "integer", description: `Max results (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).` },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_item",
      description:
        "Fetch the full detail of a single item by type and id, including its tags and any linked items. Use ids returned by the search tools.",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["event", "reminder", "todo", "note"] },
          id: { type: "string" },
        },
        required: ["type", "id"],
      },
    },
  },

  // ---- Write tools (create / update). No delete tools by design. ----
  {
    type: "function",
    function: {
      name: "create_todo",
      description: "Create a new to-do task. Confirm ambiguous details with the user before creating.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          list: { type: "string", description: "List name; falls back to the first list if unknown." },
          notes: { type: "string" },
          due_at: { type: "string", description: "ISO date/datetime." },
          priority: { type: "integer", description: "0 none, 1 low, 2 medium, 3 high." },
          parent_todo_id: { type: "string", description: "Make this a subtask of the given to-do id." },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_todo",
      description: "Update fields of an existing to-do by id. Only include the fields you want to change. Use completed to mark done/undone.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          list: { type: "string" },
          notes: { type: "string" },
          due_at: { type: "string", description: "ISO date/datetime, or null to clear." },
          priority: { type: "integer" },
          completed: { type: "boolean" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_event",
      description: "Create a new calendar event. Confirm ambiguous details with the user before creating.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string" },
          start: { type: "string", description: "ISO date/datetime (required)." },
          end: { type: "string", description: "ISO datetime; defaults to 1 hour after start." },
          all_day: { type: "boolean" },
          location: { type: "string" },
          description: { type: "string" },
          rrule: { type: "string", description: "RFC 5545 recurrence, e.g. FREQ=WEEKLY;BYDAY=MO,WE,FR." },
          category: { type: "string" },
        },
        required: ["summary", "start"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_event",
      description: "Update fields of an existing event by id. Only include the fields you want to change.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          summary: { type: "string" },
          start: { type: "string", description: "ISO date/datetime." },
          end: { type: "string", description: "ISO datetime, or null to clear." },
          all_day: { type: "boolean" },
          location: { type: "string" },
          description: { type: "string" },
          rrule: { type: "string", description: "RFC 5545 recurrence, or null to stop repeating." },
          category: { type: "string" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_reminder",
      description: "Create a new reminder. Confirm ambiguous details with the user before creating.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          due_at: { type: "string", description: "ISO date/datetime." },
          remind_at: { type: "string", description: "ISO datetime for the alert." },
          rrule: { type: "string", description: "RFC 5545 recurrence." },
          priority: { type: "integer" },
          notes: { type: "string" },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_reminder",
      description: "Update fields of an existing reminder by id. Only include the fields you want to change. Use completed to mark done/undone.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          due_at: { type: "string", description: "ISO, or null to clear." },
          remind_at: { type: "string", description: "ISO, or null to clear." },
          rrule: { type: "string", description: "RFC 5545, or null to stop repeating." },
          priority: { type: "integer" },
          notes: { type: "string" },
          completed: { type: "boolean" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_note",
      description: "Create a new markdown note.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          body: { type: "string", description: "Markdown content." },
          pinned: { type: "boolean" },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_note",
      description: "Update fields of an existing note by id. Only include the fields you want to change.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          body: { type: "string" },
          pinned: { type: "boolean" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_list",
      description: "Create a new to-do list.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          color: { type: "string", description: "Hex color, e.g. #3b82f6." },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_tag",
      description: "Attach a tag to an item (creating the tag if needed).",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["event", "reminder", "todo", "note"] },
          id: { type: "string" },
          tag: { type: "string", description: "Tag name without the leading #." },
        },
        required: ["type", "id", "tag"],
      },
    },
  },
] as const;

// ---------------------------------------------------------------------------
// Tool executors (read-only)
// ---------------------------------------------------------------------------
async function toolGetOverview() {
  const d = await db();
  const one = async (sql: string) => (await d.select<{ n: number }[]>(sql))[0]?.n ?? 0;
  const [lists, tags] = await Promise.all([listLists(), listTags()]);
  return {
    now: new Date().toISOString(),
    now_readable: format(new Date(), "EEEE MMMM d, yyyy, h:mm a"),
    counts: {
      events: await one("SELECT COUNT(*) n FROM events"),
      todos: await one("SELECT COUNT(*) n FROM todos"),
      todos_active: await one("SELECT COUNT(*) n FROM todos WHERE completed = 0"),
      reminders: await one("SELECT COUNT(*) n FROM reminders"),
      reminders_active: await one("SELECT COUNT(*) n FROM reminders WHERE completed = 0"),
      notes: await one("SELECT COUNT(*) n FROM notes"),
    },
    lists: lists.map((l) => l.name),
    tags: tags.map((t) => t.name),
  };
}

async function toolSearchTodos(args: Record<string, unknown>) {
  const d = await db();
  const where: string[] = [];
  const params: unknown[] = [];

  const status = (args.status as string) ?? "active";
  if (status === "active") where.push("t.completed = 0");
  else if (status === "completed") where.push("t.completed = 1");

  if (typeof args.query === "string" && args.query.trim()) {
    where.push("(t.title LIKE ? OR t.notes LIKE ?)");
    const like = `%${args.query.trim()}%`;
    params.push(like, like);
  }
  if (typeof args.list === "string" && args.list.trim()) {
    where.push("l.name = ?");
    params.push(args.list.trim());
  }
  if (typeof args.min_priority === "number") {
    where.push("t.priority >= ?");
    params.push(args.min_priority);
  }
  const dueBefore = parseDate(args.due_before, true);
  if (dueBefore) { where.push("t.due_at IS NOT NULL AND t.due_at <= ?"); params.push(dueBefore.toISOString()); }
  const dueAfter = parseDate(args.due_after);
  if (dueAfter) { where.push("t.due_at IS NOT NULL AND t.due_at >= ?"); params.push(dueAfter.toISOString()); }

  let tagIds: Set<string> | null = null;
  if (typeof args.tag === "string" && args.tag.trim()) tagIds = await idsForTag("todo", args.tag.trim());

  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = await d.select<any[]>(
    `SELECT t.*, l.name AS list_name FROM todos t LEFT JOIN lists l ON l.id = t.list_id
     ${clause} ORDER BY t.completed ASC, t.due_at IS NULL, t.due_at ASC`,
    params,
  );
  const filtered = tagIds ? rows.filter((r) => tagIds!.has(r.id)) : rows;
  const limit = clampLimit(args.limit);
  return {
    total: filtered.length,
    truncated: filtered.length > limit,
    results: filtered.slice(0, limit).map((t) => ({
      id: t.id, title: t.title, list: t.list_name, completed: !!t.completed,
      due_at: t.due_at, priority: PRIORITY[t.priority] ?? t.priority,
      is_subtask: !!t.parent_todo_id, notes: t.notes || undefined,
    })),
  };
}

async function toolSearchEvents(args: Record<string, unknown>) {
  const start = parseDate(args.start) ?? new Date();
  const end = parseDate(args.end, true) ?? new Date(Date.now() + 30 * 864e5);

  // Scale-conscious pre-filter: always load recurring events (must be expanded),
  // but only the non-recurring events that overlap the window.
  const d = await db();
  const rows = await d.select<EventRow[]>(
    `SELECT * FROM events WHERE rrule IS NOT NULL
       OR (dtstart <= ? AND COALESCE(dtend, dtstart) >= ?)`,
    [end.toISOString(), start.toISOString()],
  );

  let occs = expandEvents(rows, start, end);

  if (typeof args.query === "string" && args.query.trim()) {
    const q = args.query.trim().toLowerCase();
    occs = occs.filter((o) =>
      [o.event.summary, o.event.description, o.event.location]
        .some((f) => (f ?? "").toLowerCase().includes(q)),
    );
  }
  if (typeof args.tag === "string" && args.tag.trim()) {
    const tagIds = await idsForTag("event", args.tag.trim());
    occs = occs.filter((o) => tagIds.has(o.event.id));
  }

  const limit = clampLimit(args.limit);
  return {
    range: { start: start.toISOString(), end: end.toISOString() },
    total: occs.length,
    truncated: occs.length > limit,
    results: occs.slice(0, limit).map((o) => ({
      id: o.event.id, summary: o.event.summary,
      start: o.start.toISOString(), end: o.end ? o.end.toISOString() : null,
      all_day: !!o.event.all_day, recurring: o.isRecurringInstance,
      location: o.event.location || undefined,
    })),
  };
}

async function toolSearchReminders(args: Record<string, unknown>) {
  const d = await db();
  const where: string[] = [];
  const params: unknown[] = [];

  const status = (args.status as string) ?? "active";
  if (status === "active") where.push("completed = 0");
  else if (status === "completed") where.push("completed = 1");

  if (typeof args.query === "string" && args.query.trim()) {
    where.push("(title LIKE ? OR notes LIKE ?)");
    const like = `%${args.query.trim()}%`;
    params.push(like, like);
  }
  if (args.flagged === true) where.push("priority > 0");
  const dueBefore = parseDate(args.due_before, true);
  if (dueBefore) { where.push("COALESCE(remind_at, due_at) <= ?"); params.push(dueBefore.toISOString()); }
  const dueAfter = parseDate(args.due_after);
  if (dueAfter) { where.push("COALESCE(remind_at, due_at) >= ?"); params.push(dueAfter.toISOString()); }

  let tagIds: Set<string> | null = null;
  if (typeof args.tag === "string" && args.tag.trim()) tagIds = await idsForTag("reminder", args.tag.trim());

  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = await d.select<any[]>(
    `SELECT * FROM reminders ${clause} ORDER BY completed ASC, COALESCE(remind_at, due_at) IS NULL, COALESCE(remind_at, due_at) ASC`,
    params,
  );
  const filtered = tagIds ? rows.filter((r) => tagIds!.has(r.id)) : rows;
  const limit = clampLimit(args.limit);
  return {
    total: filtered.length,
    truncated: filtered.length > limit,
    results: filtered.slice(0, limit).map((r) => ({
      id: r.id, title: r.title, completed: !!r.completed,
      due_at: r.due_at, remind_at: r.remind_at, repeats: r.rrule || undefined,
      priority: PRIORITY[r.priority] ?? r.priority, notes: r.notes || undefined,
    })),
  };
}

async function toolSearchNotes(args: Record<string, unknown>) {
  const d = await db();
  const limit = clampLimit(args.limit);
  const q = typeof args.query === "string" ? args.query.trim() : "";

  let rows: any[];
  if (q) {
    // FTS via searchNotes-style query, but inline so we can also apply pinned filter.
    const match = q.split(/\s+/).map((t) => t.replace(/["*]/g, "")).filter(Boolean).map((t) => `${t}*`).join(" ");
    try {
      rows = await d.select<any[]>(
        `SELECT n.* FROM notes n JOIN notes_fts f ON f.rowid = n.rowid WHERE notes_fts MATCH ? ORDER BY rank`,
        [match],
      );
    } catch {
      const like = `%${q}%`;
      rows = await d.select<any[]>("SELECT * FROM notes WHERE title LIKE ? OR body LIKE ? ORDER BY updated_at DESC", [like, like]);
    }
  } else {
    rows = await d.select<any[]>("SELECT * FROM notes ORDER BY pinned DESC, updated_at DESC");
  }
  if (args.pinned === true) rows = rows.filter((n) => n.pinned === 1);

  return {
    total: rows.length,
    truncated: rows.length > limit,
    results: rows.slice(0, limit).map((n) => ({
      id: n.id, title: n.title || "Untitled", pinned: !!n.pinned,
      snippet: (n.body ?? "").replace(/\s+/g, " ").slice(0, 400),
      updated_at: n.updated_at,
    })),
  };
}

async function toolGetItem(args: Record<string, unknown>) {
  const type = args.type as string;
  const id = args.id as string;
  const table = { event: "events", reminder: "reminders", todo: "todos", note: "notes" }[type];
  if (!table || !id) return { error: "Provide a valid type (event|reminder|todo|note) and id." };

  const d = await db();
  const rows = await d.select<any[]>(`SELECT * FROM ${table} WHERE id = ?`, [id]);
  const item = rows[0];
  if (!item) return { error: `No ${type} found with id ${id}.` };

  const tags = (await tagsForItem(type as any, id)).map((t) => t.name);
  const links = await linksForItem(type as any, id);
  const linked = await Promise.all(links.map(async (l) => {
    const other = l.source_type === type && l.source_id === id
      ? { t: l.target_type, i: l.target_id }
      : { t: l.source_type, i: l.source_id };
    return { type: other.t, id: other.i, label: await getItemLabel(other.t, other.i) };
  }));

  return { type, item, tags, linked };
}

// ---------------------------------------------------------------------------
// Tool executors (write: create / update). No delete tools by design; all
// changes are reversible by the user in the UI.
// ---------------------------------------------------------------------------
async function toolCreateTodo(args: Record<string, unknown>) {
  if (typeof args.title !== "string" || !args.title.trim()) return { error: "title is required." };
  const lists = await listLists();
  const listId = (await resolveListId(args.list)) ?? lists[0]?.id ?? null;
  const id = await upsertTodo({
    title: args.title.trim(),
    notes: typeof args.notes === "string" ? args.notes : null,
    list_id: listId,
    due_at: asIso(args.due_at),
    priority: asPriority(args.priority),
    completed: 0, completed_at: null,
    parent_todo_id: typeof args.parent_todo_id === "string" ? args.parent_todo_id : null,
    position: null,
  });
  return { ok: true, id, list: lists.find((l) => l.id === listId)?.name };
}

async function toolUpdateTodo(args: Record<string, unknown>) {
  const t = await getRowById("todos", args.id);
  if (!t) return { error: `No todo found with id ${args.id}.` };
  const listId = "list" in args ? (await resolveListId(args.list)) ?? t.list_id : t.list_id;
  const completed = "completed" in args ? (args.completed ? 1 : 0) : t.completed;
  await upsertTodo({
    id: t.id,
    title: "title" in args ? String(args.title) : t.title,
    notes: "notes" in args ? (args.notes as string | null) : t.notes,
    list_id: listId,
    due_at: "due_at" in args ? asIso(args.due_at) : t.due_at,
    priority: "priority" in args ? asPriority(args.priority) : t.priority,
    completed,
    completed_at: completed ? (t.completed_at ?? nowIso()) : null,
    parent_todo_id: t.parent_todo_id,
    position: t.position,
  });
  return { ok: true, id: t.id };
}

async function toolCreateEvent(args: Record<string, unknown>) {
  if (typeof args.summary !== "string" || !args.summary.trim()) return { error: "summary is required." };
  const dtstart = asIso(args.start);
  if (!dtstart) return { error: "A valid ISO start is required." };
  const allDay = args.all_day === true;
  const dtend = allDay ? null : (asIso(args.end) ?? new Date(new Date(dtstart).getTime() + 3600e3).toISOString());
  const id = await upsertEvent({
    summary: args.summary.trim(),
    description: typeof args.description === "string" ? args.description : null,
    location: typeof args.location === "string" ? args.location : null,
    dtstart, dtend, all_day: allDay ? 1 : 0,
    rrule: typeof args.rrule === "string" ? args.rrule : null,
    exdates: null, status: "CONFIRMED",
    categories: typeof args.category === "string" ? JSON.stringify([args.category]) : null,
    color: null,
  });
  return { ok: true, id };
}

async function toolUpdateEvent(args: Record<string, unknown>) {
  const e = await getRowById("events", args.id);
  if (!e) return { error: `No event found with id ${args.id}.` };
  const allDay = "all_day" in args ? (args.all_day ? 1 : 0) : e.all_day;
  await upsertEvent({
    id: e.id,
    summary: "summary" in args ? String(args.summary) : e.summary,
    description: "description" in args ? (args.description as string | null) : e.description,
    location: "location" in args ? (args.location as string | null) : e.location,
    dtstart: "start" in args ? (asIso(args.start) ?? e.dtstart) : e.dtstart,
    dtend: "end" in args ? asIso(args.end) : e.dtend,
    all_day: allDay,
    rrule: "rrule" in args ? (args.rrule ? String(args.rrule) : null) : e.rrule,
    exdates: e.exdates,
    status: e.status,
    categories: "category" in args ? (args.category ? JSON.stringify([args.category]) : null) : e.categories,
    color: e.color,
  });
  return { ok: true, id: e.id };
}

async function toolCreateReminder(args: Record<string, unknown>) {
  if (typeof args.title !== "string" || !args.title.trim()) return { error: "title is required." };
  const id = await upsertReminder({
    title: args.title.trim(),
    notes: typeof args.notes === "string" ? args.notes : null,
    due_at: asIso(args.due_at),
    remind_at: asIso(args.remind_at),
    rrule: typeof args.rrule === "string" ? args.rrule : null,
    priority: asPriority(args.priority),
    completed: 0, completed_at: null, linked_todo_id: null,
  });
  return { ok: true, id };
}

async function toolUpdateReminder(args: Record<string, unknown>) {
  const r = await getRowById("reminders", args.id);
  if (!r) return { error: `No reminder found with id ${args.id}.` };
  const completed = "completed" in args ? (args.completed ? 1 : 0) : r.completed;
  await upsertReminder({
    id: r.id,
    title: "title" in args ? String(args.title) : r.title,
    notes: "notes" in args ? (args.notes as string | null) : r.notes,
    due_at: "due_at" in args ? asIso(args.due_at) : r.due_at,
    remind_at: "remind_at" in args ? asIso(args.remind_at) : r.remind_at,
    rrule: "rrule" in args ? (args.rrule ? String(args.rrule) : null) : r.rrule,
    priority: "priority" in args ? asPriority(args.priority) : r.priority,
    completed,
    completed_at: completed ? (r.completed_at ?? nowIso()) : null,
    linked_todo_id: r.linked_todo_id,
  });
  return { ok: true, id: r.id };
}

async function toolCreateNote(args: Record<string, unknown>) {
  if (typeof args.title !== "string" && typeof args.body !== "string") return { error: "Provide a title and/or body." };
  const id = await upsertNote({
    title: typeof args.title === "string" ? args.title : "Untitled",
    body: typeof args.body === "string" ? args.body : "",
    pinned: args.pinned === true ? 1 : 0,
  });
  return { ok: true, id };
}

async function toolUpdateNote(args: Record<string, unknown>) {
  const n = await getRowById("notes", args.id);
  if (!n) return { error: `No note found with id ${args.id}.` };
  await upsertNote({
    id: n.id,
    title: "title" in args ? (args.title as string | null) : n.title,
    body: "body" in args ? (args.body as string | null) : n.body,
    pinned: "pinned" in args ? (args.pinned ? 1 : 0) : n.pinned,
  });
  return { ok: true, id: n.id };
}

async function toolCreateList(args: Record<string, unknown>) {
  if (typeof args.name !== "string" || !args.name.trim()) return { error: "name is required." };
  const id = await upsertList({ name: args.name.trim(), color: typeof args.color === "string" ? args.color : null });
  return { ok: true, id };
}

async function toolAddTag(args: Record<string, unknown>) {
  const type = args.type as string;
  const id = args.id as string;
  const tag = args.tag as string;
  if (!(type in WRITE_TABLES) || !id || typeof tag !== "string" || !tag.trim()) {
    return { error: "Provide type, id, and a non-empty tag." };
  }
  const existing = await getRowById(WRITE_TABLES[type as ItemType], id);
  if (!existing) return { error: `No ${type} found with id ${id}.` };
  await tagItem(tag.trim().replace(/^#/, ""), type as ItemType, id);
  return { ok: true };
}

async function executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    // read
    case "get_overview": return toolGetOverview();
    case "search_todos": return toolSearchTodos(args);
    case "search_events": return toolSearchEvents(args);
    case "search_reminders": return toolSearchReminders(args);
    case "search_notes": return toolSearchNotes(args);
    case "get_item": return toolGetItem(args);
    // write
    case "create_todo": return toolCreateTodo(args);
    case "update_todo": return toolUpdateTodo(args);
    case "create_event": return toolCreateEvent(args);
    case "update_event": return toolUpdateEvent(args);
    case "create_reminder": return toolCreateReminder(args);
    case "update_reminder": return toolUpdateReminder(args);
    case "create_note": return toolCreateNote(args);
    case "update_note": return toolUpdateNote(args);
    case "create_list": return toolCreateList(args);
    case "add_tag": return toolAddTag(args);
    default: return { error: `Unknown tool: ${name}` };
  }
}

// Human-readable status shown in the UI while a tool runs.
function statusFor(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "get_overview": return "Getting an overview…";
    case "search_todos": return "Searching to-dos…";
    case "search_events": return "Checking the calendar…";
    case "search_reminders": return "Searching reminders…";
    case "search_notes": return args.query ? `Searching notes for "${args.query}"…` : "Looking through notes…";
    case "get_item": return "Fetching details…";
    case "create_todo": return "Creating a to-do…";
    case "update_todo": return "Updating a to-do…";
    case "create_event": return "Adding a calendar event…";
    case "update_event": return "Updating an event…";
    case "create_reminder": return "Creating a reminder…";
    case "update_reminder": return "Updating a reminder…";
    case "create_note": return "Creating a note…";
    case "update_note": return "Updating a note…";
    case "create_list": return "Creating a list…";
    case "add_tag": return "Adding a tag…";
    default: return "Working…";
  }
}

const SYSTEM_PROMPT =
  "You are a helpful personal assistant embedded in a local life-management app called Second Brain. " +
  "You help the user with THEIR data — calendar events, reminders, to-dos, notes, lists, and tags.\n\n" +
  "You can both READ and WRITE data:\n" +
  "- Read/lookup tools: get_overview, search_todos, search_events, search_reminders, search_notes, get_item.\n" +
  "- Create/update tools: create_todo, update_todo, create_event, update_event, create_reminder, " +
  "update_reminder, create_note, update_note, create_list, add_tag.\n" +
  "There are NO delete tools — you cannot delete anything; if asked to delete, say the user must do that in the app.\n\n" +
  "Guidelines:\n" +
  "- Never assume or invent data; use the read tools to look things up first. To update or tag an existing item, " +
  "find its id with a search tool before calling the write tool.\n" +
  "- Prefer specific, filtered queries (by date range, list, tag, or keyword). If a tool reports `truncated: true`, " +
  "narrow your filters rather than assuming you've seen everything.\n" +
  "- Before creating or updating, make sure the request is clear. If key details are ambiguous (which item, what " +
  "date/time, which list), ask a brief clarifying question instead of guessing. For clearly-specified requests, just " +
  "do it.\n" +
  "- Interpret relative dates/times (\"tomorrow at 3pm\", \"next Friday\") against the current date, and pass concrete " +
  "ISO 8601 values to the tools.\n" +
  "- After making changes, briefly confirm exactly what you created or updated. Answer concisely and specifically.";

async function callOpenAI(model: string, key: string, messages: OAIMessage[]) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, tools: TOOLS, tool_choice: "auto", temperature: 0.2 }),
  });
  if (!res.ok) {
    let detail = "";
    try { const err = await res.json(); detail = err?.error?.message ?? JSON.stringify(err); }
    catch { detail = await res.text(); }
    throw new Error(`OpenAI error (${res.status}): ${detail}`);
  }
  return res.json();
}

export interface AskOptions {
  onStatus?: (text: string) => void;
}

/**
 * Ask the assistant a question. Runs an agentic loop: the model may call
 * read-only tools (possibly several rounds) before producing a final answer.
 */
export async function askAssistant(history: ChatMessage[], opts: AskOptions = {}): Promise<string> {
  const { openaiApiKey, openaiModel } = getSettings();
  const key = openaiApiKey.trim();
  if (!key) throw new Error("No OpenAI API key set. Add one in Settings.");

  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";
  const localIso = format(now, "yyyy-MM-dd'T'HH:mm:ssXXX"); // e.g. 2026-07-20T14:30:00+08:00
  const dateContext =
    `\n\nThe current date and time is ${format(now, "EEEE, MMMM d, yyyy, h:mm a")} in the user's ` +
    `local timezone (${tz}, ISO ${localIso}). Interpret ALL dates and clock times the user mentions ` +
    `(\"10am\", \"today\", \"tomorrow\", \"next Friday\", \"in 2 hours\") in this local timezone, using the ` +
    `correct current year. When passing datetimes to tools, write ISO 8601 with the user's local UTC ` +
    `offset (like ${localIso}). Do NOT use UTC or a trailing \"Z\" — that would save the event at the ` +
    `wrong hour.`;

  const messages: OAIMessage[] = [
    { role: "system", content: SYSTEM_PROMPT + dateContext },
    ...history.map((m) => ({ role: m.role, content: m.content } as OAIMessage)),
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const data = await callOpenAI(openaiModel, key, messages);
    const msg = data?.choices?.[0]?.message as OAIMessage | undefined;
    if (!msg) throw new Error("Empty response from OpenAI.");

    messages.push(msg);

    const calls = msg.tool_calls ?? [];
    if (calls.length === 0) {
      if (!msg.content) throw new Error("Empty response from OpenAI.");
      return msg.content;
    }

    // Execute each requested tool and feed results back.
    for (const call of calls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(call.function.arguments || "{}"); } catch { /* leave empty */ }
      opts.onStatus?.(statusFor(call.function.name, args));
      let result: unknown;
      try { result = await executeTool(call.function.name, args); }
      catch (e) { result = { error: e instanceof Error ? e.message : String(e) }; }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }

  throw new Error("The assistant took too many steps without answering. Try rephrasing your question.");
}
