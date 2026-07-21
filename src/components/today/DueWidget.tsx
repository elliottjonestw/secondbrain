import { useTranslation } from "react-i18next";
import { Bell } from "lucide-react";
import { CardShell, CardEmpty } from "./CardShell";
import { useAsync } from "./useAsync";
import { loadTodos, loadReminders } from "./dayData";
import { reminderWhen, dueTodosFor, dueRemindersFor } from "./derive";
import type { TodayWidget, TodayWidgetProps } from "./types";
import { toggleTodo, toggleReminder } from "../../db";
import { isOverdue, fmtMonthDay } from "../../lib/format";
import { PriorityFlag } from "../ui";

function Due({ day, viewingToday, revision, onChange, goTo }: TodayWidgetProps) {
  const { t: tr } = useTranslation();
  const todos = useAsync(() => loadTodos(revision), [revision]);
  const reminders = useAsync(() => loadReminders(revision), [revision]);

  const dueTodos = dueTodosFor(todos.data ?? [], day, viewingToday);
  const dueReminders = dueRemindersFor(reminders.data ?? [], day, viewingToday);
  // Only a skeleton before the first result — ticking something off reloads
  // both lists, and blanking the card mid-click would be its own bug.
  const first = (todos.loading && !todos.data) || (reminders.loading && !reminders.data);

  return (
    <CardShell
      title={viewingToday ? tr("today.dueToday") : tr("today.dueOn", { date: fmtMonthDay(day) })}
      onHeaderClick={() => goTo("todos")}
      loading={first}
      error={todos.error ?? reminders.error}
    >
      {dueTodos.length === 0 && dueReminders.length === 0 ? (
        <CardEmpty>{tr("today.nothingDue")}</CardEmpty>
      ) : (
        <>
          {dueReminders.map((r) => {
            const when = reminderWhen(r, day);
            return (
              <div key={r.id} className="flex items-center gap-2 py-1">
                <input
                  type="checkbox"
                  className="accent-blue-600"
                  onChange={async () => { await toggleReminder(r.id, true); onChange(); }}
                />
                <Bell size={14} className="shrink-0 text-neutral-400" />
                <span className="truncate">{r.title}</span>
                {!r.rrule && when && isOverdue(when.toISOString()) && (
                  <span className="text-xs text-red-500">{tr("today.overdue")}</span>
                )}
              </div>
            );
          })}
          {dueTodos.map((t) => (
            <div key={t.id} className="flex items-center gap-2 py-1">
              <input
                type="checkbox"
                className="accent-blue-600"
                onChange={async () => { await toggleTodo(t.id, true); onChange(); }}
              />
              <span className="truncate">{t.title}</span>
              <PriorityFlag priority={t.priority} />
              {isOverdue(t.due_at) && <span className="text-xs text-red-500">{tr("today.overdue")}</span>}
            </div>
          ))}
        </>
      )}
    </CardShell>
  );
}

export const dueWidget: TodayWidget = {
  id: "due",
  labelKey: "today.dueToday",
  Component: Due,
};
