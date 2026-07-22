// Demo data seeding, triggered by a secret keystroke (see App.tsx).
// resetAndSeedDemo() wipes local data and re-seeds the still-local domains.

import {
  db,
  DATA_TABLES,
  upsertNote, tagItem,
} from "../db";

// Migration note: as each domain moves to the Worker it leaves this seeder,
// which auto-runs on every browser dev load (browserDb reseeds each time) —
// seeding a remote domain here would hammer the Worker and pile up duplicates.
// Remote already: todos, lists, reminders, people, events (M2/M3). Notes are
// the only domain still seeded here; once notes move (M4) this seeder — and the
// whole browserDb demo path — retires. A freshly registered account gets its
// Personal/Work lists from the server.

/** Remove every row from every LOCAL user table. Most of DATA_TABLES now names
 *  empty, unused local tables (their data lives on the server), so the DELETE
 *  is a harmless no-op there and the remote copies are untouched. */
export async function clearAllData(): Promise<void> {
  const d = await db();
  for (const table of DATA_TABLES) {
    await d.execute(`DELETE FROM ${table}`);
  }
}

export async function resetAndSeedDemo(): Promise<void> {
  await clearAllData();

  // Events, reminders, todos, lists, people are all remote now (M2/M3) — the
  // demo no longer seeds them (it auto-runs on every browser dev load and would
  // hammer the Worker / pile up duplicates). Notes are the last local domain,
  // so they're the only thing this seeds. Cross-links between notes and the
  // now-remote events are gone with them.

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

  // ---- Tags ----
  // Only notes remain local, so only note tags are seeded.
  await tagItem("ideas", "note", ideas);

  // Links between notes and now-remote items (events) are gone; standupNotes is
  // kept unlinked so the note itself still appears.
  void standupNotes;
}
