import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ItemType } from "../types";
import { db, searchNotes, searchPeople, escapeLike } from "../db";
import { fmtDateTime } from "../lib/format";
import { ItemCard, VIEW_FOR, targetFor } from "../components/ItemCard";
import type { GoTo } from "../types";

interface Hit { type: ItemType; id: string; label: string; sub: string; }

export default function SearchView({ query, goTo }: { query: string; goTo: GoTo }) {
  const { t } = useTranslation();
  const [hits, setHits] = useState<Hit[]>([]);

  useEffect(() => {
    const q = query.trim();
    if (!q) { setHits([]); return; }
    void (async () => {
      const like = `%${escapeLike(q)}%`;
      const d = await db();
      const events = await d.select<any[]>("SELECT id, summary, dtstart FROM events WHERE summary LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR location LIKE ? ESCAPE '\\'", [like, like, like]);
      const reminders = await d.select<any[]>("SELECT id, title, due_at FROM reminders WHERE title LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\'", [like, like]);
      const todos = await d.select<any[]>("SELECT id, title, due_at FROM todos WHERE title LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\'", [like, like]);
      const notes = await searchNotes(q);
      const people = await searchPeople(q);

      setHits([
        ...events.map((e) => ({ type: "event" as ItemType, id: e.id, label: e.summary, sub: fmtDateTime(e.dtstart) })),
        ...reminders.map((r) => ({ type: "reminder" as ItemType, id: r.id, label: r.title, sub: r.due_at ? t("card.due", { when: fmtDateTime(r.due_at) }) : "" })),
        ...todos.map((td) => ({ type: "todo" as ItemType, id: td.id, label: td.title, sub: td.due_at ? t("card.due", { when: fmtDateTime(td.due_at) }) : "" })),
        ...notes.map((n) => ({ type: "note" as ItemType, id: n.id, label: n.title || t("common.untitled"), sub: (n.body ?? "").slice(0, 60) })),
        ...people.map((p) => ({ type: "person" as ItemType, id: p.id, label: p.full_name || t("people.newContact"), sub: p.organization || p.nickname || "" })),
      ]);
    })();
  }, [query]);

  return (
    <div className="mx-auto h-full max-w-2xl overflow-y-auto p-6">
      <h1 className="mb-4 text-xl font-bold">{t("search.resultsFor", { query })}</h1>
      {query.trim() === "" ? (
        <p className="text-neutral-400">{t("search.prompt")}</p>
      ) : hits.length === 0 ? (
        <p className="text-neutral-400">{t("search.noMatches")}</p>
      ) : (
        <div className="space-y-1">
          {hits.map((h) => (
            <ItemCard
              key={h.type + h.id}
              type={h.type}
              label={h.label}
              sub={h.sub}
              onClick={() => goTo(VIEW_FOR[h.type], targetFor(h))}
            />
          ))}
        </div>
      )}
    </div>
  );
}
