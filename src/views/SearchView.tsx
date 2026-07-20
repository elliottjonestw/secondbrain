import { useEffect, useState } from "react";
import { Calendar, Bell, ListChecks, StickyNote, Users, LucideIcon } from "lucide-react";
import type { ItemType } from "../types";
import { db, searchNotes, searchPeople } from "../db";
import { fmtDateTime } from "../lib/format";

interface Hit { type: ItemType; id: string; label: string; sub: string; }

const ICON: Record<ItemType, LucideIcon> = { event: Calendar, reminder: Bell, todo: ListChecks, note: StickyNote, person: Users };

export default function SearchView({ query, goTo }: { query: string; goTo: (v: string) => void }) {
  const [hits, setHits] = useState<Hit[]>([]);

  useEffect(() => {
    const q = query.trim();
    if (!q) { setHits([]); return; }
    void (async () => {
      const like = `%${q}%`;
      const d = await db();
      const events = await d.select<any[]>("SELECT id, summary, dtstart FROM events WHERE summary LIKE ? OR description LIKE ? OR location LIKE ?", [like, like, like]);
      const reminders = await d.select<any[]>("SELECT id, title, due_at FROM reminders WHERE title LIKE ? OR notes LIKE ?", [like, like]);
      const todos = await d.select<any[]>("SELECT id, title, due_at FROM todos WHERE title LIKE ? OR notes LIKE ?", [like, like]);
      const notes = await searchNotes(q);
      const people = await searchPeople(q);

      setHits([
        ...events.map((e) => ({ type: "event" as ItemType, id: e.id, label: e.summary, sub: fmtDateTime(e.dtstart) })),
        ...reminders.map((r) => ({ type: "reminder" as ItemType, id: r.id, label: r.title, sub: r.due_at ? `Due ${fmtDateTime(r.due_at)}` : "" })),
        ...todos.map((t) => ({ type: "todo" as ItemType, id: t.id, label: t.title, sub: t.due_at ? `Due ${fmtDateTime(t.due_at)}` : "" })),
        ...notes.map((n) => ({ type: "note" as ItemType, id: n.id, label: n.title || "Untitled", sub: (n.body ?? "").slice(0, 60) })),
        ...people.map((p) => ({ type: "person" as ItemType, id: p.id, label: p.full_name || "New contact", sub: p.organization || p.nickname || "" })),
      ]);
    })();
  }, [query]);

  const viewFor: Record<ItemType, string> = { event: "calendar", reminder: "reminders", todo: "todos", note: "notes", person: "people" };

  return (
    <div className="mx-auto h-full max-w-2xl overflow-y-auto p-6">
      <h1 className="mb-4 text-xl font-bold">Search results for "{query}"</h1>
      {query.trim() === "" ? (
        <p className="text-neutral-400">Type in the search box above.</p>
      ) : hits.length === 0 ? (
        <p className="text-neutral-400">No matches.</p>
      ) : (
        <div className="space-y-1">
          {hits.map((h) => {
            const Icon = ICON[h.type];
            return (
            <button
              key={h.type + h.id}
              onClick={() => goTo(viewFor[h.type])}
              className="flex w-full items-center gap-3 rounded-lg border border-neutral-200 px-3 py-2 text-left hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
            >
              <Icon size={18} className="shrink-0 text-neutral-500" />
              <span className="flex-1">
                <span className="block font-medium">{h.label}</span>
                {h.sub && <span className="block truncate text-xs text-neutral-400">{h.sub}</span>}
              </span>
              <span className="text-xs uppercase text-neutral-400">{h.type}</span>
            </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
