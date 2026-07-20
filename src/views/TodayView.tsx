import { useEffect, useState } from "react";
import { Bell, Pin, Cake } from "lucide-react";
import type { EventOccurrence, TodoRow, ReminderRow, NoteRow, PersonRow } from "../types";
import { listTodos, listReminders, listNotes, listPeople, toggleTodo, toggleReminder } from "../db";
import { getOccurrences } from "../lib/calendars";
import { startOfDay, endOfDay, format, fmtTime, fmtDateTime, isOverdue, isToday } from "../lib/format";
import { PriorityFlag } from "../components/ui";

type GoTo = (v: string, target?: { noteId?: string; eventId?: string }) => void;

export default function TodayView({ onChange, goTo }: { onChange: () => void; goTo: GoTo }) {
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
  const dueReminders = reminders.filter(
    (r) => !r.completed && (r.remind_at || r.due_at) &&
      (isToday(new Date(r.remind_at || r.due_at!)) || isOverdue(r.remind_at || r.due_at)),
  );
  const pinnedNotes = notes.filter((n) => n.pinned).slice(0, 5);
  const recentNotes = notes.filter((n) => !n.pinned).slice(0, 5);
  const birthdays = upcomingBirthdays(people, 30);

  return (
    <div className="mx-auto h-full max-w-4xl overflow-y-auto p-6">
      <div className="mb-4">
        <h1 className="text-2xl font-bold">Today</h1>
        <p className="text-sm text-neutral-400">{new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Schedule" onHeaderClick={() => goTo("calendar")}>
          {occs.length === 0 ? <Empty>No events today.</Empty> : occs.map((o, i) => (
            <button
              key={i}
              onClick={() => goTo("calendar", { eventId: o.event.id })}
              className="flex w-full items-center gap-2 rounded py-1.5 text-left hover:bg-neutral-50 dark:hover:bg-neutral-700/50"
            >
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: o.event.color ?? "#3b82f6" }} />
              <span className="w-20 shrink-0 text-xs text-neutral-400">{o.event.all_day ? "All day" : fmtTime(o.start)}</span>
              <span className="truncate">{o.event.summary}</span>
            </button>
          ))}
        </Card>

        <Card title="Due today & overdue" onHeaderClick={() => goTo("todos")}>
          {dueTodos.length === 0 && dueReminders.length === 0 ? <Empty>Nothing due.</Empty> : (
            <>
              {dueReminders.map((r) => (
                <div key={r.id} className="flex items-center gap-2 py-1">
                  <input type="checkbox" className="accent-blue-600" onChange={async () => { await toggleReminder(r.id, true); bump(); }} />
                  <Bell size={14} className="shrink-0 text-neutral-400" />
                  <span className="truncate">{r.title}</span>
                  {isOverdue(r.remind_at || r.due_at) && <span className="text-xs text-red-500">overdue</span>}
                </div>
              ))}
              {dueTodos.map((t) => (
                <div key={t.id} className="flex items-center gap-2 py-1">
                  <input type="checkbox" className="accent-blue-600" onChange={async () => { await toggleTodo(t.id, true); bump(); }} />
                  <span className="truncate">{t.title}</span>
                  <PriorityFlag priority={t.priority} />
                  {isOverdue(t.due_at) && <span className="text-xs text-red-500">overdue</span>}
                </div>
              ))}
            </>
          )}
        </Card>

        <Card title="Pinned notes" onHeaderClick={() => goTo("notes")}>
          {pinnedNotes.length === 0 ? <Empty>No pinned notes.</Empty> : pinnedNotes.map((n) => (
            <button key={n.id} onClick={() => goTo("notes", { noteId: n.id })} className="flex w-full items-center gap-1.5 rounded py-1 text-left hover:bg-neutral-50 dark:hover:bg-neutral-700/50">
              <Pin size={13} className="shrink-0 text-blue-500" fill="currentColor" /> <span className="truncate">{n.title || "Untitled"}</span>
            </button>
          ))}
        </Card>

        <Card title="Recent notes" onHeaderClick={() => goTo("notes")}>
          {recentNotes.length === 0 ? <Empty>No notes yet.</Empty> : recentNotes.map((n) => (
            <button key={n.id} onClick={() => goTo("notes", { noteId: n.id })} className="flex w-full items-center justify-between gap-2 rounded py-1 text-left hover:bg-neutral-50 dark:hover:bg-neutral-700/50">
              <span className="truncate">{n.title || "Untitled"}</span>
              <span className="shrink-0 text-xs text-neutral-400">{fmtDateTime(n.updated_at)}</span>
            </button>
          ))}
        </Card>

        <Card title="Upcoming birthdays">
          {birthdays.length === 0 ? <Empty>No birthdays in the next 30 days.</Empty> : birthdays.map((b) => (
            <div key={b.person.id} className="flex items-center gap-2 py-1">
              <Cake size={14} className="shrink-0 text-pink-500" />
              <span className="flex-1 truncate">{b.person.full_name || "New contact"}</span>
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
    let next = new Date(today.getFullYear(), month - 1, day);
    if (next < today) next = new Date(today.getFullYear() + 1, month - 1, day);
    const days = Math.round((next.getTime() - today.getTime()) / 86400000);
    if (days > within) continue;
    out.push({
      person,
      days,
      dateLabel: format(new Date(2000, month - 1, day), "MMM d"),
      awayLabel: days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`,
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
