import { useEffect, useState } from "react";
import { Upload, Download, Bell, Pin } from "lucide-react";
import type { EventOccurrence, TodoRow, ReminderRow, NoteRow } from "../types";
import { listEvents, listTodos, listReminders, listNotes, toggleTodo, toggleReminder } from "../db";
import { expandEvents } from "../lib/recurrence";
import { startOfDay, endOfDay, fmtTime, fmtDateTime, isOverdue, isToday } from "../lib/format";
import { exportCalendar, importCalendar } from "../lib/ics";
import { Button, PriorityFlag } from "../components/ui";

export default function TodayView({ onChange, goTo }: { onChange: () => void; goTo: (v: string) => void }) {
  const [occs, setOccs] = useState<EventOccurrence[]>([]);
  const [todos, setTodos] = useState<TodoRow[]>([]);
  const [reminders, setReminders] = useState<ReminderRow[]>([]);
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [msg, setMsg] = useState("");

  const reload = async () => {
    const events = await listEvents();
    setOccs(expandEvents(events, startOfDay(new Date()), endOfDay(new Date())));
    setTodos(await listTodos());
    setReminders(await listReminders());
    setNotes(await listNotes());
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

  async function doExport() {
    const path = await exportCalendar();
    setMsg(path ? `Exported to ${path}` : "");
  }
  async function doImport() {
    const n = await importCalendar();
    setMsg(`Imported ${n} event(s).`);
    bump();
  }

  return (
    <div className="mx-auto h-full max-w-4xl overflow-y-auto p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Today</h1>
          <p className="text-sm text-neutral-400">{new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</p>
        </div>
        <div className="flex gap-2">
          <Button onClick={doImport}><span className="flex items-center gap-1.5"><Upload size={15} /> Import .ics</span></Button>
          <Button onClick={doExport}><span className="flex items-center gap-1.5"><Download size={15} /> Export .ics</span></Button>
        </div>
      </div>
      {msg && <div className="mb-4 rounded-lg bg-green-100 px-3 py-2 text-sm text-green-800">{msg}</div>}

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Schedule" onHeaderClick={() => goTo("calendar")}>
          {occs.length === 0 ? <Empty>No events today.</Empty> : occs.map((o, i) => (
            <div key={i} className="flex items-center gap-2 py-1.5">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: o.event.color ?? "#3b82f6" }} />
              <span className="w-20 text-xs text-neutral-400">{o.event.all_day ? "All day" : fmtTime(o.start)}</span>
              <span className="truncate">{o.event.summary}</span>
            </div>
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
            <div key={n.id} className="flex items-center gap-1.5 truncate py-1"><Pin size={13} className="shrink-0 text-blue-500" fill="currentColor" /> <span className="truncate">{n.title || "Untitled"}</span></div>
          ))}
        </Card>

        <Card title="Recent notes" onHeaderClick={() => goTo("notes")}>
          {recentNotes.length === 0 ? <Empty>No notes yet.</Empty> : recentNotes.map((n) => (
            <div key={n.id} className="flex items-center justify-between py-1">
              <span className="truncate">{n.title || "Untitled"}</span>
              <span className="ml-2 shrink-0 text-xs text-neutral-400">{fmtDateTime(n.updated_at)}</span>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}

function Card({ title, children, onHeaderClick }: { title: string; children: React.ReactNode; onHeaderClick?: () => void }) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-700 dark:bg-neutral-800">
      <button onClick={onHeaderClick} className="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-500 hover:text-blue-500">{title}</button>
      <div>{children}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-2 text-sm text-neutral-400">{children}</p>;
}
