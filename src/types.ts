// Domain types mirroring the SQLite schema (src-tauri/migrations/001_init.sql).
// Booleans are stored as 0/1 integers in SQLite; we expose them as numbers
// at the DB boundary and convert where convenient.

export type ItemType = "event" | "reminder" | "todo" | "note" | "person";

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

export interface ReminderRow {
  id: string;
  title: string;
  notes: string | null;
  due_at: string | null;
  remind_at: string | null;
  rrule: string | null;
  priority: number;
  completed: number;
  completed_at: string | null;
  linked_todo_id: string | null;
  sequence: number;
  created_at: string | null;
  updated_at: string | null;
}

export interface ListRow {
  id: string;
  name: string;
  color: string | null;
}

export interface TodoRow {
  id: string;
  title: string;
  notes: string | null;
  list_id: string | null;
  due_at: string | null;
  priority: number;
  completed: number;
  completed_at: string | null;
  parent_todo_id: string | null;
  position: number | null;
  sequence: number;
  created_at: string | null;
  updated_at: string | null;
}

export interface NoteRow {
  id: string;
  title: string | null;
  body: string | null;
  pinned: number;
  created_at: string | null;
  updated_at: string | null;
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

// A single concrete occurrence of an event after RRULE expansion.
export interface EventOccurrence {
  event: EventRow;
  start: Date;
  end: Date | null;
  isRecurringInstance: boolean;
}
