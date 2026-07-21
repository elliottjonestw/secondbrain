import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CloudOff } from "lucide-react";
import type { ItemType, GoTo } from "../types";
import { searchNotes, searchPeople, searchReminders, searchTodos } from "../db";
import { searchEvents, listCalendars, getCalendar } from "../lib/calendars";
import { fmtDate, fmtDateTime, startOfDay, endOfDay } from "../lib/format";
import { ItemCard, VIEW_FOR, targetFor } from "../components/ItemCard";
import { Button } from "../components/ui";

interface Hit {
  type: ItemType;
  id: string;
  label: string;
  sub: string;
  /** Events only — needed to re-fetch a remote event and to open the right
   *  occurrence of a recurring series. */
  calendarId?: string;
  occurrenceStart?: string;
}

/**
 * How far either side of today connected calendars are searched, in months.
 *
 * CalDAV has no keyword search — the only server-side filter is a time-range —
 * so remote results exist only inside a window, and the user is told which one.
 * The steps widen rather than reset, and lean backwards: people search for
 * things they've half-forgotten, which are usually behind them.
 */
const WINDOW_STEPS: { back: number; ahead: number }[] = [
  { back: 12, ahead: 12 },
  { back: 36, ahead: 24 },
  { back: 120, ahead: 60 },
];

/** Whole days, so the window is stable between keystrokes and hits the 60s
 *  per-calendar cache in calendars.ts instead of refetching on every character. */
function windowFor(step: number): [Date, Date] {
  const { back, ahead } = WINDOW_STEPS[Math.min(step, WINDOW_STEPS.length - 1)];
  const from = new Date();
  from.setMonth(from.getMonth() - back);
  const to = new Date();
  to.setMonth(to.getMonth() + ahead);
  return [startOfDay(from), endOfDay(to)];
}

export default function SearchView({ query, goTo }: { query: string; goTo: GoTo }) {
  const { t } = useTranslation();
  const [hits, setHits] = useState<Hit[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(false);

  // Only worth naming a window when something is actually searched by one.
  const hasRemote = useMemo(
    () => listCalendars().some((c) => c.source === "caldav" && c.visible),
    [],
  );
  const [winStart, winEnd] = useMemo(() => windowFor(step), [step]);

  useEffect(() => {
    const q = query.trim();
    if (!q) { setHits([]); setErrors([]); setLoading(false); return; }

    // Debounced because a keystroke can now cost a CalDAV round-trip.
    setLoading(true);
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        const [events, reminders, todos, notes, people] = await Promise.all([
          searchEvents(q, winStart, winEnd),
          searchReminders(q),
          searchTodos(q),
          searchNotes(q),
          searchPeople(q),
        ]);
        if (cancelled) return;

        setErrors(events.errors);
        setHits([
          ...events.hits.map((h) => {
            const cal = getCalendar(h.event.calendarId);
            const when = fmtDateTime(h.start.toISOString());
            return {
              type: "event" as ItemType,
              id: h.event.id,
              label: h.event.summary,
              // Which calendar it came from matters here in a way it doesn't
              // elsewhere: results from several calendars interleave by date.
              sub: cal && cal.source === "caldav" ? `${when} · ${cal.name}` : when,
              calendarId: h.event.calendarId,
              occurrenceStart: h.start.toISOString(),
            };
          }),
          ...reminders.map((r) => ({ type: "reminder" as ItemType, id: r.id, label: r.title, sub: r.due_at ? t("card.due", { when: fmtDateTime(r.due_at) }) : "" })),
          ...todos.map((td) => ({ type: "todo" as ItemType, id: td.id, label: td.title, sub: td.due_at ? t("card.due", { when: fmtDateTime(td.due_at) }) : "" })),
          ...notes.map((n) => ({ type: "note" as ItemType, id: n.id, label: n.title || t("common.untitled"), sub: (n.body ?? "").slice(0, 60) })),
          ...people.map((p) => ({ type: "person" as ItemType, id: p.id, label: p.full_name || t("people.newContact"), sub: p.organization || p.nickname || "" })),
        ]);
        setLoading(false);
      })();
    }, 250);

    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, winStart, winEnd, t]);

  const canWiden = step < WINDOW_STEPS.length - 1;

  return (
    <div className="mx-auto h-full max-w-2xl overflow-y-auto p-6">
      <h1 className="mb-4 text-xl font-bold">{t("search.resultsFor", { query })}</h1>
      {query.trim() === "" ? (
        <p className="text-neutral-400">{t("search.prompt")}</p>
      ) : (
        <>
          {errors.length > 0 && (
            <p className="mb-3 flex items-start gap-2 text-sm text-amber-600 dark:text-amber-500">
              <CloudOff size={15} className="mt-0.5 shrink-0" />
              <span>{t("search.calendarsUnavailable", { names: errors.join("; ") })}</span>
            </p>
          )}
          {hits.length === 0 ? (
            <p className="text-neutral-400">{loading ? t("search.searching") : t("search.noMatches")}</p>
          ) : (
            <div className="space-y-1">
              {hits.map((h) => (
                // One recurring id has many starts; keying on id alone would
                // collapse them into a single row.
                <ItemCard
                  key={`${h.type}|${h.id}|${h.occurrenceStart ?? ""}`}
                  type={h.type}
                  label={h.label}
                  sub={h.sub}
                  onClick={() => goTo(VIEW_FOR[h.type], targetFor(h))}
                />
              ))}
            </div>
          )}
          {hasRemote && (
            <div className="mt-6 flex items-center gap-3 border-t border-neutral-200 pt-3 text-xs text-neutral-500 dark:border-neutral-700">
              <span>{t("search.remoteWindow", { from: fmtDate(winStart), to: fmtDate(winEnd) })}</span>
              {canWiden && (
                <Button variant="ghost" onClick={() => setStep((s) => s + 1)}>
                  {t("search.widen")}
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
