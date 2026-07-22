// Demo data seeding, triggered by a secret keystroke (see App.tsx).
// resetAndSeedDemo() wipes ALL user data and replaces it with a realistic,
// cross-linked dataset so the app can be explored without manual setup.
// Dates are relative to "now" so the demo always looks current.

import {
  db, nowIso,
  DATA_TABLES,
  upsertEvent, upsertReminder, upsertNote, upsertPerson,
  ensureCustomField, tagItem, createLink,
} from "../db";

// M2 note: todos and lists are remote now, so the demo seeder no longer creates
// them. This seeder auto-runs on every browser dev load (browserDb reseeds each
// time); seeding todos/lists here would hammer the Worker and pile up duplicates
// on every reload, since each seed mints fresh ids. The demo therefore covers
// only the still-local domains — events, reminders, notes, people — and a freshly
// registered account already has its Personal/Work lists from the server. The
// few demo cross-links that pointed at todos are dropped until the demo is
// reworked for the cloud model.

/** Remove every row from every LOCAL user table. DATA_TABLES still lists todos
 *  and lists, whose local tables are simply empty and unused now — the DELETE is
 *  a harmless no-op there, and the remote copies are untouched. */
export async function clearAllData(): Promise<void> {
  const d = await db();
  for (const table of DATA_TABLES) {
    await d.execute(`DELETE FROM ${table}`);
  }
}

/** Build a vCard-style birthday (yyyy-mm-dd) from a day offset + year. */
function bday(dayOffset: number, year: number): string {
  const d = at(dayOffset, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${year}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// --- date helpers (local time) ---
function at(dayOffset: number, hour: number, minute = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d;
}
function iso(dayOffset: number, hour: number, minute = 0): string {
  return at(dayOffset, hour, minute).toISOString();
}

export async function resetAndSeedDemo(): Promise<void> {
  await clearAllData();

  // ---- Events (incl. recurring) ----
  const standup = await upsertEvent({
    summary: "Team standup", description: "Daily sync", location: "Zoom",
    dtstart: iso(0, 9, 30), dtend: iso(0, 9, 45), all_day: 0,
    rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", exdates: null,
    status: "CONFIRMED", categories: JSON.stringify(["Work"]), color: "#ef4444",
  });
  const lunch = await upsertEvent({
    summary: "Lunch with Alex", description: null, location: "Cafe Rio",
    dtstart: iso(0, 12, 30), dtend: iso(0, 13, 30), all_day: 0,
    rrule: null, exdates: null, status: "CONFIRMED",
    categories: JSON.stringify(["Personal"]), color: "#3b82f6",
  });
  const oneOnOne = await upsertEvent({
    summary: "1:1 with manager", description: "Weekly check-in", location: null,
    dtstart: iso(1, 15, 0), dtend: iso(1, 15, 30), all_day: 0,
    rrule: "FREQ=WEEKLY;BYDAY=TU", exdates: null, status: "CONFIRMED",
    categories: JSON.stringify(["Work"]), color: "#ef4444",
  });
  await upsertEvent({
    summary: "Dentist appointment", description: "Cleaning", location: "Downtown Dental",
    dtstart: iso(3, 10, 0), dtend: iso(3, 11, 0), all_day: 0,
    rrule: null, exdates: null, status: "CONFIRMED",
    categories: JSON.stringify(["Health"]), color: "#10b981",
  });
  await upsertEvent({
    summary: "Gym", description: "Leg day", location: null,
    dtstart: iso(1, 7, 0), dtend: iso(1, 8, 0), all_day: 0,
    rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR", exdates: null, status: "CONFIRMED",
    categories: JSON.stringify(["Health"]), color: "#f59e0b",
  });
  const sarahBday = await upsertEvent({
    summary: "Sarah's birthday", description: null, location: null,
    dtstart: iso(5, 0, 0), dtend: null, all_day: 1,
    rrule: "FREQ=YEARLY", exdates: null, status: "CONFIRMED",
    categories: JSON.stringify(["Personal"]), color: "#ec4899",
  });

  // ---- Reminders ----
  const meds = await upsertReminder({
    title: "Take vitamins", notes: null, due_at: null, remind_at: iso(0, 8, 0),
    rrule: "FREQ=DAILY", priority: 1, completed: 0, completed_at: null, linked_todo_id: null,
  });
  await upsertReminder({
    title: "Pay rent", notes: "Auto-transfer or manual?", due_at: iso(6, 9, 0),
    remind_at: iso(6, 9, 0), rrule: "FREQ=MONTHLY", priority: 3, completed: 0,
    completed_at: null, linked_todo_id: null,
  });
  await upsertReminder({
    title: "Water the plants", notes: null, due_at: null, remind_at: iso(2, 18, 0),
    rrule: null, priority: 2, completed: 0, completed_at: null, linked_todo_id: null,
  });
  await upsertReminder({
    title: "Submit expense report", notes: null, due_at: iso(-1, 17, 0),
    remind_at: iso(-1, 17, 0), rrule: null, priority: 2, completed: 0,
    completed_at: null, linked_todo_id: null,
  });
  await upsertReminder({
    title: "Book flights", notes: "Done!", due_at: iso(-3, 12, 0), remind_at: null,
    rrule: null, priority: 0, completed: 1, completed_at: nowIso(), linked_todo_id: null,
  });

  // ---- Notes (markdown) ----
  const standupNotes = await upsertNote({
    title: "Standup notes",
    body: "## This week\n\n- Shipped the new onboarding flow\n- **Blocked** on API keys for the payments integration\n- Next: start the Q3 report\n\n> Follow up with Alex about the design review.",
    pinned: 0,
  });
  const ideas = await upsertNote({
    title: "Project ideas",
    body: "# Ideas\n\n1. A CLI for managing dotfiles\n2. Habit tracker with streaks\n3. This app — a *second brain* 🧠\n\n- [ ] Sketch the data model\n- [x] Pick the stack",
    pinned: 1,
  });
  await upsertNote({
    title: "Books to read",
    body: "- *Thinking, Fast and Slow*\n- *The Pragmatic Programmer*\n- *Deep Work*",
    pinned: 1,
  });
  await upsertNote({
    title: "Grocery meal plan",
    body: "**Mon** stir fry\n**Tue** tacos\n**Wed** pasta",
    pinned: 0,
  });

  // ---- People (contacts, vCard-modeled) ----
  const emptyName = {
    given_name: null as string | null, family_name: null as string | null,
    additional_names: null, honorific_prefix: null, honorific_suffix: null,
    addresses: null as string | null, urls: null as string | null,
    title: null as string | null, photo: null as string | null,
  };
  const alex = await upsertPerson({
    ...emptyName, full_name: "Alex Rivera", given_name: "Alex", family_name: "Rivera",
    nickname: "Al", organization: "Acme Corp", title: "Product Designer",
    birthday: bday(21, 1992),
    emails: JSON.stringify([{ type: "work", value: "alex@acme.com" }]),
    phones: JSON.stringify([{ type: "cell", value: "+1 555 010 2020" }]),
    notes: "Met at the design conference.",
    custom_fields: JSON.stringify([{ label: "Coffee order", value: "Oat flat white" }]),
    favorite: 1,
  });
  // Custom-field labels are global (shared across all people).
  await ensureCustomField("Coffee order");
  const sarah = await upsertPerson({
    ...emptyName, full_name: "Sarah Chen", given_name: "Sarah", family_name: "Chen",
    nickname: null, organization: null, title: null,
    birthday: bday(5, 1990),
    emails: JSON.stringify([{ type: "home", value: "sarah.chen@example.com" }]),
    phones: JSON.stringify([{ type: "cell", value: "+1 555 010 3131" }]),
    notes: null, custom_fields: null, favorite: 0,
  });
  await upsertPerson({
    ...emptyName, full_name: "Linda (Mom)", given_name: "Linda", family_name: null,
    nickname: "Mom", organization: null, title: null,
    birthday: bday(40, 1961),
    emails: null,
    phones: JSON.stringify([{ type: "home", value: "+1 555 010 4242" }]),
    notes: null, custom_fields: null, favorite: 1,
  });

  // ---- Tags (shared across types) ----
  // Todo tags are omitted in M2 — todos are remote and not seeded here.
  await tagItem("work", "event", standup);
  await tagItem("work", "event", oneOnOne);
  await tagItem("health", "reminder", meds);
  await tagItem("ideas", "note", ideas);
  await tagItem("work", "person", alex);

  // ---- Links (any item <-> any item, including people) ----
  // Links to todos are omitted in M2 for the same reason.
  await createLink("note", standupNotes, "event", standup);   // meeting notes on the standup
  await createLink("person", alex, "event", lunch);           // Alex is at lunch
  await createLink("person", sarah, "event", sarahBday);      // Sarah's birthday
}
