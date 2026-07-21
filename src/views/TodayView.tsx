import { useEffect, useRef, useState } from "react";
import { Bell, Pin, Cake, Sparkles, RotateCw, ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { EventOccurrence, TodoRow, ReminderRow, NoteRow, PersonRow, GoTo } from "../types";
import { listTodos, listReminders, listNotes, listPeople, toggleTodo, toggleReminder } from "../db";
import { getOccurrences } from "../lib/calendars";
import {
  startOfDay, endOfDay, isSameDay, fmtTime, fmtDateTime, fmtMonthDay, fmtFullDate,
  fmtRelativeDays, isOverdue, isToday, ageFromBirthday, toDateInput,
} from "../lib/format";
import { nextOccurrenceFrom } from "../lib/recurrence";
import { summarizeDay, hasDayContent, type DaySummaryInput } from "../lib/ai";
import { isAssistantConfigured } from "../lib/settings";
import { currentLanguage } from "../lib/i18n";
import { PriorityFlag } from "../components/ui";

const PRIORITY_NAMES = ["none", "low", "medium", "high"];
/** How far ahead the summary looks for birthdays. The tile shows 30 days, but a
 *  briefing about *today* only cares about the ones nearly here. */
const BIRTHDAY_HORIZON_DAYS = 7;

/**
 * Effective due time for a reminder on the day being viewed: the occurrence
 * falling on or after that day for a recurring series, or the stored base
 * otherwise. Mirrors ItemCard so a daily 8am reminder shows that day's 8am, not
 * the day the series was created. Returns null if it has no time at all.
 */
function reminderWhen(r: ReminderRow, day: Date): Date | null {
  const base = r.remind_at || r.due_at;
  if (!base) return null;
  if (r.rrule) return nextOccurrenceFrom(base, r.rrule, startOfDay(day));
  return new Date(base);
}

const SUMMARY_CACHE_KEY = "secondbrain.daySummary";
/** How many days' summaries to keep. Enough to step around a week and back
 *  without paying for any of it twice; small enough to stay a tidy blob. */
const SUMMARY_CACHE_MAX = 20;

type SummaryCache = Record<string, string>;

function readSummaryCache(): SummaryCache {
  try {
    const raw = JSON.parse(localStorage.getItem(SUMMARY_CACHE_KEY) || "null");
    return raw && typeof raw === "object" ? (raw as SummaryCache) : {};
  } catch {
    return {}; // an unreadable cache is just a miss
  }
}

function writeSummaryCache(sig: string, text: string): void {
  try {
    const cache = readSummaryCache();
    // Re-inserting moves an entry to the end, so the oldest *untouched* one is
    // what falls off the front.
    delete cache[sig];
    cache[sig] = text;
    const keys = Object.keys(cache);
    for (const k of keys.slice(0, Math.max(0, keys.length - SUMMARY_CACHE_MAX))) delete cache[k];
    localStorage.setItem(SUMMARY_CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* the cache is an optimisation, never a failure */
  }
}

/**
 * The AI briefing above the tiles.
 *
 * Keyed on a signature of the day's data plus the UI language, and cached in
 * localStorage: navigating back to Today, stepping between days, or ticking
 * something off elsewhere and returning, must not spend a request re-saying the
 * same thing. Any change to the day's contents (or the language) changes the
 * signature and regenerates.
 *
 * A failure is not an error state worth shouting about — the tiles below carry
 * the same information — so it degrades to a quiet "couldn't write one" line.
 */
function useDaySummary(input: DaySummaryInput, ready: boolean) {
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [nonce, setNonce] = useState(0);
  // The effect keys off the signature string, not the freshly-built object,
  // which is a new identity on every render.
  const latest = useRef(input);
  latest.current = input;

  const configured = isAssistantConfigured();
  const show = ready && configured && hasDayContent(input);
  const sig = show ? `${currentLanguage()}|${JSON.stringify(input)}` : "";

  useEffect(() => {
    if (!sig) return;
    // A manual refresh (nonce > 0) deliberately ignores the cache.
    const cached = nonce === 0 ? readSummaryCache()[sig] : undefined;
    if (typeof cached === "string") {
      setText(cached);
      setFailed(false);
      return;
    }
    const ctl = new AbortController();
    let live = true;
    // Drop the previous day's prose before fetching — leaving it up would show
    // a confident summary of a day the user has already stepped away from.
    setText(null);
    setLoading(true);
    setFailed(false);
    void summarizeDay(latest.current, ctl.signal)
      .then((t) => {
        if (!live) return;
        setText(t);
        writeSummaryCache(sig, t);
      })
      .catch(() => { if (live) { setText(null); setFailed(true); } })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; ctl.abort(); };
  }, [sig, nonce]);

  return { show, text, loading, failed, refresh: () => setNonce((n) => n + 1) };
}

export default function TodayView({ onChange, goTo }: { onChange: () => void; goTo: GoTo }) {
  const { t: tr } = useTranslation();
  const [occs, setOccs] = useState<EventOccurrence[]>([]);
  const [todos, setTodos] = useState<TodoRow[]>([]);
  const [reminders, setReminders] = useState<ReminderRow[]>([]);
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [people, setPeople] = useState<PersonRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  // The day on show. Always local midnight so it can be compared and stepped
  // without dragging a time-of-day along.
  const [day, setDay] = useState(() => startOfDay(new Date()));
  const viewingToday = isToday(day);
  const stepDay = (delta: number) => {
    const next = new Date(day);
    next.setDate(next.getDate() + delta);
    setDay(startOfDay(next));
  };

  const reload = async () => {
    // Pulls the built-in calendar plus any visible connected ones; a calendar
    // that can't be reached is skipped rather than breaking the whole card.
    const { occurrences } = await getOccurrences(startOfDay(day), endOfDay(day));
    setOccs(occurrences);
    setTodos(await listTodos());
    setReminders(await listReminders());
    setNotes(await listNotes());
    setPeople(await listPeople());
    setLoaded(true);
  };
  // Stepping to another day refetches. `loaded` drops first so the summary
  // can't briefly describe the previous day's data as if it were this one.
  useEffect(() => { setLoaded(false); void reload(); }, [day.getTime()]);
  const bump = () => { void reload(); onChange(); };

  // Overdue is a fact about *now*, so it only pulls extra items onto the day
  // when that day is today. On any other date these cards show exactly what
  // falls on it.
  const dueTodos = todos.filter((t) => {
    if (t.completed || !t.due_at) return false;
    return isSameDay(new Date(t.due_at), day) || (viewingToday && isOverdue(t.due_at));
  });
  const dueReminders = reminders.filter((r) => {
    if (r.completed) return false;
    const when = reminderWhen(r, day);
    if (!when) return false;
    // Recurring reminders recur by design — never treat them as overdue. They
    // show when their occurrence lands on the day; a one-off past reminder shows
    // on today because it's genuinely overdue. Matches ItemCard's reminder branch.
    if (r.rrule) return isSameDay(when, day);
    return isSameDay(when, day) || (viewingToday && isOverdue(when.toISOString()));
  });
  const pinnedNotes = notes.filter((n) => n.pinned).slice(0, 5);
  const recentNotes = notes.filter((n) => !n.pinned).slice(0, 5);
  // Counted forward from the day on show, so stepping to next Friday lists the
  // birthdays coming up from there rather than from today.
  const birthdays = upcomingBirthdays(people, 30, day);

  // Every fact the briefing may state is resolved here — occurrence times,
  // overdue flags, the age each person turns — so the model only has to write
  // prose. It notoriously gets ages and date arithmetic wrong on its own.
  const summaryInput: DaySummaryInput = {
    date: toDateInput(day),
    events: occs.map((o) => ({
      title: o.event.summary,
      start: o.start.toISOString(),
      all_day: !!o.event.all_day,
      location: o.event.location,
    })),
    reminders: dueReminders.map((r) => {
      const when = reminderWhen(r, day);
      return {
        title: r.title,
        due: when ? when.toISOString() : null,
        overdue: !r.rrule && !!when && isOverdue(when.toISOString()),
      };
    }),
    todos: dueTodos.map((t) => ({
      title: t.title,
      due: t.due_at,
      priority: PRIORITY_NAMES[t.priority] ?? "none",
      overdue: isOverdue(t.due_at),
    })),
    // Relative to the day on show — `upcomingBirthdays` already counts from it.
    birthdays: birthdays.filter((b) => b.days <= BIRTHDAY_HORIZON_DAYS).map((b) => {
      // The age they turn = their age *on the birthday itself*, which is what
      // ageFromBirthday returns for that date. Asking for it as of today and
      // adding one is wrong whenever the day on show isn't today.
      const on = new Date(day);
      on.setDate(on.getDate() + b.days);
      const age = b.person.birthday ? ageFromBirthday(b.person.birthday, on) : null;
      return {
        name: b.person.full_name || tr("people.newContact"),
        date: b.dateLabel,
        in_days: b.days,
        age,
      };
    }),
  };
  const summary = useDaySummary(summaryInput, loaded);

  return (
    <div className="mx-auto h-full max-w-4xl overflow-y-auto p-6">
      <div className="mb-4">
        <h1 className="text-2xl font-bold">{tr("nav.today")}</h1>
        <div className="flex items-center gap-1">
          <button
            onClick={() => stepDay(-1)}
            title={tr("today.prevDay")}
            aria-label={tr("today.prevDay")}
            className="rounded p-0.5 text-neutral-400 hover:text-blue-500"
          >
            <ChevronLeft size={16} />
          </button>
          <p className="text-sm text-neutral-400">{fmtFullDate(day)}</p>
          <button
            onClick={() => stepDay(1)}
            title={tr("today.nextDay")}
            aria-label={tr("today.nextDay")}
            className="rounded p-0.5 text-neutral-400 hover:text-blue-500"
          >
            <ChevronRight size={16} />
          </button>
          {/* Only worth showing once there's somewhere to come back from. */}
          {!viewingToday && (
            <button
              onClick={() => setDay(startOfDay(new Date()))}
              className="ml-1 rounded px-1.5 py-0.5 text-xs text-blue-500 hover:bg-neutral-100 dark:hover:bg-neutral-700"
            >
              {tr("today.backToToday")}
            </button>
          )}
        </div>
      </div>

      {summary.show && (
        <div className="mb-4 rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-700 dark:bg-neutral-800">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-neutral-500">
              <Sparkles size={14} className="text-blue-500" />
              {tr("today.summary")}
            </div>
            <button
              onClick={summary.refresh}
              disabled={summary.loading}
              title={tr("today.refreshSummary")}
              aria-label={tr("today.refreshSummary")}
              className="rounded p-1 text-neutral-400 hover:text-blue-500 disabled:opacity-50"
            >
              <RotateCw size={14} className={summary.loading ? "animate-spin" : ""} />
            </button>
          </div>
          {summary.loading && !summary.text ? (
            <div className="space-y-2" aria-busy="true">
              <div className="h-3 w-full animate-pulse rounded bg-neutral-200 dark:bg-neutral-700" />
              <div className="h-3 w-4/5 animate-pulse rounded bg-neutral-200 dark:bg-neutral-700" />
            </div>
          ) : summary.failed ? (
            <p className="text-sm text-neutral-400">{tr("today.summaryFailed")}</p>
          ) : (
            <p className="text-sm leading-relaxed">{summary.text}</p>
          )}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card title={tr("today.schedule")} onHeaderClick={() => goTo("calendar")}>
          {occs.length === 0 ? <Empty>{viewingToday ? tr("today.noEvents") : tr("today.noEventsDay")}</Empty> : occs.map((o, i) => (
            <button
              key={i}
              onClick={() => goTo("calendar", { eventId: o.event.id })}
              className="flex w-full items-center gap-2 rounded py-1.5 text-left hover:bg-neutral-50 dark:hover:bg-neutral-700/50"
            >
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: o.event.color ?? "#3b82f6" }} />
              <span className="w-24 shrink-0 truncate text-xs text-neutral-400">{o.event.all_day ? tr("event.allDay") : fmtTime(o.start)}</span>
              <span className="truncate">{o.event.summary}</span>
            </button>
          ))}
        </Card>

        <Card
          title={viewingToday ? tr("today.dueToday") : tr("today.dueOn", { date: fmtMonthDay(day) })}
          onHeaderClick={() => goTo("todos")}
        >
          {dueTodos.length === 0 && dueReminders.length === 0 ? <Empty>{tr("today.nothingDue")}</Empty> : (
            <>
              {dueReminders.map((r) => {
                const when = reminderWhen(r, day);
                return (
                  <div key={r.id} className="flex items-center gap-2 py-1">
                    <input type="checkbox" className="accent-blue-600" onChange={async () => { await toggleReminder(r.id, true); bump(); }} />
                    <Bell size={14} className="shrink-0 text-neutral-400" />
                    <span className="truncate">{r.title}</span>
                    {!r.rrule && when && isOverdue(when.toISOString()) && <span className="text-xs text-red-500">{tr("today.overdue")}</span>}
                  </div>
                );
              })}
              {dueTodos.map((t) => (
                <div key={t.id} className="flex items-center gap-2 py-1">
                  <input type="checkbox" className="accent-blue-600" onChange={async () => { await toggleTodo(t.id, true); bump(); }} />
                  <span className="truncate">{t.title}</span>
                  <PriorityFlag priority={t.priority} />
                  {isOverdue(t.due_at) && <span className="text-xs text-red-500">{tr("today.overdue")}</span>}
                </div>
              ))}
            </>
          )}
        </Card>

        <Card title={tr("today.pinnedNotes")} onHeaderClick={() => goTo("notes")}>
          {pinnedNotes.length === 0 ? <Empty>{tr("today.noPinned")}</Empty> : pinnedNotes.map((n) => (
            <button key={n.id} onClick={() => goTo("notes", { noteId: n.id })} className="flex w-full items-center gap-1.5 rounded py-1 text-left hover:bg-neutral-50 dark:hover:bg-neutral-700/50">
              <Pin size={13} className="shrink-0 text-blue-500" fill="currentColor" /> <span className="truncate">{n.title || tr("common.untitled")}</span>
            </button>
          ))}
        </Card>

        <Card title={tr("today.recentNotes")} onHeaderClick={() => goTo("notes")}>
          {recentNotes.length === 0 ? <Empty>{tr("today.noNotes")}</Empty> : recentNotes.map((n) => (
            <button key={n.id} onClick={() => goTo("notes", { noteId: n.id })} className="flex w-full items-center justify-between gap-2 rounded py-1 text-left hover:bg-neutral-50 dark:hover:bg-neutral-700/50">
              <span className="truncate">{n.title || tr("common.untitled")}</span>
              <span className="shrink-0 text-xs text-neutral-400">{fmtDateTime(n.updated_at)}</span>
            </button>
          ))}
        </Card>

        <Card title={tr("today.birthdays")}>
          {birthdays.length === 0 ? <Empty>{tr("today.noBirthdays")}</Empty> : birthdays.map((b) => (
            <div key={b.person.id} className="flex items-center gap-2 py-1">
              <Cake size={14} className="shrink-0 text-pink-500" />
              <span className="flex-1 truncate">{b.person.full_name || tr("people.newContact")}</span>
              <span className="shrink-0 text-xs text-neutral-400">{b.dateLabel}</span>
              <span className={`shrink-0 text-xs ${b.days === 0 ? "font-medium text-pink-500" : "text-neutral-400"}`}>{b.awayLabel}</span>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}

interface UpcomingBirthday { person: PersonRow; days: number; dateLabel: string; awayLabel: string }

/** People whose birthday (month/day, any year) falls within `within` days of
 * `from`, soonest first. Compares on month/day only, ignoring the stored year. */
function upcomingBirthdays(people: PersonRow[], within: number, from: Date): UpcomingBirthday[] {
  const today = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const out: UpcomingBirthday[] = [];
  for (const person of people) {
    if (!person.birthday) continue;
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(person.birthday.trim());
    if (!m) continue;
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    // A Feb 29 birthday on a non-leap year would otherwise roll over to Mar 1
    // (JS Date overflows the day-of-month). Cap to the last day of the month so
    // it lands on Feb 28 that year — the usual convention.
    const inYear = (year: number): Date => {
      const lastDay = new Date(year, month, 0).getDate(); // day 0 of next month
      return new Date(year, month - 1, Math.min(day, lastDay));
    };
    let next = inYear(today.getFullYear());
    if (next < today) next = inYear(today.getFullYear() + 1);
    const days = Math.round((next.getTime() - today.getTime()) / 86400000);
    if (days > within) continue;
    out.push({
      person,
      days,
      // Year is a placeholder — fmtMonthDay renders month/day only. 2000 (not
      // 1970) so a Feb 29 birthday still resolves to a real date.
      dateLabel: fmtMonthDay(new Date(2000, month - 1, day)),
      awayLabel: fmtRelativeDays(days),
    });
  }
  return out.sort((a, b) => a.days - b.days);
}

function Card({ title, children, onHeaderClick }: { title: string; children: React.ReactNode; onHeaderClick?: () => void }) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-700 dark:bg-neutral-800">
      {onHeaderClick ? (
        <button onClick={onHeaderClick} className="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-500 hover:text-blue-500">{title}</button>
      ) : (
        <div className="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-500">{title}</div>
      )}
      <div>{children}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-2 text-sm text-neutral-400">{children}</p>;
}
