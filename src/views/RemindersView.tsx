import { useEffect, useMemo, useState } from "react";
import { Bell, Trash2, Inbox, CalendarClock, Flag, CheckCircle2, LucideIcon } from "lucide-react";
import type { ReminderRow, TodoRow } from "../types";
import {
  listReminders, upsertReminder, toggleReminder, deleteReminder, listTodos, allLinkTargets,
} from "../db";
import { Button, Modal, PriorityFlag, PRIORITY_LABELS } from "../components/ui";
import { TagEditor, LinksPanel, PeoplePanel, LinkTarget } from "../components/ItemMeta";
import { fmtDateTime, isOverdue, toLocalInput, fromLocalInput } from "../lib/format";
import { describeRrule } from "../lib/recurrence";
import { ensureNotificationPermission } from "../lib/notifications";

const RRULE_PRESETS: { label: string; value: string | null }[] = [
  { label: "Does not repeat", value: null },
  { label: "Daily", value: "FREQ=DAILY" },
  { label: "Weekly", value: "FREQ=WEEKLY" },
  { label: "Monthly", value: "FREQ=MONTHLY" },
  { label: "Yearly", value: "FREQ=YEARLY" },
];

type Filter = "all" | "scheduled" | "flagged" | "completed";

const FILTERS: { id: Filter; label: string; icon: LucideIcon }[] = [
  { id: "all", label: "All", icon: Inbox },
  { id: "scheduled", label: "Scheduled", icon: CalendarClock },
  { id: "flagged", label: "Flagged", icon: Flag },
  { id: "completed", label: "Completed", icon: CheckCircle2 },
];

function matchesFilter(r: ReminderRow, f: Filter): boolean {
  switch (f) {
    case "scheduled": return !r.completed && !!(r.remind_at || r.due_at);
    case "flagged": return !r.completed && r.priority > 0;
    case "completed": return r.completed === 1;
    default: return !r.completed;
  }
}

export default function RemindersView({ onChange }: { onChange: () => void }) {
  const [reminders, setReminders] = useState<ReminderRow[]>([]);
  const [editing, setEditing] = useState<ReminderRow | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [notifOk, setNotifOk] = useState(true);

  const reload = async () => setReminders(await listReminders());
  useEffect(() => { void reload(); void ensureNotificationPermission().then(setNotifOk); }, []);
  const bump = () => { void reload(); onChange(); };

  async function add() {
    if (!newTitle.trim()) return;
    await upsertReminder({
      title: newTitle.trim(), notes: null, due_at: null, remind_at: null,
      rrule: null, priority: 0, completed: 0, completed_at: null, linked_todo_id: null,
    });
    setNewTitle("");
    bump();
  }

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: 0, scheduled: 0, flagged: 0, completed: 0 };
    for (const f of ["all", "scheduled", "flagged", "completed"] as Filter[]) {
      c[f] = reminders.filter((r) => matchesFilter(r, f)).length;
    }
    return c;
  }, [reminders]);

  const visible = reminders.filter((r) => matchesFilter(r, filter));

  return (
    <div className="flex h-full">
      {/* Filter sidebar (Apple Reminders-style smart lists) */}
      <aside className="w-48 shrink-0 border-r border-neutral-200 p-3 dark:border-neutral-700">
        <h3 className="mb-2 text-xs font-semibold uppercase text-neutral-400">Reminders</h3>
        {FILTERS.map((f) => {
          const Icon = f.icon;
          return (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-sm ${
                filter === f.id ? "bg-blue-100 dark:bg-blue-900/40" : "hover:bg-neutral-100 dark:hover:bg-neutral-700"
              }`}
            >
              <span className="flex items-center gap-2"><Icon size={16} className="text-neutral-500" /> {f.label}</span>
              <span className="text-xs text-neutral-400">{counts[f.id]}</span>
            </button>
          );
        })}
      </aside>

      {/* Reminder list */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-2xl">
          {!notifOk && (
            <div className="mb-3 rounded-lg bg-amber-100 px-3 py-2 text-sm text-amber-800">
              Notifications are disabled. Enable them in System Settings to get reminder alerts.
            </div>
          )}
          <div className="mb-4 flex gap-2">
            <input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
              placeholder="Add a reminder…"
              className="flex-1 rounded-lg border border-neutral-200 px-3 py-2 outline-none focus:border-blue-400 dark:border-neutral-600 dark:bg-neutral-800"
            />
            <Button variant="primary" onClick={add}>Add</Button>
          </div>

          <div className="space-y-1">
            {visible.map((r) => (
              <div key={r.id} className="group flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-neutral-100 dark:hover:bg-neutral-800">
                <input type="checkbox" checked={r.completed === 1} onChange={async (e) => { await toggleReminder(r.id, e.target.checked); bump(); }} className="h-4 w-4 accent-blue-600" />
                <button onClick={() => setEditing(r)} className={`flex-1 text-left ${r.completed ? "text-neutral-400 line-through" : ""}`}>
                  <div>{r.title}</div>
                  {(r.remind_at || r.due_at) && (
                    <div className={`flex items-center gap-1 text-xs ${isOverdue(r.remind_at || r.due_at) && !r.completed ? "text-red-500" : "text-neutral-400"}`}>
                      {r.remind_at ? <><Bell size={12} /> {fmtDateTime(r.remind_at)}</> : <>Due {fmtDateTime(r.due_at)}</>}
                      {r.rrule && ` · ${describeRrule(r.rrule)}`}
                    </div>
                  )}
                </button>
                <PriorityFlag priority={r.priority} />
                <button
                  onClick={async (e) => { e.stopPropagation(); if (confirm(`Delete reminder "${r.title}"?`)) { await deleteReminder(r.id); bump(); } }}
                  className="hidden text-neutral-400 hover:text-red-500 group-hover:block"
                  title="Delete reminder"
                ><Trash2 size={15} /></button>
              </div>
            ))}
            {visible.length === 0 && <p className="py-8 text-center text-sm text-neutral-400">No reminders here.</p>}
          </div>
        </div>
      </div>

      {editing && <ReminderDetail reminder={editing} onClose={() => setEditing(null)} onSaved={bump} />}
    </div>
  );
}

function ReminderDetail({ reminder, onClose, onSaved }: { reminder: ReminderRow; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(reminder.title);
  const [notes, setNotes] = useState(reminder.notes ?? "");
  const [due, setDue] = useState(reminder.due_at ? toLocalInput(new Date(reminder.due_at)) : "");
  const [remind, setRemind] = useState(reminder.remind_at ? toLocalInput(new Date(reminder.remind_at)) : "");
  const [priority, setPriority] = useState(reminder.priority);
  const [rrule, setRrule] = useState<string | null>(reminder.rrule);
  const [linkedTodo, setLinkedTodo] = useState(reminder.linked_todo_id ?? "");
  const [todos, setTodos] = useState<TodoRow[]>([]);
  const [targets, setTargets] = useState<LinkTarget[]>([]);

  useEffect(() => { void listTodos().then(setTodos); void allLinkTargets().then(setTargets); }, []);

  async function save() {
    await upsertReminder({
      id: reminder.id, title: title.trim() || "(untitled)", notes: notes || null,
      due_at: due ? fromLocalInput(due) : null,
      remind_at: remind ? fromLocalInput(remind) : null,
      rrule, priority, completed: reminder.completed, completed_at: reminder.completed_at,
      linked_todo_id: linkedTodo || null,
    });
    onSaved();
    onClose();
  }

  return (
    <Modal
      open onClose={onClose} title="Reminder"
      footer={
        <>
          <Button variant="danger" onClick={async () => { await deleteReminder(reminder.id); onSaved(); onClose(); }}>Delete</Button>
          <Button variant="primary" onClick={save}>Save</Button>
        </>
      }
    >
      <div className="space-y-3">
        <input value={title} onChange={(e) => setTitle(e.target.value)} className="w-full rounded-lg border border-neutral-200 px-3 py-2 dark:border-neutral-600 dark:bg-neutral-700" />
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes…" rows={2} className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm dark:border-neutral-600 dark:bg-neutral-700" />
        <div className="grid grid-cols-2 gap-3">
          <label className="text-sm">
            <span className="mb-1 block text-xs text-neutral-500">Due</span>
            <input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} className="w-full rounded border border-neutral-200 px-2 py-1.5 dark:border-neutral-600 dark:bg-neutral-700" />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-neutral-500">Alert at</span>
            <input type="datetime-local" value={remind} onChange={(e) => setRemind(e.target.value)} className="w-full rounded border border-neutral-200 px-2 py-1.5 dark:border-neutral-600 dark:bg-neutral-700" />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-sm">
            <span className="mb-1 block text-xs text-neutral-500">Priority</span>
            <select value={priority} onChange={(e) => setPriority(Number(e.target.value))} className="w-full rounded border border-neutral-200 px-2 py-1.5 dark:border-neutral-600 dark:bg-neutral-700">
              {PRIORITY_LABELS.map((l, i) => <option key={i} value={i}>{l}</option>)}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-neutral-500">Repeat</span>
            <select value={rrule ?? "__none__"} onChange={(e) => setRrule(e.target.value === "__none__" ? null : e.target.value)} className="w-full rounded border border-neutral-200 px-2 py-1.5 dark:border-neutral-600 dark:bg-neutral-700">
              {RRULE_PRESETS.map((p) => <option key={p.label} value={p.value ?? "__none__"}>{p.label}</option>)}
            </select>
          </label>
        </div>
        <label className="block text-sm">
          <span className="mb-1 block text-xs text-neutral-500">Linked to-do</span>
          <select value={linkedTodo} onChange={(e) => setLinkedTodo(e.target.value)} className="w-full rounded border border-neutral-200 px-2 py-1.5 dark:border-neutral-600 dark:bg-neutral-700">
            <option value="">None</option>
            {todos.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
          </select>
        </label>

        <hr className="border-neutral-200 dark:border-neutral-700" />
        <TagEditor type="reminder" id={reminder.id} />
        <PeoplePanel type="reminder" id={reminder.id} />
        <LinksPanel type="reminder" id={reminder.id} targets={targets} />
      </div>
    </Modal>
  );
}
