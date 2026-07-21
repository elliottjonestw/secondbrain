import { useEffect, useState } from "react";
import { Bell, Pin, Cake } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { EventOccurrence, TodoRow, ReminderRow, NoteRow, PersonRow, GoTo } from "../types";
import { listTodos, listReminders, listNotes, listPeople, toggleTodo, toggleReminder } from "../db";
import { getOccurrences } from "../lib/calendars";
import {
  startOfDay, endOfDay, fmtTime, fmtDateTime, fmtMonthDay, fmtFullDate,
  fmtRelativeDays, isOverdue, isToday,
} from "../lib/format";
import { nextOccurrenceFrom } from "../lib/recurrence";
import { PriorityFlag } from "../components/ui";

/**
 * Effective due time for a reminder: the current occurrence for a recurring
 * series (from start of today), or the stored base otherwise. Mirrors ItemCard
 * so a daily 8am reminder shows today's 8am, not the day it was created.
 * Returns null if the reminder has no time at all.
 */
function reminderWhen(r: ReminderRow): Date | null {
  const base = r.remind_at || r.due_at;
  if (!base) return null;
  if (r.rrule) return nextOccurrenceFrom(base, r.rrule, startOfDay(new Date()));
  return new Date(base);
}

export default function TodayView({ onChange, goTo }: { onChange: () => void; goTo: GoTo }) {
  const { t: tr } = useTranslation();
  const [occs, setOccs] = useState<EventOccurrence[]>([]);
  const [todos, setTodos] = useState<TodoRow[]>([]);
  const [reminders, setReminders] = useState<ReminderRow[]>([]);
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [people, setPeople] = useState<PersonRow[]>([]);

  const reload = async () => {
    // Pulls the built-in calendar plus any visible connected ones; a calendar
    // that can't be reached is skipped rather than breaking the whole card.
    const { occurrences } = await getOccurrences(startOfDay(new Date()), endOfDay(new Date()));
    setOccs(occurrences);
    setTodos(await listTodos());
    setReminders(await listReminders());
    setNotes(await listNotes());
    setPeople(await listPeople());
  };
  useEffect(() => { void reload(); }, []);
  const bump = () => { void reload(); onChange(); };

  const dueTodos = todos.filter(
    (t) => !t.completed && t.due_at && (isToday(new Date(t.due_at)) || isOverdue(t.due_at)),
  );
  const dueReminders = reminders.filter((r) => {
    if (r.completed) return false;
    const when = reminderWhen(r);
    if (!when) return false;
    // Recurring reminders recur by design — never treat them as overdue. They
    // show when their current occurrence is today; a one-off past reminder shows
    // because it's genuinely overdue. Matches ItemCard's reminder branch.
    if (r.rrule) return isToday(when);
    return isToday(when) || isOverdue(when.toISOString());
  });
  const pinnedNotes = notes.filter((n) => n.pinned).slice(0, 5);
  const recentNotes = notes.filter((n) => !n.pinned).slice(0, 5);
  const birthdays = upcomingBirthdays(people, 30);

  return (
    <div className="mx-auto h-full max-w-4xl overflow-y-auto p-6">
      <div className="mb-4">
        <h1 className="text-2xl font-bold">{tr("nav.today")}</h1>
        <p className="text-sm text-neutral-400">{fmtFullDate(new Date())}</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title={tr("today.schedule")} onHeaderClick={() => goTo("calendar")}>
          {occs.length === 0 ? <Empty>{tr("today.noEvents")}</Empty> : occs.map((o, i) => (
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

        <Card title={tr("today.dueToday")} onHeaderClick={() => goTo("todos")}>
          {dueTodos.length === 0 && dueReminders.length === 0 ? <Empty>{tr("today.nothingDue")}</Empty> : (
            <>
              {dueReminders.map((r) => {
                const when = reminderWhen(r);
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

/** People whose birthday (month/day, any year) falls within the next `within`
 * days, soonest first. Compares on month/day only, ignoring the stored year. */
function upcomingBirthdays(people: PersonRow[], within: number): UpcomingBirthday[] {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
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
