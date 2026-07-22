// Demo data seeding, triggered by a secret keystroke (see App.tsx).
// resetAndSeedDemo() wipes ALL user data and replaces it with a realistic,
// cross-linked dataset so the app can be explored without manual setup.
// Dates are relative to "now" so the demo always looks current.

import {
  db,
  DATA_TABLES,
  upsertEvent, upsertNote, tagItem, createLink,
} from "../db";

// Migration note: as each domain moves to the Worker it leaves this seeder,
// which auto-runs on every browser dev load (browserDb reseeds each time) —
// seeding a remote domain here would hammer the Worker and pile up duplicates.
// Remote already: todos, lists, reminders, people (M2/M3). Still local and
// seeded here: events, notes. A freshly registered account gets its
// Personal/Work lists from the server. Cross-links that pointed at now-remote
// items are dropped until the demo is reworked for the cloud model.

/** Remove every row from every LOCAL user table. DATA_TABLES still lists todos
 *  and lists, whose local tables are simply empty and unused now — the DELETE is
 *  a harmless no-op there, and the remote copies are untouched. */
export async function clearAllData(): Promise<void> {
  const d = await db();
  for (const table of DATA_TABLES) {
    await d.execute(`DELETE FROM ${table}`);
  }
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
  await upsertEvent({
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
  await upsertEvent({
    summary: "Sarah's birthday", description: null, location: null,
    dtstart: iso(5, 0, 0), dtend: null, all_day: 1,
    rrule: "FREQ=YEARLY", exdates: null, status: "CONFIRMED",
    categories: JSON.stringify(["Personal"]), color: "#ec4899",
  });

  // ---- Reminders ----
  // Reminders are remote now (M3), so the demo no longer seeds them — same
  // reasoning as todos/lists in M2. Seeding them here would write to the real
  // space on every browser dev load and pile up duplicates.

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

  // People are remote now (M3b), so the demo no longer seeds contacts or their
  // custom fields — same reason as todos/lists/reminders.

  // ---- Tags (shared across types) ----
  // Only the still-local domains (events, notes) get demo tags; todo/reminder/
  // person tags are omitted while those live on the server.
  await tagItem("work", "event", standup);
  await tagItem("work", "event", oneOnOne);
  await tagItem("ideas", "note", ideas);

  // ---- Links (any item <-> any item) ----
  await createLink("note", standupNotes, "event", standup);   // meeting notes on the standup
}
