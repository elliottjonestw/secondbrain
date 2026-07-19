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
import type { EventRow } from "../types";
import {
  db, listLists, listTags, linksForItem, tagsForItem, getItemLabel,
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

async function executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "get_overview": return toolGetOverview();
    case "search_todos": return toolSearchTodos(args);
    case "search_events": return toolSearchEvents(args);
    case "search_reminders": return toolSearchReminders(args);
    case "search_notes": return toolSearchNotes(args);
    case "get_item": return toolGetItem(args);
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
    default: return "Working…";
  }
}

const SYSTEM_PROMPT =
  "You are a helpful personal assistant embedded in a local life-management app called Second Brain. " +
  "You answer the user's questions about THEIR data — calendar events, reminders, to-dos, notes, lists, and tags. " +
  "You are READ-ONLY: you have only lookup tools and cannot create, edit, or delete anything; if asked to make " +
  "changes, explain that you can only answer questions for now.\n\n" +
  "Use the provided tools to look up whatever you need — do not assume or invent data. Prefer specific, filtered " +
  "queries (by date range, list, tag, or keyword) over broad ones. Call get_overview first if you need orientation. " +
  "Results are paginated: if a tool reports `truncated: true`, there is more data than shown — narrow your filters " +
  "or raise the limit rather than assuming you've seen everything. " +
  "When you have enough information, answer concisely and specifically, using dates/times naturally relative to now. " +
  "If the data doesn't contain the answer, say so plainly.";

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

  const messages: OAIMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
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
