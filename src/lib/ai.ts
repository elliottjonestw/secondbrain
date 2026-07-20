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
import i18next from "i18next";
// Deliberately date-fns' unlocalized `format`, not lib/format's locale-aware
// wrapper: these strings go into the model's prompt, which stays English
// regardless of the UI language. Localizing them would only confuse the model.
import { format, startOfDay } from "date-fns";
import type { EventRow, ItemRef, ItemType } from "../types";
import {
  db, listLists, listTags, linksForItem, tagsForItem, getItemLabel, searchNotes, queryTerms,
  upsertTodo, upsertReminder, upsertNote, upsertList, tagItem, nowIso,
  deleteTodo, deleteReminder, deleteNote, deleteList,
  listPeople, searchPeople, upsertPerson, deletePerson, createLink, deleteLink,
  ensureCustomField,
} from "../db";
import { expandEvents } from "./recurrence";
import {
  listCalendars, getCalendar, findCalendarByName, defaultCalendarId, localToUnified,
  getRemoteOccurrences, getEventByRef, findEventById, createEvent as createCalendarEvent,
  updateEvent as updateCalendarEvent, deleteEvent as deleteCalendarEvent,
  type EventDraft,
} from "./calendars";
import { getSettings } from "./settings";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  /**
   * For assistant turns: the items that were shown as cards. Stripped from the
   * content sent to the model, but summarised into a reference note (see
   * `shownItemsNote`) so a follow-up like "delete it" resolves to a concrete id
   * instead of forcing the model to guess or re-search.
   */
  items?: ItemRef[];
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

/**
 * Convert a stored timestamp to local-offset ISO for the model.
 *
 * The DB stores UTC, so handing the model a raw column (or `.toISOString()`)
 * meant it read `2026-07-20T01:30:00Z` and told the user "01:30 AM" for an
 * event that is actually at 09:30 in their timezone. The system prompt already
 * requires the model to *send* local-offset ISO; this makes reads symmetric.
 *
 * Date-only values (a vCard birthday) are passed through untouched.
 */
function toLocalIso(value: unknown): any {
  if (typeof value !== "string" || !value) return value ?? null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value; // date-only, no zone
  const d = new Date(value);
  return isNaN(d.getTime()) ? value : format(d, "yyyy-MM-dd'T'HH:mm:ssXXX");
}

/** Datetime columns on the domain rows; birthday is date-only and excluded. */
const DATETIME_FIELDS = [
  "dtstart", "dtend", "due_at", "remind_at", "completed_at", "created_at", "updated_at",
] as const;

/** Copy a row with every datetime column converted to local-offset ISO. */
function rowWithLocalTimes<T extends Record<string, any>>(row: T): T {
  const out: Record<string, any> = { ...row };
  for (const f of DATETIME_FIELDS) {
    if (f in out && out[f] != null) out[f] = toLocalIso(out[f]);
  }
  return out as T;
}

const WRITE_TABLES = { event: "events", reminder: "reminders", todo: "todos", note: "notes", person: "people" } as const;

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

/**
 * Match rows against a free-text query, widening the net if a strict match
 * finds nothing.
 *
 * Two failures motivated this. Matching the whole query as one substring meant
 * "lunch with Alex meeting" found nothing, because the user's phrasing is never
 * the stored title word-for-word — so terms are matched individually and ANDed.
 * But ANDing alone still misses that example ("meeting" appears nowhere in
 * "Lunch with Alex"), so when nothing matches every term we fall back to
 * anything matching at least one, best-first.
 *
 * `partial` is reported to the model so it confirms which item was meant
 * instead of acting on a loose match — this feeds delete confirmations.
 * The sort is stable, so equally-scored rows keep their incoming order
 * (chronological, for events).
 */
function matchQuery<T>(
  rows: T[],
  query: string,
  fields: (row: T) => (string | null | undefined)[],
): { rows: T[]; partial: boolean } {
  const terms = queryTerms(query.trim().toLowerCase());
  if (terms.length === 0) return { rows, partial: false };

  const scored = rows.map((row) => {
    const hay = fields(row).filter(Boolean).join(" ").toLowerCase();
    return { row, hits: terms.filter((t) => hay.includes(t)).length };
  });

  const strict = scored.filter((s) => s.hits === terms.length);
  if (strict.length > 0) return { rows: strict.map((s) => s.row), partial: false };

  const loose = scored.filter((s) => s.hits > 0).sort((a, b) => b.hits - a.hits);
  return { rows: loose.map((s) => s.row), partial: loose.length > 0 };
}

/** Told to the model when a search had to fall back to loose matching. */
const PARTIAL_MATCH_NOTE =
  "No item matched every word of the query; these matched some of it, closest first. " +
  "Confirm which one the user means before acting on it.";

/** SQL prefilter matching ANY term, so the JS ranking above has candidates to
 *  work with without loading the whole table. */
function anyTermClause(terms: string[], columns: string[]): { clause: string; params: string[] } {
  const one = `(${columns.map((c) => `${c} LIKE ?`).join(" OR ")})`;
  return {
    clause: `(${terms.map(() => one).join(" OR ")})`,
    params: terms.flatMap((t) => columns.map(() => `%${t}%`)),
  };
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
          query: {
            type: "string",
            description:
              "Distinctive keywords to match in the title or notes — not the user's whole phrase. Every word must " +
              "match, so extra words the user added shrink the results.",
          },
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
        "Get calendar events within a date range, across every visible calendar (the built-in one and any connected Apple/CalDAV calendars). Recurring events are expanded into concrete occurrences. If start/end are omitted, defaults to today (from midnight, so earlier events today are included) through the next 30 days. To find something in the PAST, pass an explicit earlier `start` — the default window does not look back beyond today. Connected calendars are always searched by date window — there is no keyword search over their whole history, so widen start/end rather than expecting an unbounded search.",
      parameters: {
        type: "object",
        properties: {
          start: { type: "string", description: "ISO date/datetime for the window start." },
          end: { type: "string", description: "ISO date/datetime for the window end." },
          query: {
            type: "string",
            description:
              "Distinctive keywords to match in the summary/description/location — not the user's whole phrase. " +
              "Prefer \"Alex\" over \"lunch with Alex meeting\": every word must match, so extra words the user " +
              "added (\"meeting\", \"appointment\") shrink the results.",
          },
          calendar: { type: "string", description: "Limit to one calendar by name (see list_calendars)." },
          tag: { type: "string", description: "Tag name (without #). Only events in the built-in calendar carry tags." },
          limit: { type: "integer", description: `Max occurrences (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).` },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_calendars",
      description:
        "List every calendar available: the built-in local one plus any connected Apple/CalDAV calendars. Shows which are visible, which are read-only, and which is the default for new events. Call this before creating an event in a named calendar.",
      parameters: { type: "object", properties: {} },
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
          query: {
            type: "string",
            description:
              "Distinctive keywords to match in the title or notes — not the user's whole phrase. Every word must " +
              "match, so extra words the user added shrink the results.",
          },
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
          query: {
            type: "string",
            description:
              "Distinctive keywords for full-text search — not the user's whole phrase. All terms must match, " +
              "so \"Beijing budget\" works where \"the budget note about Beijing\" finds nothing.",
          },
          pinned: { type: "boolean", description: "Only pinned notes when true." },
          limit: { type: "integer", description: `Max results (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).` },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_people",
      description:
        "Search the user's contacts (people). Matches name, nickname, organization, and email/phone text. Returns compact records including ids.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Case-insensitive text to match on name/nickname/org/email/phone." },
          tag: { type: "string", description: "Tag name (without #)." },
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
        "Fetch the full detail of a single item by type and id, including its tags and any linked items. Use ids returned by the search tools. Events may live in a connected calendar; pass calendar_id when you have it.",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["event", "reminder", "todo", "note", "person"] },
          id: { type: "string" },
          calendar_id: { type: "string", description: "For events: the calendar_id returned by search_events." },
        },
        required: ["type", "id"],
      },
    },
  },

  // ---- Presentation. Renders cards in the chat; changes no data. ----
  {
    type: "function",
    function: {
      name: "show_items",
      description:
        "Display the given items to the user as cards in the chat. CALL THIS BEFORE you write your reply — it is " +
        "a separate step, and the cards are attached to the reply you write next. The cards show each item's own " +
        "details (title, time, status), so your reply should NOT repeat those details — talk about the items " +
        "naturally instead. List only the items you are actually talking about (at most 8); do not call it for " +
        "items you merely looked at while searching.",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["event", "reminder", "todo", "note", "person"] },
                id: { type: "string", description: "The item's id, from a search tool." },
                calendar_id: { type: "string", description: "For events: the calendar_id returned by search_events." },
                occurrence_start: {
                  type: "string",
                  description:
                    "For events: the `start` of the specific occurrence you mean. A recurring series returns the " +
                    "same id for every occurrence, so pass this to show the right one.",
                },
              },
              required: ["type", "id"],
            },
          },
        },
        required: ["items"],
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
      description:
        "Create a new calendar event. Goes into the user's default calendar unless `calendar` names another one. Confirm ambiguous details with the user before creating.",
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
          calendar: { type: "string", description: "Calendar name; omit to use the user's default calendar." },
        },
        required: ["summary", "start"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_event",
      description:
        "Update fields of an existing event by id, in any calendar. Only include the fields you want to change. Pass calendar_id from search_events when you have it — it avoids searching every calendar for the id.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          calendar_id: { type: "string", description: "The calendar_id returned by search_events." },
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
      name: "create_person",
      description:
        "Create a new contact (person). Multi-value fields are arrays. custom_fields are user-defined label/value pairs (e.g. {label:'Eye color', value:'Blue'}). Confirm ambiguous details first.",
      parameters: {
        type: "object",
        properties: {
          full_name: { type: "string", description: "Display name (required)." },
          given_name: { type: "string" },
          family_name: { type: "string" },
          nickname: { type: "string" },
          organization: { type: "string" },
          title: { type: "string", description: "Job title." },
          birthday: { type: "string", description: "ISO date, e.g. 1990-05-14." },
          notes: { type: "string" },
          emails: { type: "array", items: { type: "object", properties: { type: { type: "string" }, value: { type: "string" } }, required: ["value"] } },
          phones: { type: "array", items: { type: "object", properties: { type: { type: "string" }, value: { type: "string" } }, required: ["value"] } },
          urls: { type: "array", items: { type: "object", properties: { type: { type: "string" }, value: { type: "string" } }, required: ["value"] } },
          addresses: { type: "array", items: { type: "object", properties: { type: { type: "string" }, street: { type: "string" }, city: { type: "string" }, region: { type: "string" }, postal_code: { type: "string" }, country: { type: "string" } } } },
          custom_fields: { type: "array", items: { type: "object", properties: { label: { type: "string" }, value: { type: "string" } }, required: ["label", "value"] }, description: "User-defined data points." },
          favorite: { type: "boolean" },
        },
        required: ["full_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_person",
      description:
        "Update fields of an existing contact by id. Only include fields you want to change. Array fields (emails/phones/urls/addresses/custom_fields) REPLACE the existing list — to add one item, fetch the person with get_item first, then send the full merged list.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          full_name: { type: "string" },
          given_name: { type: "string" },
          family_name: { type: "string" },
          nickname: { type: "string" },
          organization: { type: "string" },
          title: { type: "string" },
          birthday: { type: "string", description: "ISO date, or null to clear." },
          notes: { type: "string" },
          emails: { type: "array", items: { type: "object", properties: { type: { type: "string" }, value: { type: "string" } }, required: ["value"] } },
          phones: { type: "array", items: { type: "object", properties: { type: { type: "string" }, value: { type: "string" } }, required: ["value"] } },
          urls: { type: "array", items: { type: "object", properties: { type: { type: "string" }, value: { type: "string" } }, required: ["value"] } },
          addresses: { type: "array", items: { type: "object", properties: { type: { type: "string" }, street: { type: "string" }, city: { type: "string" }, region: { type: "string" }, postal_code: { type: "string" }, country: { type: "string" } } } },
          custom_fields: { type: "array", items: { type: "object", properties: { label: { type: "string" }, value: { type: "string" } }, required: ["label", "value"] } },
          favorite: { type: "boolean" },
        },
        required: ["id"],
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
          type: { type: "string", enum: ["event", "reminder", "todo", "note", "person"] },
          id: { type: "string" },
          tag: { type: "string", description: "Tag name without the leading #." },
        },
        required: ["type", "id", "tag"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "link_items",
      description:
        "Connect any two items with a cross-link (e.g. attach a person to an event, or a note to a to-do). Works both directions. Look up both ids first.",
      parameters: {
        type: "object",
        properties: {
          source_type: { type: "string", enum: ["event", "reminder", "todo", "note", "person"] },
          source_id: { type: "string" },
          target_type: { type: "string", enum: ["event", "reminder", "todo", "note", "person"] },
          target_id: { type: "string" },
        },
        required: ["source_type", "source_id", "target_type", "target_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "unlink_items",
      description: "Remove a cross-link between two items (either direction). Only removes the link, not the items.",
      parameters: {
        type: "object",
        properties: {
          source_type: { type: "string", enum: ["event", "reminder", "todo", "note", "person"] },
          source_id: { type: "string" },
          target_type: { type: "string", enum: ["event", "reminder", "todo", "note", "person"] },
          target_id: { type: "string" },
        },
        required: ["source_type", "source_id", "target_type", "target_id"],
      },
    },
  },

  // ---- Delete tools. Destructive & irreversible — confirm before using. ----
  {
    type: "function",
    function: {
      name: "delete_todo",
      description: "Permanently delete a to-do (and its subtasks) by id. Irreversible — look up the item and confirm it's the right one with the user before deleting.",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_event",
      description: "Permanently delete a calendar event by id, in any calendar. Deletes the whole event/series. Irreversible — confirm with the user first.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          calendar_id: { type: "string", description: "The calendar_id returned by search_events." },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_reminder",
      description: "Permanently delete a reminder by id. Irreversible — confirm with the user first.",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_note",
      description: "Permanently delete a note by id. Irreversible — confirm with the user first.",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_person",
      description: "Permanently delete a contact (person) by id. Also removes their tags and links. Irreversible — confirm with the user first.",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_list",
      description: "Delete a to-do list by id; its tasks are moved to another list (not deleted). Cannot delete the only remaining list. Confirm with the user first.",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
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
    now: toLocalIso(new Date().toISOString()),
    now_readable: format(new Date(), "EEEE MMMM d, yyyy, h:mm a"),
    counts: {
      events: await one("SELECT COUNT(*) n FROM events"),
      todos: await one("SELECT COUNT(*) n FROM todos"),
      todos_active: await one("SELECT COUNT(*) n FROM todos WHERE completed = 0"),
      reminders: await one("SELECT COUNT(*) n FROM reminders"),
      reminders_active: await one("SELECT COUNT(*) n FROM reminders WHERE completed = 0"),
      notes: await one("SELECT COUNT(*) n FROM notes"),
      people: await one("SELECT COUNT(*) n FROM people"),
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

  // Prefilter on ANY term so SQL still does the narrowing; matchQuery below
  // decides between a strict all-term match and a ranked partial one.
  const queryTermList = typeof args.query === "string" ? queryTerms(args.query.trim()) : [];
  if (queryTermList.length > 0) {
    const { clause, params: p } = anyTermClause(queryTermList, ["t.title", "t.notes"]);
    where.push(clause);
    params.push(...p);
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
  const tagged = tagIds ? rows.filter((r) => tagIds!.has(r.id)) : rows;
  const m = queryTermList.length > 0
    ? matchQuery(tagged, args.query as string, (t) => [t.title, t.notes])
    : { rows: tagged, partial: false };
  const filtered = m.rows;
  const limit = clampLimit(args.limit);
  return {
    total: filtered.length,
    truncated: filtered.length > limit,
    partial_match: m.partial ? PARTIAL_MATCH_NOTE : undefined,
    results: filtered.slice(0, limit).map((t) => ({
      id: t.id, title: t.title, list: t.list_name, completed: !!t.completed,
      due_at: toLocalIso(t.due_at), priority: PRIORITY[t.priority] ?? t.priority,
      is_subtask: !!t.parent_todo_id, notes: t.notes || undefined,
    })),
  };
}

function toolListCalendars() {
  const def = defaultCalendarId();
  return {
    default_calendar: getCalendar(def)?.name,
    calendars: listCalendars().map((c) => ({
      calendar_id: c.id,
      name: c.name,
      source: c.source === "local" ? "built-in" : "apple",
      visible: c.visible,
      read_only: c.readOnly,
      is_default: c.id === def,
    })),
  };
}

async function toolSearchEvents(args: Record<string, unknown>) {
  // Default window starts at midnight, not `new Date()`. Defaulting to "now"
  // hid everything earlier the same day, so asking about a 12:30 lunch at 2pm
  // returned nothing and the assistant reported it didn't exist.
  const start = parseDate(args.start) ?? startOfDay(new Date());
  const end = parseDate(args.end, true) ?? new Date(Date.now() + 30 * 864e5);

  // Scale-conscious pre-filter for the local calendar: always load recurring
  // events (they must be expanded), but only the non-recurring ones that
  // overlap the window. Connected calendars are filtered server-side by the
  // CalDAV time-range query, so they need no equivalent here.
  const d = await db();
  const rows = await d.select<EventRow[]>(
    `SELECT * FROM events WHERE rrule IS NOT NULL
       OR (dtstart <= ? AND COALESCE(dtend, dtstart) >= ?)`,
    [end.toISOString(), start.toISOString()],
  );

  const remote = await getRemoteOccurrences(start, end);
  let occs = [
    ...expandEvents(rows.map(localToUnified), start, end),
    ...remote.occurrences,
  ].sort((a, b) => a.start.getTime() - b.start.getTime());

  if (typeof args.calendar === "string" && args.calendar.trim()) {
    const cal = findCalendarByName(args.calendar);
    if (!cal) {
      return { error: `No calendar named "${args.calendar}". Call list_calendars to see the options.` };
    }
    occs = occs.filter((o) => o.event.calendarId === cal.id);
  }
  let partial = false;
  if (typeof args.query === "string" && args.query.trim()) {
    const m = matchQuery(occs, args.query, (o) => [
      o.event.summary, o.event.description, o.event.location, o.event.categories,
    ]);
    occs = m.rows;
    partial = m.partial;
  }
  if (typeof args.tag === "string" && args.tag.trim()) {
    const tagIds = await idsForTag("event", args.tag.trim());
    occs = occs.filter((o) => tagIds.has(o.event.id));
  }

  const limit = clampLimit(args.limit);
  return {
    range: { start: toLocalIso(start.toISOString()), end: toLocalIso(end.toISOString()) },
    total: occs.length,
    truncated: occs.length > limit,
    partial_match: partial ? PARTIAL_MATCH_NOTE : undefined,
    // Surfaced so the user can be told which calendars didn't answer rather
    // than being shown a confidently incomplete schedule.
    unavailable_calendars: remote.errors.length ? remote.errors : undefined,
    results: occs.slice(0, limit).map((o) => ({
      id: o.event.id, summary: o.event.summary,
      start: toLocalIso(o.start.toISOString()), end: o.end ? toLocalIso(o.end.toISOString()) : null,
      all_day: !!o.event.all_day, recurring: o.isRecurringInstance,
      location: o.event.location || undefined,
      calendar_id: o.event.calendarId,
      calendar: getCalendar(o.event.calendarId)?.name,
    })),
  };
}

/** Locate an event the model referred to by id (+ optional calendar_id). */
async function resolveEvent(args: Record<string, unknown>) {
  const id = typeof args.id === "string" ? args.id : "";
  if (!id) return null;
  const calendarId = typeof args.calendar_id === "string" ? args.calendar_id : "";
  if (calendarId && getCalendar(calendarId)) return getEventByRef(calendarId, id);
  return findEventById(id);
}

async function toolSearchReminders(args: Record<string, unknown>) {
  const d = await db();
  const where: string[] = [];
  const params: unknown[] = [];

  const status = (args.status as string) ?? "active";
  if (status === "active") where.push("completed = 0");
  else if (status === "completed") where.push("completed = 1");

  const queryTermList = typeof args.query === "string" ? queryTerms(args.query.trim()) : [];
  if (queryTermList.length > 0) {
    const { clause, params: p } = anyTermClause(queryTermList, ["title", "notes"]);
    where.push(clause);
    params.push(...p);
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
  const tagged = tagIds ? rows.filter((r) => tagIds!.has(r.id)) : rows;
  const m = queryTermList.length > 0
    ? matchQuery(tagged, args.query as string, (r) => [r.title, r.notes])
    : { rows: tagged, partial: false };
  const filtered = m.rows;
  const limit = clampLimit(args.limit);
  return {
    total: filtered.length,
    truncated: filtered.length > limit,
    partial_match: m.partial ? PARTIAL_MATCH_NOTE : undefined,
    results: filtered.slice(0, limit).map((r) => ({
      id: r.id, title: r.title, completed: !!r.completed,
      due_at: toLocalIso(r.due_at), remind_at: toLocalIso(r.remind_at), repeats: r.rrule || undefined,
      priority: PRIORITY[r.priority] ?? r.priority, notes: r.notes || undefined,
    })),
  };
}

async function toolSearchNotes(args: Record<string, unknown>) {
  const d = await db();
  const limit = clampLimit(args.limit);
  const q = typeof args.query === "string" ? args.query.trim() : "";

  // Reuse db.ts's searchNotes rather than reimplementing the query. This used
  // to be an inline copy, which meant the CJK/short-query handling had to be
  // fixed in two places — and wasn't, so the assistant reported "no notes" for
  // Chinese notes that existed. The pinned filter is applied afterwards.
  const found: any[] = q
    ? await searchNotes(q)
    : await d.select<any[]>("SELECT * FROM notes ORDER BY pinned DESC, updated_at DESC");
  const rows = args.pinned === true ? found.filter((n) => n.pinned === 1) : found;

  return {
    total: rows.length,
    truncated: rows.length > limit,
    results: rows.slice(0, limit).map((n) => ({
      id: n.id, title: n.title || "Untitled", pinned: !!n.pinned,
      snippet: (n.body ?? "").replace(/\s+/g, " ").slice(0, 400),
      updated_at: toLocalIso(n.updated_at),
    })),
  };
}

async function toolGetItem(args: Record<string, unknown>) {
  const type = args.type as string;
  const id = args.id as string;
  const table = { event: "events", reminder: "reminders", todo: "todos", note: "notes", person: "people" }[type];
  if (!table || !id) return { error: "Provide a valid type (event|reminder|todo|note|person) and id." };

  const d = await db();
  const rows = await d.select<any[]>(`SELECT * FROM ${table} WHERE id = ?`, [id]);
  const item = rows[0];

  // Events can live in a connected calendar, where there is no SQLite row —
  // and no tags/links, which are keyed on local ids.
  if (!item && type === "event") {
    const remote = await resolveEvent(args);
    if (!remote) return { error: `No event found with id ${id}.` };
    return {
      type,
      item: rowWithLocalTimes(remote as any),
      calendar: getCalendar(remote.calendarId)?.name,
      tags: [],
      linked: [],
      note: "This event is in a connected calendar; tags and links apply to built-in calendar events only.",
    };
  }

  if (!item) return { error: `No ${type} found with id ${id}.` };

  const tags = (await tagsForItem(type as any, id)).map((t) => t.name);
  const links = await linksForItem(type as any, id);
  const linked = await Promise.all(links.map(async (l) => {
    const other = l.source_type === type && l.source_id === id
      ? { t: l.target_type, i: l.target_id }
      : { t: l.source_type, i: l.source_id };
    return { type: other.t, id: other.i, label: await getItemLabel(other.t, other.i) };
  }));

  return { type, item: rowWithLocalTimes(item), tags, linked };
}

/** Parse a JSON array column back to values, or undefined if empty. */
function parseCol<T>(json: string | null): T[] | undefined {
  if (!json) return undefined;
  try { const v = JSON.parse(json); return Array.isArray(v) && v.length ? v : undefined; } catch { return undefined; }
}

async function toolSearchPeople(args: Record<string, unknown>) {
  const q = typeof args.query === "string" ? args.query.trim() : "";
  let rows = q ? await searchPeople(q) : await listPeople();

  // searchPeople ANDs the terms. If that found nobody, retry loosely so a
  // query carrying an extra word ("Sam from accounting") still turns them up.
  // Only on the miss path, and the contacts table is small enough to scan.
  let partial = false;
  if (q && rows.length === 0 && queryTerms(q).length > 1) {
    const m = matchQuery(await listPeople(), q, (p) => [
      p.full_name, p.nickname, p.organization, p.title, p.emails, p.phones,
    ]);
    rows = m.rows;
    partial = m.partial;
  }

  if (typeof args.tag === "string" && args.tag.trim()) {
    const tagIds = await idsForTag("person", args.tag.trim());
    rows = rows.filter((r) => tagIds.has(r.id));
  }
  const limit = clampLimit(args.limit);
  return {
    total: rows.length,
    truncated: rows.length > limit,
    partial_match: partial ? PARTIAL_MATCH_NOTE : undefined,
    results: rows.slice(0, limit).map((p) => ({
      id: p.id,
      full_name: p.full_name,
      nickname: p.nickname || undefined,
      organization: p.organization || undefined,
      title: p.title || undefined,
      birthday: p.birthday || undefined,
      emails: parseCol(p.emails),
      phones: parseCol(p.phones),
      favorite: !!p.favorite,
    })),
  };
}

/** Cards shown per reply. Enough for "what's on this week", short of a wall. */
const MAX_SHOWN_ITEMS = 8;

/**
 * Presentation tool: hand the UI a list of items to render as cards.
 *
 * Every ref is verified to exist before it's accepted, so a hallucinated id
 * comes back as an error the model can correct rather than a blank card.
 */
async function toolShowItems(
  args: Record<string, unknown>,
  emit?: (items: ItemRef[]) => void,
) {
  const raw = Array.isArray(args.items) ? args.items : null;
  if (!raw || raw.length === 0) return { error: "Provide a non-empty items array." };

  const refs: ItemRef[] = [];
  const missing: string[] = [];
  for (const entry of raw.slice(0, MAX_SHOWN_ITEMS)) {
    if (!entry || typeof entry !== "object") continue;
    const { type, id, calendar_id, occurrence_start } = entry as Record<string, unknown>;
    if (typeof type !== "string" || !(type in WRITE_TABLES) || typeof id !== "string" || !id) {
      missing.push(`${String(type)} ${String(id)}`);
      continue;
    }
    // Events may live in a connected calendar, where there is no SQLite row.
    const exists = type === "event"
      ? !!(await resolveEvent({ id, calendar_id }))
      : !!(await getRowById(WRITE_TABLES[type as ItemType], id));
    if (!exists) { missing.push(`${type} ${id}`); continue; }
    refs.push({
      type: type as ItemType,
      id,
      calendarId: typeof calendar_id === "string" ? calendar_id : undefined,
      occurrenceStart: asIso(occurrence_start) ?? undefined,
    });
  }

  if (refs.length === 0) {
    return { error: `None of those items exist: ${missing.join(", ")}. Look the ids up with a search tool.` };
  }
  emit?.(refs);
  return {
    ok: true,
    shown: refs.length,
    // Reported rather than silently dropped, so the model can correct itself
    // instead of describing an item the user never sees a card for.
    not_found: missing.length ? missing : undefined,
    omitted: raw.length > MAX_SHOWN_ITEMS ? raw.length - MAX_SHOWN_ITEMS : undefined,
  };
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

  // A named calendar wins; otherwise new events land in the user's default.
  let calendarId = defaultCalendarId();
  if (typeof args.calendar === "string" && args.calendar.trim()) {
    const named = findCalendarByName(args.calendar);
    if (!named) {
      return { error: `No calendar named "${args.calendar}". Call list_calendars to see the options.` };
    }
    calendarId = named.id;
  }

  const allDay = args.all_day === true;
  const dtend = allDay ? null : (asIso(args.end) ?? new Date(new Date(dtstart).getTime() + 3600e3).toISOString());
  try {
    const id = await createCalendarEvent(calendarId, {
      summary: args.summary.trim(),
      description: typeof args.description === "string" ? args.description : null,
      location: typeof args.location === "string" ? args.location : null,
      dtstart, dtend, all_day: allDay ? 1 : 0,
      rrule: typeof args.rrule === "string" ? args.rrule : null,
      exdates: null, status: "CONFIRMED",
      categories: typeof args.category === "string" ? JSON.stringify([args.category]) : null,
      color: null,
    });
    return { ok: true, id, calendar_id: calendarId, calendar: getCalendar(calendarId)?.name };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

async function toolUpdateEvent(args: Record<string, unknown>) {
  const ev = await resolveEvent(args);
  if (!ev) return { error: `No event found with id ${args.id}.` };

  // Partial merge: "field" in args distinguishes "clear it" from "leave it".
  // Datetimes differ from the other fields: a present-but-unparseable value is
  // a model error, not a "leave it alone" — otherwise the model would think
  // it moved an event that didn't move (matching toolCreateEvent's behavior).
  const patch: Partial<EventDraft> = {};
  if ("summary" in args) patch.summary = String(args.summary);
  if ("description" in args) patch.description = args.description as string | null;
  if ("location" in args) patch.location = args.location as string | null;
  if ("start" in args) {
    const iso = asIso(args.start);
    if (!iso) return { error: "A valid ISO start is required." };
    patch.dtstart = iso;
  }
  if ("end" in args) {
    // `null` is the documented way to clear the end; a present-but-unparseable
    // string is a model error (mirrors the start handling).
    if (args.end === null) {
      patch.dtend = null;
    } else {
      const iso = asIso(args.end);
      if (!iso) return { error: "A valid ISO end is required (pass null to clear)." };
      patch.dtend = iso;
    }
  }
  if ("all_day" in args) patch.all_day = args.all_day ? 1 : 0;
  if ("rrule" in args) patch.rrule = args.rrule ? String(args.rrule) : null;
  if ("category" in args) patch.categories = args.category ? JSON.stringify([args.category]) : null;

  try {
    await updateCalendarEvent(ev, patch);
    return { ok: true, id: ev.id, calendar: getCalendar(ev.calendarId)?.name };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
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

// ---- People + generic linking ----
/** Trim a string arg to non-empty, else null (used for "clear" semantics). */
function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
/** Serialize an array arg (of objects) to a JSON column, or null if empty. */
function jsonArrOrNull(v: unknown): string | null {
  if (!Array.isArray(v)) return null;
  const items = v.filter((x) => x && typeof x === "object");
  return items.length ? JSON.stringify(items) : null;
}

/** Custom-field labels are global — make sure any the model uses exist as defs. */
async function registerCustomFieldLabels(v: unknown): Promise<void> {
  if (!Array.isArray(v)) return;
  for (const item of v) {
    const label = item && typeof item === "object" ? (item as { label?: unknown }).label : undefined;
    if (typeof label === "string" && label.trim()) await ensureCustomField(label.trim());
  }
}

async function toolCreatePerson(args: Record<string, unknown>) {
  if (typeof args.full_name !== "string" || !args.full_name.trim()) return { error: "full_name is required." };
  await registerCustomFieldLabels(args.custom_fields);
  const id = await upsertPerson({
    full_name: args.full_name.trim(),
    given_name: strOrNull(args.given_name),
    family_name: strOrNull(args.family_name),
    additional_names: null,
    honorific_prefix: null,
    honorific_suffix: null,
    nickname: strOrNull(args.nickname),
    organization: strOrNull(args.organization),
    title: strOrNull(args.title),
    birthday: strOrNull(args.birthday),
    notes: strOrNull(args.notes),
    photo: null,
    emails: jsonArrOrNull(args.emails),
    phones: jsonArrOrNull(args.phones),
    addresses: jsonArrOrNull(args.addresses),
    urls: jsonArrOrNull(args.urls),
    custom_fields: jsonArrOrNull(args.custom_fields),
    favorite: args.favorite === true ? 1 : 0,
  });
  return { ok: true, id };
}

async function toolUpdatePerson(args: Record<string, unknown>) {
  const p = await getRowById("people", args.id);
  if (!p) return { error: `No person found with id ${args.id}.` };
  if ("custom_fields" in args) await registerCustomFieldLabels(args.custom_fields);
  const keepStr = (k: string, cur: string | null) => (k in args ? strOrNull(args[k]) : cur);
  const keepArr = (k: string, cur: string | null) => (k in args ? jsonArrOrNull(args[k]) : cur);
  await upsertPerson({
    id: p.id,
    full_name: "full_name" in args ? (String(args.full_name).trim() || p.full_name) : p.full_name,
    given_name: keepStr("given_name", p.given_name),
    family_name: keepStr("family_name", p.family_name),
    additional_names: p.additional_names,
    honorific_prefix: p.honorific_prefix,
    honorific_suffix: p.honorific_suffix,
    nickname: keepStr("nickname", p.nickname),
    organization: keepStr("organization", p.organization),
    title: keepStr("title", p.title),
    birthday: keepStr("birthday", p.birthday),
    notes: keepStr("notes", p.notes),
    photo: p.photo,
    emails: keepArr("emails", p.emails),
    phones: keepArr("phones", p.phones),
    addresses: keepArr("addresses", p.addresses),
    urls: keepArr("urls", p.urls),
    custom_fields: keepArr("custom_fields", p.custom_fields),
    favorite: "favorite" in args ? (args.favorite ? 1 : 0) : p.favorite,
  });
  return { ok: true, id: p.id };
}

const LINK_TYPES = ["event", "reminder", "todo", "note", "person"];

/** Validate a link request and confirm both endpoints exist. */
async function resolveLinkPair(args: Record<string, unknown>) {
  const st = args.source_type as string;
  const si = args.source_id as string;
  const tt = args.target_type as string;
  const ti = args.target_id as string;
  if (!LINK_TYPES.includes(st) || !LINK_TYPES.includes(tt) || typeof si !== "string" || typeof ti !== "string") {
    return { error: "Provide source_type, source_id, target_type, target_id (types: event|reminder|todo|note|person)." as const };
  }
  const s = await getRowById(WRITE_TABLES[st as ItemType], si);
  if (!s) return { error: `No ${st} found with id ${si}.` as const };
  const t = await getRowById(WRITE_TABLES[tt as ItemType], ti);
  if (!t) return { error: `No ${tt} found with id ${ti}.` as const };
  return { st: st as ItemType, si, tt: tt as ItemType, ti };
}

async function toolLinkItems(args: Record<string, unknown>) {
  const r = await resolveLinkPair(args);
  if ("error" in r) return { error: r.error };
  const existing = await linksForItem(r.st, r.si);
  const dup = existing.some((l) =>
    (l.target_type === r.tt && l.target_id === r.ti) || (l.source_type === r.tt && l.source_id === r.ti));
  if (dup) return { ok: true, note: "Those items were already linked." };
  await createLink(r.st, r.si, r.tt, r.ti);
  return { ok: true };
}

async function toolUnlinkItems(args: Record<string, unknown>) {
  const r = await resolveLinkPair(args);
  if ("error" in r) return { error: r.error };
  const links = await linksForItem(r.st, r.si);
  const match = links.find((l) =>
    (l.source_type === r.st && l.source_id === r.si && l.target_type === r.tt && l.target_id === r.ti) ||
    (l.source_type === r.tt && l.source_id === r.ti && l.target_type === r.st && l.target_id === r.si));
  if (!match) return { error: "Those items are not linked." };
  await deleteLink(match.id);
  return { ok: true };
}

// ---- Delete executors (destructive; reuse the same db helpers as the UI) ----
async function toolDeleteTodo(args: Record<string, unknown>) {
  const t = await getRowById("todos", args.id);
  if (!t) return { error: `No todo found with id ${args.id}.` };
  await deleteTodo(t.id);
  return { ok: true, deleted: { type: "todo", id: t.id, title: t.title } };
}
async function toolDeleteEvent(args: Record<string, unknown>) {
  const ev = await resolveEvent(args);
  if (!ev) return { error: `No event found with id ${args.id}.` };
  try {
    await deleteCalendarEvent(ev);
    return {
      ok: true,
      deleted: {
        type: "event", id: ev.id, summary: ev.summary,
        calendar: getCalendar(ev.calendarId)?.name,
      },
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
async function toolDeleteReminder(args: Record<string, unknown>) {
  const r = await getRowById("reminders", args.id);
  if (!r) return { error: `No reminder found with id ${args.id}.` };
  await deleteReminder(r.id);
  return { ok: true, deleted: { type: "reminder", id: r.id, title: r.title } };
}
async function toolDeleteNote(args: Record<string, unknown>) {
  const n = await getRowById("notes", args.id);
  if (!n) return { error: `No note found with id ${args.id}.` };
  await deleteNote(n.id);
  return { ok: true, deleted: { type: "note", id: n.id, title: n.title } };
}
async function toolDeletePerson(args: Record<string, unknown>) {
  const p = await getRowById("people", args.id);
  if (!p) return { error: `No person found with id ${args.id}.` };
  await deletePerson(p.id);
  return { ok: true, deleted: { type: "person", id: p.id, full_name: p.full_name } };
}
async function toolDeleteList(args: Record<string, unknown>) {
  const l = await getRowById("lists", args.id);
  if (!l) return { error: `No list found with id ${args.id}.` };
  const lists = await listLists();
  if (lists.length <= 1) return { error: "Can't delete the only remaining list." };
  await deleteList(l.id);
  return { ok: true, deleted: { type: "list", id: l.id, name: l.name }, note: "Its tasks were moved to another list." };
}

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  // Only show_items uses this: it's how the chosen items reach the UI.
  emitItems?: (items: ItemRef[]) => void,
): Promise<unknown> {
  switch (name) {
    // read
    case "get_overview": return toolGetOverview();
    case "search_todos": return toolSearchTodos(args);
    case "search_events": return toolSearchEvents(args);
    case "list_calendars": return toolListCalendars();
    case "search_reminders": return toolSearchReminders(args);
    case "search_notes": return toolSearchNotes(args);
    case "search_people": return toolSearchPeople(args);
    case "get_item": return toolGetItem(args);
    // presentation
    case "show_items": return toolShowItems(args, emitItems);
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
    case "create_person": return toolCreatePerson(args);
    case "update_person": return toolUpdatePerson(args);
    case "add_tag": return toolAddTag(args);
    case "link_items": return toolLinkItems(args);
    case "unlink_items": return toolUnlinkItems(args);
    // delete
    case "delete_todo": return toolDeleteTodo(args);
    case "delete_event": return toolDeleteEvent(args);
    case "delete_reminder": return toolDeleteReminder(args);
    case "delete_note": return toolDeleteNote(args);
    case "delete_person": return toolDeletePerson(args);
    case "delete_list": return toolDeleteList(args);
    default: return { error: `Unknown tool: ${name}` };
  }
}

// Human-readable status shown in the UI while a tool runs.
function statusFor(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "get_overview": return i18next.t("status.overview");
    case "search_todos": return i18next.t("status.searchTodos");
    case "search_events": return i18next.t("status.searchEvents");
    case "list_calendars": return i18next.t("status.listCalendars");
    case "search_reminders": return i18next.t("status.searchReminders");
    case "search_notes": return args.query ? i18next.t("status.searchNotesFor", { query: String(args.query) }) : i18next.t("status.searchNotes");
    case "search_people": return args.query ? i18next.t("status.searchPeopleFor", { query: String(args.query) }) : i18next.t("status.searchPeople");
    case "get_item": return i18next.t("status.getItem");
    case "show_items": return i18next.t("status.showItems");
    case "create_todo": return i18next.t("status.createTodo");
    case "update_todo": return i18next.t("status.updateTodo");
    case "create_event": return i18next.t("status.createEvent");
    case "update_event": return i18next.t("status.updateEvent");
    case "create_reminder": return i18next.t("status.createReminder");
    case "update_reminder": return i18next.t("status.updateReminder");
    case "create_note": return i18next.t("status.createNote");
    case "update_note": return i18next.t("status.updateNote");
    case "create_list": return i18next.t("status.createList");
    case "create_person": return i18next.t("status.createPerson");
    case "update_person": return i18next.t("status.updatePerson");
    case "add_tag": return i18next.t("status.addTag");
    case "link_items": return i18next.t("status.linkItems");
    case "unlink_items": return i18next.t("status.unlinkItems");
    case "delete_todo": return i18next.t("status.deleteTodo");
    case "delete_event": return i18next.t("status.deleteEvent");
    case "delete_reminder": return i18next.t("status.deleteReminder");
    case "delete_note": return i18next.t("status.deleteNote");
    case "delete_person": return i18next.t("status.deletePerson");
    case "delete_list": return i18next.t("status.deleteList");
    default: return i18next.t("status.working");
  }
}

const SYSTEM_PROMPT =
  "You are a helpful personal assistant embedded in a local life-management app called Second Brain. " +
  "You help the user with THEIR data — calendar events, reminders, to-dos, notes, people (contacts), lists, and tags.\n\n" +
  "You can READ, WRITE, and DELETE data:\n" +
  "- Read/lookup tools: get_overview, search_todos, search_events, list_calendars, search_reminders, search_notes, search_people, get_item.\n" +
  "- Create/update tools: create_todo, update_todo, create_event, update_event, create_reminder, " +
  "update_reminder, create_note, update_note, create_list, create_person, update_person, add_tag.\n" +
  "- Linking tools: link_items / unlink_items connect any two items (e.g. attach a person to an event, " +
  "or a note to a to-do). People are contacts with emails/phones/addresses, a birthday, and user-defined " +
  "custom_fields (label/value, e.g. 'Eye color: Blue').\n" +
  "- Delete tools: delete_todo, delete_event, delete_reminder, delete_note, delete_person, delete_list.\n" +
  "- Presentation: show_items displays items to the user as cards. Call it BEFORE writing a reply that talks " +
  "about specific items.\n\n" +
  "Calendars:\n" +
  "- The user may have several calendars: the built-in local one plus any Apple/iCloud calendars they have " +
  "connected. search_events covers every visible calendar at once, and you can view, edit and delete events in " +
  "all of them. Use list_calendars to see the names.\n" +
  "- New events go in the user's DEFAULT calendar unless they name a different one (\"put it in my Work " +
  "calendar\") — pass that name as the `calendar` argument to create_event. Don't ask which calendar for every " +
  "event; the default is the right answer unless they say otherwise.\n" +
  "- Events in connected calendars have no tags, links or attached people — those apply to the built-in " +
  "calendar only. If a tool reports `unavailable_calendars`, mention in passing that you couldn't reach that " +
  "calendar (\"I couldn't get to your Work calendar, but…\") rather than implying you saw the whole schedule.\n\n" +
  "How to answer:\n" +
  "- Your replies are often read aloud by a text-to-speech voice, so write the way a person would SAY it: one " +
  "or two short sentences of ordinary prose.\n" +
  "- NEVER use tables, bullet points, numbered lists, headings, or bold field labels like \"**Time:**\". Do not " +
  "recite an item's every field.\n" +
  "- Lead with the answer. Don't open with a preamble like \"You have the following events\" or \"Here is what I " +
  "found\" — just say it: \"You've got three things today — standup at nine thirty, then lunch with Sam.\"\n" +
  "- Mention the count and whatever actually matters (what's soon, what clashes, what's overdue). The cards " +
  "carry the details, so leave times, locations and ids out of the prose unless they're the point of the answer.\n" +
  "- Showing items is a SEPARATE STEP THAT COMES FIRST. Whenever your reply will talk about specific items, " +
  "call show_items with those items and write nothing else in that step; then write your reply, and the cards " +
  "will appear beneath it. If you looked something up because the user asked about it, show it — never describe " +
  "items without showing them.\n" +
  "- The cards appear on their own, so never announce them. Do not write \"let me show you the details\", " +
  "\"here they are\" or \"I'll pull those up\" — just answer, having already called show_items.\n" +
  "- When the user asks a yes/no or judgement question (\"am I free Thursday?\"), answer THAT question rather " +
  "than dumping the schedule you used to work it out.\n\n" +
  "Guidelines:\n" +
  "- Never assume or invent data; use the read tools to look things up first. To update, tag, link, or delete an " +
  "existing item, find its id with a search tool before calling the write/delete tool. To add one entry to a " +
  "person's array field (email/phone/custom field), fetch them with get_item first, then send the full merged list " +
  "to update_person.\n" +
  "- Prefer specific, filtered queries (by date range, list, tag, or keyword). If a tool reports `truncated: true`, " +
  "narrow your filters rather than assuming you've seen everything; if you still report a partial answer, say so " +
  "in passing (\"there are more, but the next few are…\").\n" +
  "- Before creating or updating, make sure the request is clear. If key details are ambiguous (which item, what " +
  "date/time, which list), ask a brief clarifying question instead of guessing. For clearly-specified requests, just " +
  "do it.\n" +
  "- DELETION IS PERMANENT AND CANNOT BE UNDONE. Before deleting, identify the exact item(s) and confirm with the " +
  "user which one(s) you will delete, unless they have already unambiguously identified the specific item to delete. " +
  "Never delete more than the user asked for; when a request is broad or could match multiple items, list what you " +
  "found and ask before deleting.\n" +
  "- Interpret relative dates/times (\"tomorrow at 3pm\", \"next Friday\") against the current date, and pass concrete " +
  "ISO 8601 values to the tools.\n" +
  "- After making changes, confirm what you did in one short sentence (\"Added lunch with Sam tomorrow at one.\") " +
  "and show the item.";

async function callOpenAI(
  model: string,
  key: string,
  messages: OAIMessage[],
  // The card-recovery round narrows the toolset and cools the temperature; it's
  // a pure tool call, where sampling variety is the problem rather than the point.
  opts: { tools?: unknown; temperature?: number } = {},
) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages,
      tools: opts.tools ?? TOOLS,
      tool_choice: "auto",
      // Warmer than the 0.2 this used when replies were data dumps: the prompt now
      // asks for natural spoken-sounding prose, which 0.2 renders stiff and formulaic.
      temperature: opts.temperature ?? 0.6,
    }),
  });
  if (!res.ok) {
    let detail = "";
    try { const err = await res.json(); detail = err?.error?.message ?? JSON.stringify(err); }
    catch { detail = await res.text(); }
    throw new Error(i18next.t("errors.openai", { status: res.status, detail }));
  }
  return res.json();
}

/** Just the show_items schema, for the recovery round below. */
const SHOW_ITEMS_TOOL = TOOLS.filter((t) => t.function.name === "show_items");

/**
 * Did this tool result contain something the user might want to see a card for?
 * Covers the read tools' `results`, get_item's `item`, and the create/update
 * tools' `{ ok, id }`.
 */
function returnedItems(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const r = result as Record<string, unknown>;
  if (Array.isArray(r.results)) return r.results.length > 0;
  if (r.item) return true;
  return r.ok === true && typeof r.id === "string";
}

/**
 * Second chance at cards when the model wrote its reply without calling
 * show_items — which it still does maybe half the time, however the prompt is
 * worded, because writing prose and calling a tool compete for the same step.
 *
 * This asks *only* for the refs; the reply the user already has is never
 * regenerated, so a recovery round can't degrade the prose. Failures are
 * swallowed: cards are an enhancement, and a good answer must not be lost
 * because a cosmetic follow-up call failed.
 */
async function recoverItemCards(
  model: string,
  key: string,
  messages: OAIMessage[],
  emit: (items: ItemRef[]) => void,
): Promise<void> {
  const ask: OAIMessage[] = [
    ...messages,
    {
      role: "system",
      content:
        "Your last reply went to the user without calling show_items, so no cards were displayed. If that " +
        "reply referred to specific items, call show_items now with exactly those items, using ids from the " +
        "tool results above. If it referred to no specific item, reply with the single word NONE.",
    },
  ];
  try {
    const data = await callOpenAI(model, key, ask, { tools: SHOW_ITEMS_TOOL, temperature: 0 });
    const msg = data?.choices?.[0]?.message as OAIMessage | undefined;
    // The prompt asks the model to reply "NONE" when the answer referred to no
    // specific item — which arrives as plain content with no tool_calls, so the
    // loop below simply has nothing to iterate. Either outcome is fine: cards
    // only appear when the model actually calls show_items.
    for (const call of msg?.tool_calls ?? []) {
      if (call.function.name !== "show_items") continue;
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(call.function.arguments || "{}"); } catch { continue; }
      await toolShowItems(args, emit);
    }
  } catch {
    /* no cards this turn; the answer still stands */
  }
}

export interface AskOptions {
  onStatus?: (text: string) => void;
  /**
   * Items the model chose to show, as they're chosen. A callback rather than a
   * return value so the refs still reach the UI if a later round throws.
   * May fire more than once per turn; treat each batch as an addition.
   */
  onItems?: (items: ItemRef[]) => void;
}

/**
 * Summarise the cards shown for one assistant turn into a note the model reads
 * on the next turn, so references like "it" / "that one" / "the lunch" resolve
 * to a concrete id without a fresh search.
 *
 * Labels are a best-effort *local* lookup — no network, since this runs on
 * every turn. A remote event resolves to "(untitled)" but still carries its
 * id/calendar_id/occurrence_start, which is what the model needs to act; the
 * user-facing title is also right there in the assistant's own prior text.
 */
async function shownItemsNote(items: ItemRef[]): Promise<string> {
  const lines = await Promise.all(items.map(async (it) => {
    let label = "";
    try { label = await getItemLabel(it.type, it.id); } catch { /* best-effort */ }
    const parts = [`${it.type} "${label || "?"}"`, `id=${it.id}`];
    if (it.calendarId) parts.push(`calendar_id=${it.calendarId}`);
    if (it.occurrenceStart) parts.push(`occurrence_start=${it.occurrenceStart}`);
    return `- ${parts.join(", ")}`;
  }));
  return (
    "[Cards shown to the user for the previous reply. If the user now refers to one without naming it " +
    "(\"it\", \"that\", \"the lunch one\"), resolve the reference to these ids rather than searching again. " +
    "The usual confirm-before-deleting rule still applies.]\n" + lines.join("\n")
  );
}

/**
 * Ask the assistant a question. Runs an agentic loop: the model may call
 * read-only tools (possibly several rounds) before producing a final answer.
 */
export async function askAssistant(history: ChatMessage[], opts: AskOptions = {}): Promise<string> {
  const { openaiApiKey, openaiModel } = getSettings();
  const key = openaiApiKey.trim();
  if (!key) throw new Error(i18next.t("errors.noApiKey"));

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

  // Only role/content go to the model — never the UiMessage `items`. But an
  // assistant turn that showed cards gets a system note after it recording
  // which items those were, so the next user message can refer to them.
  const messages: OAIMessage[] = [{ role: "system", content: SYSTEM_PROMPT + dateContext }];
  for (const m of history) {
    messages.push({ role: m.role, content: m.content });
    if (m.role === "assistant" && m.items && m.items.length > 0) {
      messages.push({ role: "system", content: await shownItemsNote(m.items) });
    }
  }

  // Tracked across rounds to decide whether the reply is missing its cards.
  let showedItems = false; // show_items ran and accepted at least one item
  let sawItems = false;    // some tool surfaced an item worth showing

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const data = await callOpenAI(openaiModel, key, messages);
    const msg = data?.choices?.[0]?.message as OAIMessage | undefined;
    if (!msg) throw new Error(i18next.t("errors.emptyResponse"));

    messages.push(msg);

    const calls = msg.tool_calls ?? [];
    if (calls.length === 0) {
      if (!msg.content) throw new Error(i18next.t("errors.emptyResponse"));
      // The model looked items up and then talked about them without showing
      // them. Ask once for just the refs, leaving the reply text alone.
      if (!showedItems && sawItems && opts.onItems) {
        opts.onStatus?.(statusFor("show_items", {}));
        await recoverItemCards(openaiModel, key, messages, opts.onItems);
      }
      return msg.content;
    }

    // Execute each requested tool and feed results back.
    for (const call of calls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(call.function.arguments || "{}"); } catch { /* leave empty */ }
      opts.onStatus?.(statusFor(call.function.name, args));
      let result: unknown;
      try { result = await executeTool(call.function.name, args, opts.onItems); }
      catch (e) { result = { error: e instanceof Error ? e.message : String(e) }; }
      // A show_items that rejected every id doesn't count — leave recovery open.
      if (call.function.name === "show_items") {
        if ((result as { ok?: boolean })?.ok) showedItems = true;
      } else if (returnedItems(result)) {
        sawItems = true;
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }

  throw new Error(i18next.t("errors.tooManySteps"));
}
