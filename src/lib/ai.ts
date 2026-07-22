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
// Locale-free numeric/ISO helpers, so importing them here doesn't localize
// anything the model reads.
import { ageFromBirthday, nextBirthday } from "./format";
// The daily summary is the one model output shown verbatim to the user, so it
// needs the UI language by name.
import { LANGUAGES, currentLanguage } from "./i18n";
import type { ItemRef, ItemType, UnifiedEvent } from "../types";
import {
  getEvent, listLists, listEvents, listNotes, getNote, listTodos, getTodo, listReminders, getReminder, listTags, itemIdsForTag, linksForItem, tagsForItem, getItemLabel, searchNotes, queryTerms,
  matchQuery,
  upsertTodo, upsertReminder, upsertNote, upsertList, tagItem, nowIso,
  deleteTodo, deleteReminder, deleteNote, deleteList,
  listPeople, getPerson, searchPeople, upsertPerson, deletePerson, createLink, deleteLink,
  ensureCustomField,
} from "../db";
import { expandEvents } from "./recurrence";
import {
  listCalendars, getCalendar, findCalendarByName, defaultCalendarId, localToUnified,
  getRemoteOccurrences, getEventByRef, findEventById, createEvent as createCalendarEvent,
  updateEvent as updateCalendarEvent, deleteEvent as deleteCalendarEvent,
  type EventDraft,
} from "./calendars";
import { getSettings, DEFAULT_OLLAMA_URL, type AppSettings } from "./settings";
// Same live-fetch path the Today card uses, cache included — an assistant
// question right after that card rendered costs no second request.
import { getDayWeather, isForecastable, englishCondition } from "./weather";

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
  // Every domain is remote now (M2–M4): a local SELECT would hit an empty table
  // and make existence checks (tag/link/update/delete) report "not found" for
  // items that exist. Events go through calendars.ts, which also covers the
  // connected CalDAV calendars, not just the built-in one.
  switch (table) {
    case "todos": return (await getTodo(id)) ?? null;
    case "reminders": return (await getReminder(id)) ?? null;
    case "people": return (await getPerson(id)) ?? null;
    case "notes": return (await getNote(id)) ?? null;
    case "events": return (await findEventById(id)) ?? null;
    default: return null;
  }
}

/** Resolve a list name to its id (case-insensitive); null if not found. */
async function resolveListId(name: unknown): Promise<string | null> {
  if (typeof name !== "string" || !name.trim()) return null;
  const lists = await listLists();
  return lists.find((l) => l.name.toLowerCase() === name.trim().toLowerCase())?.id ?? null;
}

/**
 * `matchQuery` and `anyTermClause` live in db.ts, next to `queryTerms` — the
 * global search bar needs the same ranking, and two copies would drift on
 * exactly the phrasing bugs they exist to prevent. `partial` is reported to
 * the model so it confirms which item was meant instead of acting on a loose
 * match, which is what protects deletes.
 */

/** Told to the model when a search had to fall back to loose matching. */
const PARTIAL_MATCH_NOTE =
  "No item matched every word of the query; these matched some of it, closest first. " +
  "Confirm which one the user means before acting on it.";

/**
 * Parse an event's `categories` (stored as a JSON string like '["Work"]') into
 * the plain labels, for text search. Returns null when there's nothing usable,
 * so matchQuery skips it like it does summary/description.
 */
function categoryLabels(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return null;
    const labels = arr.filter((c): c is string => typeof c === "string");
    return labels.length ? labels.join(" ") : null;
  } catch { return null; }
}

/** item_ids that carry a given tag name, for a given item type. */
async function idsForTag(type: string, tagName: string): Promise<Set<string>> {
  // Tags are remote now (M3d). The server resolves item ids for a tag+type.
  return new Set(await itemIdsForTag(type as ItemType, tagName));
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
        "Search the user's contacts (people). Matches name, nickname, organization, and email/phone text. Returns compact records including ids, emails, phones, addresses, websites, custom fields, and notes. When a birthday is known the record also carries `age` (already worked out for today) and `next_birthday` — use those numbers as given; never recompute an age yourself.",
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
  {
    type: "function",
    function: {
      name: "get_weather",
      description:
        "Get the forecast for the weather location the user set in Settings. One day per call, so a question " +
        "about a weekend takes two calls. Only ~90 days back and 14 days ahead are available. Weather is not " +
        "one of the user's items — never pass it to show_items. Never state a forecast this tool didn't return.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "yyyy-MM-dd. Defaults to today." },
          include_hours: {
            type: "boolean",
            description:
              "Include the hour-by-hour strip for the rest of the day. Only ask for it when the question is " +
              "about a time of day (\"will it rain this afternoon\") — it is a lot of numbers otherwise.",
          },
        },
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
                    "For events: the `start` of the specific occurrence you mean, copied verbatim from that " +
                    "event's `start` in the search_events results. ALWAYS include it when showing a recurring " +
                    "event (one with `recurring: true`) — the series shares one id across every occurrence, so " +
                    "without it the card shows the wrong date.",
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
      description: "Create a new to-do list. List names must be unique (case-insensitive) — if a name is taken this returns an error; prefer updating the existing list instead of creating a duplicate.",
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
  // Every domain is remote now (M2–M4); count from the fetched lists. The
  // built-in calendar's event count only — connected CalDAV events are a live
  // windowed fetch, not a stored total.
  const [lists, tags, todos, reminders, people, events, notes] = await Promise.all([
    listLists(), listTags(), listTodos(), listReminders(), listPeople(), listEvents(), listNotes(),
  ]);
  return {
    now: toLocalIso(new Date().toISOString()),
    now_readable: format(new Date(), "EEEE MMMM d, yyyy, h:mm a"),
    counts: {
      // Built-in calendar only; connected CalDAV events aren't counted (they're
      // a live windowed fetch, not a stored total).
      events: events.length,
      todos: todos.length,
      todos_active: todos.filter((t) => t.completed === 0).length,
      reminders: reminders.length,
      reminders_active: reminders.filter((r) => r.completed === 0).length,
      notes: notes.length,
      people: people.length,
    },
    lists: lists.map((l) => l.name),
    tags: tags.map((t) => t.name),
  };
}

async function toolSearchTodos(args: Record<string, unknown>) {
  // Todos are remote (M2). Rather than push these filters into the API — which
  // would mean designing the full query surface before it is needed — the small
  // single-user todo set is fetched once and filtered here. The ranking still
  // runs through the shared matchQuery, so results agree with every other
  // search path. Tags are still local (until M3), so idsForTag stays a local
  // lookup.
  const [allTodos, lists] = await Promise.all([listTodos(), listLists()]);
  const listName = (id: string | null) => (id ? lists.find((l) => l.id === id)?.name ?? null : null);
  let rows: any[] = allTodos.map((t) => ({ ...t, list_name: listName(t.list_id) }));

  const status = (args.status as string) ?? "active";
  if (status === "active") rows = rows.filter((r) => r.completed === 0);
  else if (status === "completed") rows = rows.filter((r) => r.completed === 1);

  const queryTermList = typeof args.query === "string" ? queryTerms(args.query.trim()) : [];
  if (queryTermList.length > 0) {
    // Prefilter to rows hitting ANY term; matchQuery below decides strict vs
    // ranked-partial, exactly as the SQL prefilter used to.
    const lowered = queryTermList.map((t) => t.toLowerCase());
    rows = rows.filter((r) => {
      const hay = `${r.title ?? ""} ${r.notes ?? ""}`.toLowerCase();
      return lowered.some((t) => hay.includes(t));
    });
  }
  if (typeof args.list === "string" && args.list.trim()) {
    rows = rows.filter((r) => r.list_name === args.list);
  }
  if (typeof args.min_priority === "number") {
    rows = rows.filter((r) => r.priority >= (args.min_priority as number));
  }
  const dueBefore = parseDate(args.due_before, true);
  if (dueBefore) rows = rows.filter((r) => r.due_at && r.due_at <= dueBefore.toISOString());
  const dueAfter = parseDate(args.due_after);
  if (dueAfter) rows = rows.filter((r) => r.due_at && r.due_at >= dueAfter.toISOString());

  if (typeof args.tag === "string" && args.tag.trim()) {
    const tagIds = await idsForTag("todo", args.tag.trim());
    rows = rows.filter((r) => tagIds.has(r.id));
  }

  // Order: incomplete first, then by due date with nulls last — the same order
  // the SQL used to produce.
  rows.sort((a, b) =>
    a.completed - b.completed ||
    (a.due_at ? 0 : 1) - (b.due_at ? 0 : 1) ||
    String(a.due_at).localeCompare(String(b.due_at)),
  );

  const m = queryTermList.length > 0
    ? matchQuery(rows, args.query as string, (t) => [t.title, t.notes])
    : { rows, partial: false };
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

  // The built-in calendar is remote now (M3c). Fetch all its events and expand
  // client-side — recurrence expansion is client-side by design (rrule), so the
  // window can't be pushed to the server without re-implementing it, and the
  // single-user dataset is small. Connected calendars are still filtered
  // server-side by the CalDAV time-range query.
  const rows = await listEvents();

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
      o.event.summary, o.event.description, o.event.location, categoryLabels(o.event.categories),
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
      description: o.event.description || undefined,
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
  // Reminders are remote (M3): fetch the list and filter in JS, mirroring
  // toolSearchTodos. Tags stay local until M3d.
  let rows: any[] = await listReminders();

  const status = (args.status as string) ?? "active";
  if (status === "active") rows = rows.filter((r) => r.completed === 0);
  else if (status === "completed") rows = rows.filter((r) => r.completed === 1);

  const queryTermList = typeof args.query === "string" ? queryTerms(args.query.trim()) : [];
  if (queryTermList.length > 0) {
    const lowered = queryTermList.map((t) => t.toLowerCase());
    rows = rows.filter((r) => {
      const hay = `${r.title ?? ""} ${r.notes ?? ""}`.toLowerCase();
      return lowered.some((t) => hay.includes(t));
    });
  }
  if (args.flagged === true) rows = rows.filter((r) => r.priority > 0);
  const coalesce = (r: any) => r.remind_at ?? r.due_at ?? null;
  const dueBefore = parseDate(args.due_before, true);
  if (dueBefore) rows = rows.filter((r) => coalesce(r) && coalesce(r) <= dueBefore.toISOString());
  const dueAfter = parseDate(args.due_after);
  if (dueAfter) rows = rows.filter((r) => coalesce(r) && coalesce(r) >= dueAfter.toISOString());

  if (typeof args.tag === "string" && args.tag.trim()) {
    const tagIds = await idsForTag("reminder", args.tag.trim());
    rows = rows.filter((r) => tagIds.has(r.id));
  }

  // completed last, then earliest remind_at/due_at first — the old ORDER BY.
  rows.sort((a, b) =>
    a.completed - b.completed ||
    (coalesce(a) ? 0 : 1) - (coalesce(b) ? 0 : 1) ||
    String(coalesce(a)).localeCompare(String(coalesce(b))),
  );

  const m = queryTermList.length > 0
    ? matchQuery(rows, args.query as string, (r) => [r.title, r.notes])
    : { rows, partial: false };
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
  const limit = clampLimit(args.limit);
  const q = typeof args.query === "string" ? args.query.trim() : "";

  // Reuse db.ts's searchNotes (remote FTS) rather than reimplementing the query,
  // so the CJK/short-query handling lives in one place. No query lists all notes
  // via listNotes(). The pinned filter is applied afterwards.
  const found: any[] = q ? await searchNotes(q) : await listNotes();
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
  // One getter per type rather than a table name interpolated into SQL: there
  // is no local database to query any more, and each of these is the same
  // space-scoped endpoint the UI uses, so the assistant cannot reach a row the
  // signed-in user couldn't.
  const getters: Record<string, (id: string) => Promise<Record<string, any> | undefined>> = {
    event: getEvent, reminder: getReminder, todo: getTodo, note: getNote, person: getPerson,
  };
  const getter = getters[type];
  if (!getter || !id) return { error: "Provide a valid type (event|reminder|todo|note|person) and id." };

  const item = await getter(id);

  // Events can live in a connected calendar, where there is no local row —
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

  if (type === "person") {
    return { type, item: { ...rowWithLocalTimes(item), ...birthdayFacts(item.birthday) }, tags, linked };
  }
  return { type, item: rowWithLocalTimes(item), tags, linked };
}

/** Parse a JSON array column back to values, or undefined if empty. */
function parseCol<T>(json: string | null): T[] | undefined {
  if (!json) return undefined;
  try { const v = JSON.parse(json); return Array.isArray(v) && v.length ? v : undefined; } catch { return undefined; }
}

/**
 * Age and next birthday, computed here rather than left to the model. Handed a
 * bare `1986-01-28` it does the subtraction in its head and answers from the
 * year its training data ended in ("36") no matter what today's date the prompt
 * carries. A number in the tool result isn't guessable.
 */
function birthdayFacts(birthday: string | null): { age?: number; next_birthday?: string } {
  if (!birthday) return {};
  const age = ageFromBirthday(birthday);
  const next = nextBirthday(birthday);
  return { age: age ?? undefined, next_birthday: next ?? undefined };
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
      ...birthdayFacts(p.birthday),
      emails: parseCol(p.emails),
      phones: parseCol(p.phones),
      addresses: parseCol(p.addresses),
      websites: parseCol(p.urls),
      custom_fields: parseCol(p.custom_fields),
      notes: p.notes || undefined,
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
/**
 * The forecast for one day at the location in Settings.
 *
 * There is no `location` argument on purpose: the answer is about the place the
 * user configured, and resolving a place named in the message would mean
 * geocoding it and disambiguating the several Springfields it returns.
 */
async function toolGetWeather(args: Record<string, unknown>) {
  const { weatherLocation: loc, temperatureUnit: unit } = getSettings();
  if (!loc) {
    return { error: "No weather location is set. Ask the user to set one in Settings." };
  }

  // Local midnight, built field by field: `new Date("2026-07-22")` parses as UTC
  // and lands on the previous day west of Greenwich.
  let day = startOfDay(new Date());
  if (typeof args.date === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(args.date.trim());
    if (!m) return { error: "date must be yyyy-MM-dd." };
    day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  // Checked before fetching: outside its window the service answers 200 with
  // `{ error: true }`, which reads as success.
  if (!isForecastable(day)) {
    return { error: "No forecast is available for that date — only about 90 days back and 14 days ahead." };
  }

  const w = await getDayWeather(loc, day, unit);
  if (!w) return { error: "The weather service is unavailable right now." };

  const round = (n: number | null) => (n === null ? null : Math.round(n));
  // `current` only describes now, so anything derived from it is meaningful on
  // today alone — hence the `_now` names and the null on any other day.
  const isToday = day.getTime() === startOfDay(new Date()).getTime();
  return {
    place: loc.name,
    date: format(day, "yyyy-MM-dd"),
    // English, like every other string the model reads.
    condition: englishCondition(w.code),
    high: round(w.high),
    low: round(w.low),
    unit: w.unit,
    precipitation_chance: round(w.precipitation),
    temperature_now: isToday ? round(w.now) : null,
    feels_like: round(w.feelsLike),
    humidity_now: isToday ? round(w.humidity) : null,
    wind: round(w.wind),
    wind_unit: w.windUnit,
    uv_index: round(w.uvIndex),
    sunrise: w.sunrise,
    sunset: w.sunset,
    air_quality_now: w.air ? Math.round(w.air.usAqi) : null,
    hours: args.include_hours === true
      ? w.hours.map((h) => ({
          time: h.time,
          temp: Math.round(h.temp),
          condition: englishCondition(h.code),
          precipitation_chance: round(h.precipitation),
        }))
      : undefined,
  };
}

/**
 * For recurring events shown without an explicit occurrence, fill in the
 * upcoming occurrence (from the start of today) so the card shows a current
 * date instead of the series' origin.
 *
 * Anchored at start-of-today, not now, so today's earlier events (a 9:30
 * standup viewed at 2pm) still resolve to today. Local events expand via
 * rrule; remote events must go through ical.js, so their occurrences are
 * fetched once and shared. A horizon past a year covers up to yearly repeats;
 * anything with no occurrence in range keeps the series start as a last resort.
 */
async function fillOccurrenceStarts(items: { ref: ItemRef; ev: UnifiedEvent }[]): Promise<void> {
  if (items.length === 0) return;
  const from = startOfDay(new Date());
  const to = new Date(from.getTime() + 366 * 864e5);

  const hasRemote = items.some((it) => it.ev.source !== "local");
  const remote = hasRemote ? (await getRemoteOccurrences(from, to)).occurrences : [];

  for (const { ref, ev } of items) {
    const occs = ev.source === "local"
      ? expandEvents([ev], from, to)
      : remote.filter((o) => o.event.id === ev.id);
    const next = occs.find((o) => o.start.getTime() >= from.getTime());
    if (next) ref.occurrenceStart = next.start.toISOString();
  }
}

async function toolShowItems(
  args: Record<string, unknown>,
  emit?: (items: ItemRef[]) => void,
) {
  const raw = Array.isArray(args.items) ? args.items : null;
  if (!raw || raw.length === 0) return { error: "Provide a non-empty items array." };

  const refs: ItemRef[] = [];
  const missing: string[] = [];
  // Recurring event refs the model didn't pin to an occurrence. Left as-is,
  // their card renders the series' stored start (a weekday standup shows the
  // day the series began, not today), so we resolve the right occurrence below.
  const needOccurrence: { ref: ItemRef; ev: UnifiedEvent }[] = [];

  for (const entry of raw.slice(0, MAX_SHOWN_ITEMS)) {
    if (!entry || typeof entry !== "object") continue;
    const { type, id, calendar_id, occurrence_start } = entry as Record<string, unknown>;
    if (typeof type !== "string" || !(type in WRITE_TABLES) || typeof id !== "string" || !id) {
      missing.push(`${String(type)} ${String(id)}`);
      continue;
    }
    if (type === "event") {
      // Events may live in a connected calendar, where there is no SQLite row.
      const ev = await resolveEvent({ id, calendar_id });
      if (!ev) { missing.push(`event ${id}`); continue; }
      const ref: ItemRef = {
        type: "event",
        id,
        // Default to the event's own calendar so the card can fetch it directly
        // rather than scanning every calendar for the id.
        calendarId: typeof calendar_id === "string" ? calendar_id : ev.calendarId,
        occurrenceStart: asIso(occurrence_start) ?? undefined,
      };
      refs.push(ref);
      if (ev.rrule && !ref.occurrenceStart) needOccurrence.push({ ref, ev });
    } else {
      const exists = !!(await getRowById(WRITE_TABLES[type as ItemType], id));
      if (!exists) { missing.push(`${type} ${id}`); continue; }
      refs.push({ type: type as ItemType, id });
    }
  }

  if (refs.length === 0) {
    return { error: `None of those items exist: ${missing.join(", ")}. Look the ids up with a search tool.` };
  }
  await fillOccurrenceStarts(needOccurrence);
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
  try {
    const id = await upsertList({ name: args.name.trim(), color: typeof args.color === "string" ? args.color : null });
    return { ok: true, id };
  } catch (e) {
    // Most likely: a list with this name already exists (lists.name is unique,
    // case-insensitive). Surface the message so the model can update the
    // existing list instead of retrying the create.
    return { error: e instanceof Error ? e.message : String(e) };
  }
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
    case "get_weather": return toolGetWeather(args);
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
    case "get_weather": return i18next.t("status.weather");
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
  "- Read/lookup tools: get_overview, search_todos, search_events, list_calendars, search_reminders, search_notes, search_people, get_item, get_weather.\n" +
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
  "Weather:\n" +
  "- get_weather answers for the ONE location the user set in Settings. You cannot look up another city; if " +
  "they ask about somewhere else, say so and point them at Settings.\n" +
  "- Always call it — never answer from memory, and never guess a forecast the tool didn't return.\n" +
  "- It covers one day per call and only about 90 days back and 14 days ahead.\n" +
  "- The forecast is not one of the user's items, so it never goes to show_items.\n\n" +
  "How to answer:\n" +
  "- Your replies are often read aloud by a text-to-speech voice, so write the way a person would SAY it: one " +
  "or two short sentences of ordinary prose.\n" +
  "- BUT keep numbers as digits — never spell them out as words. Phone numbers, times, dates, prices and codes " +
  "go in normal readable form (+1 555-010-2020, 3pm, $50, Jul 21), NOT \"plus one five five five…\". The " +
  "sentence around them can sound spoken; the number itself must be readable at a glance.\n" +
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
  "- ALWAYS look before answering. When the user asks anything about their own data — schedule, reminders, " +
  "to-dos, notes, contacts, \"when/what/where/do I have…\", \"when should I…\" — search for it yourself in the " +
  "same turn, THEN answer. Never say you don't have the information, and never ask permission to look (\"Would " +
  "you like me to check?\") — just check. Only state that something doesn't exist after a search has actually " +
  "come back empty. A question that sounds like it could be general knowledge (\"when should I take my " +
  "vitamins?\") is almost always about the user's own reminder/note — search first.\n" +
  "- Note bodies may contain image references written as ![alt](sbimg:<id>). Those ids point at stored image " +
  "data — never invent one, and when rewriting a note with update_note, keep any existing reference exactly as " +
  "it is or the image is lost from the note. Read the alt text if it helps; don't read the reference aloud.\n" +
  "- A bare YouTube URL on its own line in a note body is an embedded video. Keep it on its own line and " +
  "unaltered when rewriting a note — turning it into [a labelled link](url) stops it playing.\n" +
  "- Never assume or invent data. To update, tag, link, or delete an " +
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

/**
 * The resolved chat backend for one request.
 *
 * OpenAI uses `/v1/chat/completions`. Ollama has an OpenAI-compatible shim at the
 * same path, but we deliberately use its **native `/api/chat`** instead: the shim
 * gives no way to set the context window, and our system-prompt-plus-tool-schema
 * is ~7k tokens — well over Ollama's 4k default — so the tool definitions get
 * silently truncated and the model answers as a generic chatbot with no tools.
 * Native `/api/chat` takes `options.num_ctx`, which is the whole fix. `callChat`
 * translates our OpenAI-shaped messages to/from native format at the boundary so
 * the agentic loop upstream never has to know the difference.
 */
interface ChatEndpoint {
  provider: AppSettings["assistantProvider"];
  url: string;
  base?: string; // Ollama server root, for user-facing error text
  headers: Record<string, string>;
  model: string;
}

// Big enough to hold the ~7k-token system prompt + tool schema with room for a
// few rounds of (paginated) tool results. On overflow Ollama keeps the system
// prompt and drops the oldest turns, so this degrades gracefully rather than
// losing the tools. Larger costs proportionally more memory on the user's box.
const OLLAMA_NUM_CTX = 8192;

/** Trim a base URL and drop trailing slashes so we can append a path cleanly. */
function normalizeBaseUrl(url: string, fallback: string): string {
  return (url.trim().replace(/\/+$/, "") || fallback);
}

function resolveChatEndpoint(s: AppSettings): ChatEndpoint {
  if (s.assistantProvider === "ollama") {
    const base = normalizeBaseUrl(s.ollamaBaseUrl, DEFAULT_OLLAMA_URL);
    return {
      provider: "ollama",
      url: `${base}/api/chat`,
      base,
      headers: { "Content-Type": "application/json" },
      model: s.ollamaModel.trim(),
    };
  }
  return {
    provider: "openai",
    url: "https://api.openai.com/v1/chat/completions",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.openaiApiKey.trim()}` },
    model: s.openaiModel.trim() || "gpt-4o-mini",
  };
}

/**
 * The tools for one request, or null when this call must send none at all.
 * An empty `tools: []` is a 400 on OpenAI, so "no tools" has to mean omitting
 * the field (and `tool_choice`) entirely — that's what the day summary wants.
 */
function toolsFor(tools: unknown): unknown[] | null {
  const t = (tools ?? TOOLS) as unknown[];
  return Array.isArray(t) && t.length === 0 ? null : t;
}

async function callChat(
  ep: ChatEndpoint,
  messages: OAIMessage[],
  // The card-recovery round narrows the toolset and cools the temperature; it's
  // a pure tool call, where sampling variety is the problem rather than the point.
  opts: { tools?: unknown; temperature?: number; signal?: AbortSignal } = {},
) {
  if (ep.provider === "ollama") return callOllama(ep, messages, opts);

  const tools = toolsFor(opts.tools);
  const res = await fetch(ep.url, {
    method: "POST",
    headers: ep.headers,
    body: JSON.stringify({
      model: ep.model,
      messages,
      ...(tools ? { tools, tool_choice: "auto" } : {}),
      // Warmer than the 0.2 this used when replies were data dumps: the prompt now
      // asks for natural spoken-sounding prose, which 0.2 renders stiff and formulaic.
      temperature: opts.temperature ?? 0.6,
    }),
    signal: opts.signal,
  });
  if (!res.ok) {
    let detail = "";
    try { const err = await res.json(); detail = err?.error?.message ?? JSON.stringify(err); }
    catch { detail = await res.text(); }
    throw new Error(i18next.t("errors.assistant", { status: res.status, detail }));
  }
  return res.json();
}

// --- Ollama native /api/chat --------------------------------------------------
// Native format differs from OpenAI in three ways we care about: tool-call
// arguments are objects (not JSON strings), tool calls carry no id, and tool
// results are matched by `tool_name`/order rather than `tool_call_id`. We
// translate at the edges and hand the loop back an OpenAI-shaped response.

function safeParseArgs(s: string): unknown {
  try { return JSON.parse(s || "{}"); } catch { return {}; }
}

/** OpenAI-shaped message → Ollama native message. */
function toNativeMessage(m: OAIMessage): Record<string, unknown> {
  if (m.role === "assistant" && m.tool_calls?.length) {
    return {
      role: "assistant",
      content: m.content ?? "",
      tool_calls: m.tool_calls.map((tc) => ({
        function: { name: tc.function.name, arguments: safeParseArgs(tc.function.arguments) },
      })),
    };
  }
  if (m.role === "tool") {
    // `tool_name` lets recent Ollama pair the result with its call; older
    // versions ignore it and match by order, which we preserve anyway.
    return { role: "tool", content: m.content ?? "", tool_name: m.name ?? "" };
  }
  return { role: m.role, content: m.content ?? "" };
}

/** Ollama native assistant message → OpenAI-shaped `choices[0].message`. */
function fromNativeMessage(msg: any): OAIMessage {
  const calls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
  const tool_calls: ToolCall[] = calls.map((tc: any, i: number) => ({
    id: `call_${Date.now()}_${i}`,
    type: "function",
    function: {
      name: tc?.function?.name ?? "",
      // Back to a JSON string so the rest of the loop parses it uniformly.
      arguments: JSON.stringify(tc?.function?.arguments ?? {}),
    },
  }));
  return {
    role: "assistant",
    content: msg?.content ?? null,
    ...(tool_calls.length ? { tool_calls } : {}),
  };
}

async function callOllama(
  ep: ChatEndpoint,
  messages: OAIMessage[],
  opts: { tools?: unknown; temperature?: number; signal?: AbortSignal },
) {
  let res: Response;
  const tools = toolsFor(opts.tools);
  try {
    res = await fetch(ep.url, {
      method: "POST",
      headers: ep.headers,
      body: JSON.stringify({
        model: ep.model,
        messages: messages.map(toNativeMessage),
        ...(tools ? { tools } : {}),
        stream: false,
        options: { num_ctx: OLLAMA_NUM_CTX, temperature: opts.temperature ?? 0.6 },
      }),
      signal: opts.signal,
    });
  } catch (e) {
    // An explicit abort surfaces a DOMException named "AbortError" — let it
    // through untouched so the caller can tell a cancel apart from a dead server.
    if ((e as Error)?.name === "AbortError") throw e;
    // Not running / wrong port: the fetch is rejected outright rather than
    // returning a status, so name the likely cause instead of a raw error.
    throw new Error(i18next.t("errors.ollamaUnreachable", { url: ep.base ?? ep.url }));
  }
  if (!res.ok) {
    // A model that can't do tools returns a 400 here ("does not support tools"),
    // which surfaces as a clear message rather than a silent no-op.
    let detail = "";
    try { const err = await res.json(); detail = err?.error ?? JSON.stringify(err); }
    catch { detail = await res.text(); }
    throw new Error(i18next.t("errors.assistant", { status: res.status, detail }));
  }
  const data = await res.json();
  return { choices: [{ message: fromNativeMessage(data?.message) }] };
}

/**
 * List the models a local Ollama server has pulled, for the Settings dropdown.
 * Uses Ollama's native `/api/tags`. Throws on any failure so the UI can show a
 * "can't reach Ollama" state and fall back to a free-text model field.
 */
export async function listOllamaModels(baseUrl: string): Promise<string[]> {
  const base = normalizeBaseUrl(baseUrl, DEFAULT_OLLAMA_URL);
  const res = await fetch(`${base}/api/tags`, { method: "GET" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const models: string[] = Array.isArray(data?.models)
    ? data.models.map((m: { name?: string }) => m?.name).filter((n: unknown): n is string => typeof n === "string")
    : [];
  return models;
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
  ep: ChatEndpoint,
  messages: OAIMessage[],
  emit: (items: ItemRef[]) => void,
  signal?: AbortSignal,
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
    const data = await callChat(ep, ask, { tools: SHOW_ITEMS_TOOL, temperature: 0, signal });
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
  /** Abort the in-flight turn. Checked between rounds and passed to fetch. */
  signal?: AbortSignal;
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
  const settings = getSettings();
  const ep = resolveChatEndpoint(settings);
  if (!ep.model || (ep.provider === "openai" && !settings.openaiApiKey.trim())) {
    throw new Error(i18next.t("errors.notConfigured"));
  }

  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";
  const localIso = format(now, "yyyy-MM-dd'T'HH:mm:ssXXX"); // e.g. 2026-07-20T14:30:00+08:00
  // Stated as a fact first and placed at the TOP of the system prompt. Buried at
  // the bottom and worded only as a scheduling rule, this was obeyed when
  // creating events yet ignored for arithmetic: asked a 1986 contact's age the
  // model answered from its training cutoff, not from today.
  const dateContext =
    `TODAY'S DATE IS ${format(now, "EEEE, MMMM d, yyyy")}. The current local time is ` +
    `${format(now, "h:mm a")} in the user's timezone (${tz}, ISO ${localIso}).\n` +
    `- Your training data ends well before today. You do NOT know what year it is from memory — the date ` +
    `above is the only correct source, and it overrides any sense you have of the current year.\n` +
    `- Use it for ALL date arithmetic: ages, \"how long ago\", \"how many days until\", whether something is ` +
    `past or upcoming. Someone born in 1986 is ${format(now, "yyyy")} minus 1986 years old, not the age you ` +
    `would guess.\n` +
    `- Interpret every date and clock time the user mentions (\"10am\", \"today\", \"tomorrow\", \"next Friday\", ` +
    `\"in 2 hours\") in this local timezone, using the correct current year.\n` +
    `- When passing datetimes to tools, write ISO 8601 with the user's local UTC offset (like ${localIso}). ` +
    `Do NOT use UTC or a trailing \"Z\" — that would save the event at the wrong hour.\n\n`;

  // Only role/content go to the model — never the UiMessage `items`. But an
  // assistant turn that showed cards gets a system note after it recording
  // which items those were, so the next user message can refer to them.
  const messages: OAIMessage[] = [{ role: "system", content: dateContext + SYSTEM_PROMPT }];
  for (const m of history) {
    messages.push({ role: m.role, content: m.content });
    if (m.role === "assistant" && m.items && m.items.length > 0) {
      messages.push({ role: "system", content: await shownItemsNote(m.items) });
    }
  }

  // Repeated last, next to the question being answered: the top-of-prompt copy
  // is a long way from the generation point once a conversation has some
  // history, and the current year is exactly what gets lost over that distance.
  messages.push({
    role: "system",
    content: `Reminder: today is ${format(now, "EEEE, MMMM d, yyyy")}. Base every date calculation on it.`,
  });

  // Tracked across rounds to decide whether the reply is missing its cards.
  let showedItems = false; // show_items ran and accepted at least one item
  let sawItems = false;    // some tool surfaced an item worth showing

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    // A user cancel between rounds aborts cleanly rather than starting another
    // network call that will be thrown away.
    if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const data = await callChat(ep, messages, { signal: opts.signal });
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
        await recoverItemCards(ep, messages, opts.onItems, opts.signal);
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
      // `name` is unused by OpenAI but lets the Ollama translator set `tool_name`.
      messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: JSON.stringify(result) });
    }
  }

  throw new Error(i18next.t("errors.tooManySteps"));
}

// --- Daily summary (Today view) ----------------------------------------------
//
// Deliberately NOT the agentic loop. The Today view has already loaded exactly
// the day's data, so re-searching for it would cost several rounds to arrive at
// facts we're holding — this is one tool-free call that only turns a digest we
// build into prose. Everything the model would otherwise compute (overdue,
// ages, "in 3 days") is computed by the caller and handed over as a fact.

/** One day's facts, already resolved by the caller. Times are local-offset ISO. */
export interface DaySummaryInput {
  /**
   * The day being summarised, as `yyyy-MM-dd`. The Today view can step to any
   * date, so this is not necessarily today — the prompt uses it to choose past,
   * present or future tense, which the model gets wrong left to its own devices.
   */
  date: string;
  /** Occurrences falling on the day, in start order. */
  events: { title: string; start: string; all_day: boolean; location?: string | null }[];
  /** Reminders due on the day (or still open from before). */
  reminders: { title: string; due: string | null; overdue: boolean }[];
  /** To-dos due on the day (or overdue), highest priority first. */
  todos: { title: string; due: string | null; priority: string; overdue: boolean }[];
  /** Birthdays today and soon. `age` is the age they turn, computed in TS. */
  birthdays: { name: string; date: string; in_days: number; age: number | null }[];
  /**
   * That day's forecast, if a weather location is set and the day is within the
   * forecastable window. Condition text is English (see `englishCondition`) —
   * it goes to the model, not the screen.
   */
  weather?: {
    place: string;
    condition: string;
    high: number;
    low: number;
    unit: string;
    precipitation: number | null;
    /** Apparent temperature — often the one worth mentioning, not the air temp. */
    feels_like: number | null;
    /** US AQI, when the day is today and the reading came back. */
    air_quality: number | null;
  } | null;
}

/**
 * Does this day have anything at all worth summarising? Weather deliberately
 * doesn't count: the forecast has its own tile, and a briefing that exists only
 * to restate it would be a paid request to say what's already on screen.
 */
export function hasDayContent(input: DaySummaryInput): boolean {
  return (
    input.events.length > 0 || input.reminders.length > 0 ||
    input.todos.length > 0 || input.birthdays.length > 0
  );
}

/** Model-facing clock time. Unlocalized on purpose, like every other prompt string. */
function digestTime(iso: string | null, allDay = false): string {
  if (allDay) return "all day";
  if (!iso) return "no time";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "no time" : format(d, "h:mm a");
}

/** The day's facts as compact lines. Empty sections are omitted, not sent as "none". */
function dayDigest(input: DaySummaryInput): string {
  const parts: string[] = [];
  if (input.events.length) {
    parts.push("EVENTS:\n" + input.events.map((e) =>
      `- ${e.title || "(untitled)"} at ${digestTime(e.start, e.all_day)}` +
      (e.location ? ` (${e.location})` : "")).join("\n"));
  }
  if (input.reminders.length) {
    parts.push("REMINDERS:\n" + input.reminders.map((r) =>
      `- ${r.title} at ${digestTime(r.due)}${r.overdue ? " [OVERDUE]" : ""}`).join("\n"));
  }
  if (input.todos.length) {
    parts.push("TO-DOS:\n" + input.todos.map((t) =>
      `- ${t.title} (priority ${t.priority})${t.due ? `, due ${digestTime(t.due)}` : ""}` +
      `${t.overdue ? " [OVERDUE]" : ""}`).join("\n"));
  }
  if (input.birthdays.length) {
    parts.push("BIRTHDAYS:\n" + input.birthdays.map((b) => {
      // Relative to the day being described, not to today — the view can be
      // showing any date, so "TODAY" would be a lie on all the others.
      const when = b.in_days === 0
        ? "ON THIS DAY"
        : b.in_days === 1 ? "the day after" : `${b.in_days} days after this day`;
      // The age is given, never derived — the model reaches for its training
      // cutoff year the moment it has to subtract one (see dateContext).
      return `- ${b.name}, ${when}${b.age === null ? "" : `, turning ${b.age}`}`;
    }).join("\n"));
  }
  if (input.weather) {
    const w = input.weather;
    parts.push(
      `WEATHER in ${w.place}: ${w.condition}, high ${Math.round(w.high)}${w.unit}, ` +
      `low ${Math.round(w.low)}${w.unit}` +
      (w.precipitation === null ? "" : `, ${w.precipitation}% chance of precipitation`) +
      (w.feels_like === null ? "" : `, feels like ${Math.round(w.feels_like)}${w.unit}`) +
      (w.air_quality === null ? "" : `, air quality index ${Math.round(w.air_quality)} (US AQI)`),
    );
  }
  return parts.join("\n\n");
}

const DAY_SUMMARY_PROMPT =
  "You write a short briefing about ONE DAY for the user of a personal life-management app, from the data " +
  "below. It is displayed at the top of their Today page.\n\n" +
  "How to write it:\n" +
  "- Two or three sentences of ordinary prose, as if you were telling them over coffee. Under 60 words.\n" +
  "- NEVER use bullet points, lists, headings, tables or bold labels. Prose only.\n" +
  "- Lead with the shape of the day, then what matters most: what's first, what clashes, what's overdue, " +
  "whose birthday it is. Don't recite every item — the tiles below already list them.\n" +
  "- Keep times and numbers as readable digits (9:30am, 3 to-dos), never spelled out as words.\n" +
  "- If weather is given, mention it ONLY when it would change what they do — rain or snow, a storm, a " +
  "notably hot or cold day, poor air quality (US AQI over 100), or plans that look outdoor. Prefer the " +
  "feels-like temperature to the air temperature when they differ much, since that's what going outside " +
  "is actually like. Tie it to the day (\"take a coat for that 6pm walk\") instead of reciting a forecast, " +
  "and say nothing about ordinary weather; it has its own tile.\n" +
  "- Address the user as \"you\". No preamble like \"Here is your summary\" and no sign-off.\n" +
  "- Only use what's in the data. Never invent an item, a time, or a person.";

/**
 * One-paragraph briefing for the Today page.
 *
 * Callers should check `hasDayContent` first — an empty day has nothing to say
 * and shouldn't cost a request. Throws like any other assistant call; the Today
 * view treats a failure as "no summary" rather than an error banner, since this
 * is an enhancement over tiles that already show the same data.
 */
export async function summarizeDay(input: DaySummaryInput, signal?: AbortSignal): Promise<string> {
  const settings = getSettings();
  const ep = resolveChatEndpoint(settings);
  if (!ep.model || (ep.provider === "openai" && !settings.openaiApiKey.trim())) {
    throw new Error(i18next.t("errors.notConfigured"));
  }

  const now = new Date();
  // The summary is user-facing, so unlike every other model-facing string here
  // it has to come back in the UI language.
  const lang = LANGUAGES.find((l) => l.code === currentLanguage());
  // Local midnight, not `new Date("yyyy-MM-dd")` — that parses as UTC and lands
  // on the previous day for anyone west of Greenwich.
  const day = new Date(`${input.date}T00:00:00`);
  const offsetDays = Math.round(
    (startOfDay(day).getTime() - startOfDay(now).getTime()) / 86400000,
  );
  // Which day is being described, and in what tense. The view can step to any
  // date, and a briefing about next Tuesday written in the present tense ("you
  // have standup at 9:30") reads as if it were happening now.
  const whichDay = offsetDays === 0
    ? "You are describing TODAY. Write in the present tense."
    : offsetDays === 1
      ? "You are describing TOMORROW, not today. Write in the future tense."
      : offsetDays === -1
        ? "You are describing YESTERDAY, not today. Write in the past tense."
        : offsetDays > 0
          ? `You are describing ${format(day, "EEEE, MMMM d, yyyy")}, which is ${offsetDays} days from ` +
            "today. Write in the future tense and name the day, since it is not today."
          : `You are describing ${format(day, "EEEE, MMMM d, yyyy")}, which is ${-offsetDays} days ago. ` +
            "Write in the past tense and name the day, since it is not today.";
  const messages: OAIMessage[] = [
    {
      role: "system",
      content:
        `TODAY IS ${format(now, "EEEE, MMMM d, yyyy")} and the time is now ${format(now, "h:mm a")}. ` +
        "Your training data ends well before today; the date above is the only correct source, and every " +
        "\"overdue\", age and day-count in the data has already been worked out for you — use them as given " +
        `and do no date arithmetic of your own.\n\n${whichDay}\n\n` +
        DAY_SUMMARY_PROMPT +
        `\n- Write the summary in ${lang?.nativeName ?? "English"}.`,
    },
    { role: "user", content: dayDigest(input) },
  ];

  const data = await callChat(ep, messages, { tools: [], temperature: 0.6, signal });
  const text = (data?.choices?.[0]?.message as OAIMessage | undefined)?.content;
  if (!text?.trim()) throw new Error(i18next.t("errors.emptyResponse"));
  return text.trim();
}
