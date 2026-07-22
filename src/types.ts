// Domain types mirroring the SQLite schema (src-tauri/migrations/001_init.sql).
// Booleans are stored as 0/1 integers in SQLite; we expose them as numbers
// at the DB boundary and convert where convenient.

export type ItemType = "event" | "reminder" | "todo" | "note" | "person";

/**
 * A pointer to one item, used to render it as a card in the assistant chat.
 *
 * Deliberately *only* identity — never the item's fields. The card loads the
 * current row itself so what it shows is the real data, not whatever the model
 * happened to write. For events, `calendarId` says which calendar the id lives
 * in (remote events have no SQLite row) and `occurrenceStart` picks one
 * instance of a recurring series, whose id is shared by every occurrence.
 */
export interface ItemRef {
  type: ItemType;
  id: string;
  calendarId?: string;
  occurrenceStart?: string; // ISO
}

/**
 * A specific item to open when navigating into a view — e.g. clicking a note on
 * the Today dashboard, or an assistant card, opens that item rather than the
 * bare list. Each view consumes its own key on mount.
 */
export interface NavTarget {
  noteId?: string;
  eventId?: string;
  /**
   * ISO start of the occurrence to open. The calendar resolves a target out of
   * the events it has loaded for the *visible* window, so without this a hit
   * from global search — which can be months away — opens nothing at all. It
   * also picks the right instance of a recurring series.
   */
  eventStart?: string;
  todoId?: string;
  reminderId?: string;
  personId?: string;
}

export type GoTo = (view: string, target?: NavTarget) => void;

export interface EventRow {
  id: string;
  summary: string;
  description: string | null;
  location: string | null;
  dtstart: string; // ISO 8601
  dtend: string | null;
  all_day: number; // 0 | 1
  rrule: string | null; // RFC 5545, e.g. "FREQ=WEEKLY;BYDAY=MO,WE,FR"
  exdates: string | null; // JSON array of ISO dates
  status: string; // CONFIRMED | TENTATIVE | CANCELLED
  categories: string | null; // JSON array
  color: string | null;
  sequence: number;
  created_at: string | null;
  updated_at: string | null;
}

// ReminderRow is defined in @secondbrain/shared (see TodoRow/ListRow above).
export type { ReminderRow } from "@secondbrain/shared";

// TodoRow and ListRow are defined in @secondbrain/shared so the Worker returns
// exactly the shape the client consumes. Re-exported here because the whole app
// imports its domain types from "./types".
export type { TodoRow, ListRow } from "@secondbrain/shared";

export interface NoteRow {
  id: string;
  title: string | null;
  body: string | null;
  pinned: number;
  created_at: string | null;
  updated_at: string | null;
}

// An image embedded in a note. The markdown in `NoteRow.body` carries only
// `![alt](sbimg:<id>)`; the bytes live in their own table so the note list and
// the FTS index never touch them. See 006_note_images.sql.
export interface NoteImageRow {
  id: string;
  note_id: string;
  mime: string;
  data: string; // base64, no `data:` prefix
  width: number;
  height: number;
  created_at: string;
}

// People (contacts), modeled on vCard 4.0 (RFC 6350). See 003_people.sql.
// Multi-value fields are stored as JSON arrays on the row (parsed at the UI
// boundary), the same pattern events use for exdates/categories.
export interface PersonEmail { type: string; value: string; primary?: boolean }
export interface PersonPhone { type: string; value: string; primary?: boolean }
export interface PersonAddress {
  type: string;
  street?: string;
  city?: string;
  region?: string;
  postal_code?: string;
  country?: string;
}
export interface PersonUrl { type: string; value: string }
/** User-defined data point, e.g. { label: "Eye Color", value: "Blue" }. */
export interface PersonCustomField { label: string; value: string }

export interface PersonRow {
  id: string;               // UUID, = vCard UID
  full_name: string;        // vCard FN
  given_name: string | null;
  family_name: string | null;
  additional_names: string | null;
  honorific_prefix: string | null;
  honorific_suffix: string | null;
  nickname: string | null;
  emails: string | null;    // JSON PersonEmail[]
  phones: string | null;    // JSON PersonPhone[]
  addresses: string | null; // JSON PersonAddress[]
  organization: string | null;
  title: string | null;
  birthday: string | null;  // ISO date (vCard BDAY)
  urls: string | null;      // JSON PersonUrl[]
  notes: string | null;
  photo: string | null;     // data URI / URL
  custom_fields: string | null; // JSON PersonCustomField[]
  favorite: number;         // 0 | 1
  sequence: number;
  created_at: string | null;
  updated_at: string | null;
}

export interface TagRow {
  id: string;
  name: string;
}

export interface LinkRow {
  id: string;
  source_type: ItemType;
  source_id: string;
  target_type: ItemType;
  target_id: string;
  created_at: string | null;
}

// Priority levels shared by reminders & todos (iCal-ish: 0 none, 1 low..9 high;
// we keep it simple with 0/1/2/3).
export const PRIORITY = { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3 } as const;

// ---------------------------------------------------------------------------
// Calendars
//
// Events come from two places: the built-in SQLite calendar (`local`) and any
// CalDAV calendars the user has connected (`caldav`, e.g. iCloud). Remote
// events are fetched live and never stored in SQLite, so `UnifiedEvent` — not
// `EventRow` — is the shape the calendar UI, the aggregator, and the assistant
// work with. `href`/`etag` are the CalDAV resource identity needed to write.
// ---------------------------------------------------------------------------
export type EventSource = "local" | "caldav";

/** The id of the built-in SQLite calendar. */
export const LOCAL_CALENDAR_ID = "local";

export interface UnifiedEvent {
  source: EventSource;
  calendarId: string; // LOCAL_CALENDAR_ID, or a CalDavCalendar.id
  id: string; // local UUID, or the remote event's iCal UID
  href?: string; // CalDAV resource URL — required for PUT/DELETE
  etag?: string; // CalDAV ETag — sent as If-Match on write
  color: string | null; // event colour (local) or calendar colour (remote)
  // RFC 5545 core, same shape/units as the matching EventRow fields.
  summary: string;
  description: string | null;
  location: string | null;
  dtstart: string; // ISO 8601, absolute instant (TZID already resolved)
  dtend: string | null;
  // The zone `dtstart` was authored in, when we know it (remote events only).
  // Purely a write-back hint so a recurring series keeps its wall-clock time —
  // `dtstart` stays an absolute instant and nothing should read this to render.
  tzid?: string | null;
  all_day: number; // 0 | 1
  rrule: string | null;
  exdates: string | null; // JSON array of ISO dates
  status: string;
  categories: string | null; // JSON array
}

// A single concrete occurrence of an event after recurrence expansion.
export interface EventOccurrence {
  event: UnifiedEvent;
  start: Date;
  end: Date | null;
  isRecurringInstance: boolean;
}
