import { z } from "zod";

/**
 * The wire shape of domain rows, and the schemas that validate writes.
 *
 * The row types intentionally mirror the SQLite rows byte for byte — integer
 * 0/1 for booleans, `null` for absent — so the client's existing `TodoRow` /
 * `ListRow` are these types re-exported, and every downstream component
 * (`ItemCard`, the Today widgets, `ai.ts`) keeps working without a translation
 * layer. The server returns rows in exactly this shape; `db.ts` passes them
 * straight through.
 */

// ---------------------------------------------------------------------------
// Rows (server → client)
// ---------------------------------------------------------------------------

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

export interface EventRow {
  id: string;
  summary: string;
  description: string | null;
  location: string | null;
  dtstart: string;              // ISO 8601
  dtend: string | null;
  all_day: number;              // 0 | 1
  rrule: string | null;         // RFC 5545
  exdates: string | null;       // JSON array of ISO dates
  status: string;               // CONFIRMED | TENTATIVE | CANCELLED
  categories: string | null;    // JSON array
  color: string | null;
  sequence: number;
  created_at: string | null;
  updated_at: string | null;
}

export interface PersonRow {
  id: string;
  full_name: string;
  given_name: string | null;
  family_name: string | null;
  additional_names: string | null;
  honorific_prefix: string | null;
  honorific_suffix: string | null;
  nickname: string | null;
  emails: string | null;         // JSON [{type,value,primary?}]
  phones: string | null;         // JSON [{type,value,primary?}]
  addresses: string | null;      // JSON [{type,street,...}]
  organization: string | null;
  title: string | null;
  birthday: string | null;       // ISO date
  urls: string | null;           // JSON [{type,value}]
  notes: string | null;
  photo: string | null;          // data URI / URL
  custom_fields: string | null;  // JSON [{label,value}]
  favorite: number;
  sequence: number;
  created_at: string | null;
  updated_at: string | null;
}

export interface CustomFieldDef {
  id: string;
  label: string;
  position: number;
}

// ---------------------------------------------------------------------------
// Shared field validators
// ---------------------------------------------------------------------------

/** A client-generated UUID. Ids are minted on the client so a write retried
 *  over a flaky network is idempotent on its id rather than creating a
 *  duplicate — the one decision that makes mobile retries safe. */
const idSchema = z.string().uuid();
const isoOrNull = z.string().datetime({ offset: true }).nullable();
/** SQLite booleans are 0/1; kept as such on the wire so rows round-trip. */
const boolInt = z.union([z.literal(0), z.literal(1)]);
const priority = z.number().int().min(0).max(3);
/** A bounded JSON-or-plain text column (exdates, categories, person emails …).
 *  Validated only as text — its internal shape is the client's concern. */
const jsonText = z.string().max(100_000).nullable();

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

export const listCreateSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(200),
  color: z.string().max(32).nullable().optional(),
});

/** Update is partial: an absent key means "leave alone", an explicit `null`
 *  means "clear". `undefined` cannot survive `JSON.stringify`, so the two are
 *  distinguished by key PRESENCE, never by value nullishness — the Worker
 *  inspects which keys arrived. */
export const listUpdateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  color: z.string().max(32).nullable().optional(),
});

export type ListCreate = z.infer<typeof listCreateSchema>;
export type ListUpdate = z.infer<typeof listUpdateSchema>;

// ---------------------------------------------------------------------------
// Todos
// ---------------------------------------------------------------------------

const todoFields = {
  title: z.string().trim().min(1).max(1000),
  notes: z.string().max(100_000).nullable(),
  list_id: idSchema.nullable(),
  due_at: isoOrNull,
  priority,
  completed: boolInt,
  completed_at: isoOrNull,
  parent_todo_id: idSchema.nullable(),
  position: z.number().int().nullable(),
};

export const todoCreateSchema = z.object({ id: idSchema, ...todoFields });

/** Partial-merge; see listUpdateSchema for the presence-vs-null rule. */
export const todoUpdateSchema = z.object({
  title: todoFields.title.optional(),
  notes: todoFields.notes.optional(),
  list_id: todoFields.list_id.optional(),
  due_at: todoFields.due_at.optional(),
  priority: todoFields.priority.optional(),
  completed: todoFields.completed.optional(),
  completed_at: todoFields.completed_at.optional(),
  parent_todo_id: todoFields.parent_todo_id.optional(),
  position: todoFields.position.optional(),
});

/** The whole ordered id list in one request. Never one call per row — at
 *  ~105 ms per D1 round-trip, per-row reordering would be visibly slow and
 *  burn request quota. */
export const todoReorderSchema = z.object({
  ids: z.array(idSchema).max(2000),
});

export type TodoCreate = z.infer<typeof todoCreateSchema>;
export type TodoUpdate = z.infer<typeof todoUpdateSchema>;

/** A list read that can be filtered server-side. The search box passes `q`;
 *  the plain list omits it. Ranking for `q` lives server-side (one copy of the
 *  ranking helpers, imported from this package) so the phrasing bug the helpers
 *  exist to prevent cannot reappear in a second implementation. */
export const todoQuerySchema = z.object({
  q: z.string().max(200).optional(),
  list_id: idSchema.optional(),
  completed: z.enum(["0", "1"]).optional(),
});

export type TodoQuery = z.infer<typeof todoQuerySchema>;

// ---------------------------------------------------------------------------
// Reminders — same create/partial-update/query shape as todos, no list or
// parent, plus remind_at / rrule / linked_todo_id.
// ---------------------------------------------------------------------------

const reminderFields = {
  title: z.string().trim().min(1).max(1000),
  notes: z.string().max(100_000).nullable(),
  due_at: isoOrNull,
  remind_at: isoOrNull,
  rrule: z.string().max(1000).nullable(),
  priority,
  completed: boolInt,
  completed_at: isoOrNull,
  linked_todo_id: idSchema.nullable(),
};

export const reminderCreateSchema = z.object({ id: idSchema, ...reminderFields });

export const reminderUpdateSchema = z.object({
  title: reminderFields.title.optional(),
  notes: reminderFields.notes.optional(),
  due_at: reminderFields.due_at.optional(),
  remind_at: reminderFields.remind_at.optional(),
  rrule: reminderFields.rrule.optional(),
  priority: reminderFields.priority.optional(),
  completed: reminderFields.completed.optional(),
  completed_at: reminderFields.completed_at.optional(),
  linked_todo_id: reminderFields.linked_todo_id.optional(),
});

export const reminderQuerySchema = z.object({
  q: z.string().max(200).optional(),
  completed: z.enum(["0", "1"]).optional(),
});

export type ReminderCreate = z.infer<typeof reminderCreateSchema>;
export type ReminderUpdate = z.infer<typeof reminderUpdateSchema>;
export type ReminderQuery = z.infer<typeof reminderQuerySchema>;

// ---------------------------------------------------------------------------
// Events (iCalendar VEVENT shape). This is the LOCAL ("Second Brain") calendar
// only — CalDAV calendars are never stored here, so they need no schema.
// dtstart is a required ISO instant; all_day/rrule/exdates carry the recurrence.
// ---------------------------------------------------------------------------

const eventFields = {
  summary: z.string().max(2000),
  description: z.string().max(100_000).nullable(),
  location: z.string().max(2000).nullable(),
  dtstart: z.string().datetime({ offset: true }),
  dtend: isoOrNull,
  all_day: boolInt,
  rrule: z.string().max(2000).nullable(),
  exdates: jsonText,
  status: z.string().max(40),
  categories: jsonText,
  color: z.string().max(32).nullable(),
};

export const eventCreateSchema = z.object({ id: idSchema, ...eventFields });

export const eventUpdateSchema = z.object({
  summary: eventFields.summary.optional(),
  description: eventFields.description.optional(),
  location: eventFields.location.optional(),
  dtstart: eventFields.dtstart.optional(),
  dtend: eventFields.dtend.optional(),
  all_day: eventFields.all_day.optional(),
  rrule: eventFields.rrule.optional(),
  exdates: eventFields.exdates.optional(),
  status: eventFields.status.optional(),
  categories: eventFields.categories.optional(),
  color: eventFields.color.optional(),
});

export const eventQuerySchema = z.object({ q: z.string().max(200).optional() });

export type EventCreate = z.infer<typeof eventCreateSchema>;
export type EventUpdate = z.infer<typeof eventUpdateSchema>;
export type EventQuery = z.infer<typeof eventQuerySchema>;

// ---------------------------------------------------------------------------
// People (vCard-shaped). Multi-value fields are JSON strings, validated only as
// bounded text here — their internal shape is the client's concern.
// ---------------------------------------------------------------------------

/**
 * A person's photo is a data URI. Bounded well under D1's 2 MB row cap so a
 * whole person row can't blow the limit — PhotoPicker downscales before this,
 * and full-size images belong in R2 (a later concern), not a row column.
 */
const photoText = z.string().max(1_400_000).nullable();

const personFields = {
  // Empty is allowed on purpose: the People UI creates a blank contact and then
  // lets the user fill it in, so the first write has no name yet. The row is
  // still NOT NULL — "" satisfies it, as it did locally.
  full_name: z.string().trim().max(500),
  given_name: z.string().max(500).nullable(),
  family_name: z.string().max(500).nullable(),
  additional_names: z.string().max(500).nullable(),
  honorific_prefix: z.string().max(100).nullable(),
  honorific_suffix: z.string().max(100).nullable(),
  nickname: z.string().max(500).nullable(),
  emails: jsonText,
  phones: jsonText,
  addresses: jsonText,
  organization: z.string().max(500).nullable(),
  title: z.string().max(500).nullable(),
  birthday: z.string().max(40).nullable(),
  urls: jsonText,
  notes: z.string().max(100_000).nullable(),
  photo: photoText,
  custom_fields: jsonText,
  favorite: boolInt,
};

export const personCreateSchema = z.object({ id: idSchema, ...personFields });

export const personUpdateSchema = z.object(
  Object.fromEntries(
    Object.entries(personFields).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()]),
  ),
) as z.ZodObject<{ [K in keyof typeof personFields]: z.ZodOptional<(typeof personFields)[K]> }>;

export const personQuerySchema = z.object({ q: z.string().max(200).optional() });

export type PersonCreate = z.infer<typeof personCreateSchema>;
export type PersonUpdate = z.infer<typeof personUpdateSchema>;
export type PersonQuery = z.infer<typeof personQuerySchema>;

// ---------------------------------------------------------------------------
// Global custom-field labels (shared across all people in a space)
// ---------------------------------------------------------------------------

/** Ensure-a-label: idempotent by label (case-insensitive), so no client id. */
export const customFieldCreateSchema = z.object({
  label: z.string().trim().min(1).max(200),
});

export const customFieldReorderSchema = z.object({
  ids: z.array(idSchema).max(500),
});

export type CustomFieldCreate = z.infer<typeof customFieldCreateSchema>;
