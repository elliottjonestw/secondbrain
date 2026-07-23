import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, X, Trash2, CalendarPlus, ChevronUp, ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TodoRow, ListRow } from "../types";
import {
  listTodos, listLists, upsertTodo, toggleTodo, deleteTodo,
  upsertList, deleteList, reorderTodos, upsertEvent, allLinkTargets,
} from "../db";
import { Button, Modal, PriorityFlag, priorityKey, CATEGORY_COLORS } from "../components/ui";
import { TagEditor, LinksPanel, PeoplePanel, LinkTarget } from "../components/ItemMeta";
import { fmtDateTime, isOverdue, toLocalInput, fromLocalInput } from "../lib/format";
import { OfflineError, ApiError } from "../lib/api";
import { useFirstLoad, firstLoadScreen, SlowLoad } from "../components/ViewGate";

export default function TodosView({ onChange, initialId }: { onChange: () => void; initialId?: string }) {
  const { t: tr } = useTranslation();
  const [todos, setTodos] = useState<TodoRow[]>([]);
  const [lists, setLists] = useState<ListRow[]>([]);
  const [activeList, setActiveList] = useState<string>("");
  const [editing, setEditing] = useState<TodoRow | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [addingList, setAddingList] = useState(false);
  const [newListName, setNewListName] = useState("");
  // A single banner for any write that couldn't reach the server. Todos and
  // lists are remote now (M2), so a mutation can fail where a local SQLite
  // write never could — offline above all. Reads fall back to the cache
  // silently; writes must say so, because a save that looked like it worked and
  // didn't is the failure that destroys trust.
  const [mutError, setMutError] = useState<string | null>(null);

  /** Turn a caught error into a user-facing sentence. */
  const explain = (e: unknown): string =>
    e instanceof OfflineError ? tr("todos.offlineSave")
      : e instanceof ApiError ? e.message
      : tr("todos.saveFailed");

  /** Run a write, then reload; on failure show the banner instead of throwing. */
  const mutate = async (fn: () => Promise<void>) => {
    setMutError(null);
    try {
      await fn();
      bump();
    } catch (e) {
      setMutError(explain(e));
    }
  };

  const reload = async () => {
    setTodos(await listTodos());
    const ls = await listLists();
    setLists(ls);
    // Keep a valid active list selected (first one by default).
    setActiveList((cur) => (ls.some((l) => l.id === cur) ? cur : ls[0]?.id ?? ""));
  };
  // The first load blocks the page rather than showing an empty list that
  // reads as "you have no to-dos"; it throws on failure so the gate can offer
  // a retry. Later reloads keep the current list on screen and report failure
  // through the banner instead.
  const gate = useFirstLoad(reload, []);
  const softReload = () => { void reload().catch((e) => setMutError(explain(e))); };

  // Open a specific to-do when navigated here with a target (e.g. from an
  // assistant card), switching to its list so it's also visible behind the
  // detail. Only fires once, so closing the detail doesn't re-open it.
  const opened = useRef(false);
  // True while addList() is mid-flight, so the onBlur handler (which also calls
  // addList) doesn't double-fire when an Enter-triggered alert() steals focus.
  const addingListRef = useRef(false);
  useEffect(() => {
    if (opened.current || !initialId || todos.length === 0) return;
    const match = todos.find((td) => td.id === initialId);
    if (match) {
      opened.current = true;
      if (match.list_id) setActiveList(match.list_id);
      setEditing(match);
    }
  }, [todos, initialId]);

  const bump = () => { softReload(); onChange(); };

  const topLevel = useMemo(
    // Incomplete tasks always sort above completed ones; position order is
    // preserved within each group (Array.prototype.sort is stable).
    () => todos
      .filter((t) => !t.parent_todo_id && t.list_id === activeList)
      .sort((a, b) => a.completed - b.completed),
    [todos, activeList],
  );
  const subtasksOf = (id: string) =>
    todos.filter((t) => t.parent_todo_id === id).sort((a, b) => a.completed - b.completed);

  async function addTodo() {
    const title = newTitle.trim();
    if (!title) return;
    setMutError(null);
    try {
      // Todos are list-scoped and there is no "unfiled" bucket, so a task needs
      // a real list. Registration seeds one, but "clear all data" empties the
      // lists table too — leaving activeList "", which the server rejects as an
      // invalid uuid (not null). Recreate a default list on demand so the first
      // task after a wipe lands somewhere instead of failing with a 400.
      let listId = activeList;
      if (!listId) {
        listId = await upsertList({ name: tr("todos.defaultListName"), color: CATEGORY_COLORS[0] });
        setActiveList(listId);
      }
      await upsertTodo({
        title, notes: null, list_id: listId, due_at: null, priority: 0,
        completed: 0, completed_at: null, parent_todo_id: null,
        position: topLevel.length,
      });
      setNewTitle("");
      bump();
    } catch (e) {
      // Keep the typed title so an offline user doesn't lose it.
      setMutError(explain(e));
    }
  }

  async function addList() {
    const name = newListName.trim();
    if (!name) { setAddingList(false); return; }
    // Guard against the blur handler firing again while the modal alert() is
    // up: Enter → addList → alert steals focus → onBlur → addList again would
    // otherwise pop the duplicate-name alert twice.
    if (addingListRef.current) return;
    addingListRef.current = true;
    const color = CATEGORY_COLORS[lists.length % CATEGORY_COLORS.length];
    let id: string;
    try {
      id = await upsertList({ name, color });
    } catch (err) {
      // A duplicate name (409) keeps the input open so the user can rename
      // rather than lose what they typed. Offline / other failures fall through
      // to the same alert with the server's message.
      alert(err instanceof ApiError && err.code === "conflict"
        ? tr("todos.listAlreadyExists", { name })
        : err instanceof OfflineError ? tr("todos.offlineSave")
        : err instanceof Error ? err.message : String(err));
      // Release the guard only AFTER the alert has been dismissed, and one task
      // later: alert() steals focus from the input, and that blur — whether it
      // lands synchronously during the modal or as a queued task once it closes
      // — re-enters addList. Clearing the ref before the alert (or right after
      // it, synchronously) leaves that second call unguarded and pops the same
      // alert twice. Measured in `npm run dev`, not theorised.
      window.setTimeout(() => { addingListRef.current = false; }, 0);
      return;
    }
    addingListRef.current = false;
    setNewListName("");
    setAddingList(false);
    await reload().catch((e) => setMutError(explain(e)));
    setActiveList(id);
    onChange();
  }

  /**
   * Reorder within the top level of the active list.
   *
   * Buttons, not drag: HTML5 drag doesn't work in WKWebView (see CLAUDE.md), so
   * the grip this used to have moved nothing. Arrows also work from a keyboard.
   */
  async function moveTodo(index: number, delta: number) {
    const ids = topLevel.map((t) => t.id);
    const to = index + delta;
    if (to < 0 || to >= ids.length) return;
    ids.splice(to, 0, ids.splice(index, 1)[0]);
    await mutate(() => reorderTodos(ids));
  }

  const blocked = firstLoadScreen(gate);
  if (blocked) return blocked;

  return (
    <div className="flex h-full">
      <SlowLoad state={gate} />
      {/* Lists sidebar */}
      <aside className="w-48 shrink-0 border-r border-neutral-200 p-3 dark:border-neutral-700">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase text-neutral-400">{tr("todos.lists")}</h3>
          <button onClick={() => setAddingList(true)} className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-blue-500 dark:hover:bg-neutral-700" title={tr("todos.newList")}>
            <Plus size={16} />
          </button>
        </div>
        {lists.map((l) => (
          <div
            key={l.id}
            className={`group flex cursor-pointer items-center justify-between rounded px-2 py-1 text-sm ${
              activeList === l.id ? "bg-blue-100 dark:bg-blue-900/40" : "hover:bg-neutral-100 dark:hover:bg-neutral-700"
            }`}
            onClick={() => setActiveList(l.id)}
          >
            <span className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: l.color ?? "#999" }} />
              {l.name}
            </span>
            {lists.length > 1 && (
              <button
                onClick={(e) => { e.stopPropagation(); if (confirm(tr("todos.confirmDeleteList", { name: l.name }))) void mutate(() => deleteList(l.id)); }}
                className="hidden text-neutral-400 hover:text-red-500 group-hover:block"
                title={tr("todos.deleteList")}
              ><X size={14} /></button>
            )}
          </div>
        ))}
        {addingList && (
          <input
            autoFocus
            value={newListName}
            onChange={(e) => setNewListName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void addList(); if (e.key === "Escape") { setAddingList(false); setNewListName(""); } }}
            onBlur={() => void addList()}
            placeholder={tr("todos.listNamePlaceholder")}
            className="mt-1 w-full rounded border border-neutral-200 px-2 py-1 text-sm outline-none focus:border-blue-400 dark:border-neutral-600 dark:bg-neutral-700"
          />
        )}
      </aside>

      {/* Tasks */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-2xl">
          {mutError && (
            <div role="alert" className="mb-3 flex items-center justify-between gap-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
              <span>{mutError}</span>
              <button onClick={() => setMutError(null)} className="shrink-0 text-amber-600 hover:text-amber-800 dark:hover:text-amber-200" title={tr("common.close")}>
                <X size={14} />
              </button>
            </div>
          )}
          <div className="mb-4 flex gap-2">
            <input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addTodo()}
              placeholder={tr("todos.addTaskPlaceholder")}
              className="flex-1 rounded-lg border border-neutral-200 px-3 py-2 outline-none focus:border-blue-400 dark:border-neutral-600 dark:bg-neutral-800"
            />
            <Button variant="primary" onClick={addTodo}>{tr("common.add")}</Button>
          </div>

          <div className="space-y-1">
            {topLevel.map((t, i) => (
              <div key={t.id}>
                <TodoItem
                  todo={t}
                  onToggle={(c) => mutate(() => toggleTodo(t.id, c))}
                  onOpen={() => setEditing(t)}
                  onDelete={() => { if (confirm(tr("todos.confirmDeleteTask", { title: t.title }))) void mutate(() => deleteTodo(t.id)); }}
                  onMoveUp={i === 0 ? undefined : () => void moveTodo(i, -1)}
                  onMoveDown={i === topLevel.length - 1 ? undefined : () => void moveTodo(i, 1)}
                />
                {/* subtasks */}
                <div className="ml-7 space-y-1">
                  {subtasksOf(t.id).map((s) => (
                    <TodoItem
                      key={s.id}
                      todo={s}
                      small
                      onToggle={(c) => mutate(() => toggleTodo(s.id, c))}
                      onOpen={() => setEditing(s)}
                      onDelete={() => { if (confirm(tr("todos.confirmDeleteSubtask", { title: s.title }))) void mutate(() => deleteTodo(s.id)); }}
                    />
                  ))}
                </div>
              </div>
            ))}
            {topLevel.length === 0 && (
              <p className="py-8 text-center text-sm text-neutral-400">{tr("todos.empty")}</p>
            )}
          </div>
        </div>
      </div>

      {editing && (
        <TodoDetail
          todo={editing}
          lists={lists}
          onClose={() => setEditing(null)}
          onSaved={bump}
        />
      )}
    </div>
  );
}

function TodoItem({
  todo, onToggle, onOpen, onDelete, small, onMoveUp, onMoveDown,
}: {
  todo: TodoRow;
  onToggle: (c: boolean) => void;
  onOpen: () => void;
  onDelete: () => void;
  small?: boolean;
  /** Undefined at the ends of the list, and on subtasks (which don't reorder). */
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}) {
  const { t } = useTranslation();
  const reorderable = !!(onMoveUp || onMoveDown);
  return (
    <div
      className={`group flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-neutral-100 dark:hover:bg-neutral-800 ${small ? "text-sm" : ""}`}
    >
      <input
        type="checkbox"
        checked={todo.completed === 1}
        onChange={(e) => onToggle(e.target.checked)}
        className="h-4 w-4 shrink-0 accent-blue-600"
      />
      <button onClick={onOpen} className={`flex-1 truncate text-left ${todo.completed ? "text-neutral-400 line-through" : ""}`}>
        {todo.title}
      </button>
      <PriorityFlag priority={todo.priority} />
      {todo.due_at && (
        <span className={`text-xs ${isOverdue(todo.due_at) && !todo.completed ? "text-red-500" : "text-neutral-400"}`}>
          {fmtDateTime(todo.due_at)}
        </span>
      )}
      {reorderable && (
        <span className="hidden items-center group-hover:flex">
          <button
            onClick={(e) => { e.stopPropagation(); onMoveUp?.(); }}
            disabled={!onMoveUp}
            className="text-neutral-400 hover:text-blue-500 disabled:opacity-30 disabled:hover:text-neutral-400"
            title={t("common.moveUp")}
            aria-label={t("common.moveUp")}
          ><ChevronUp size={15} /></button>
          <button
            onClick={(e) => { e.stopPropagation(); onMoveDown?.(); }}
            disabled={!onMoveDown}
            className="text-neutral-400 hover:text-blue-500 disabled:opacity-30 disabled:hover:text-neutral-400"
            title={t("common.moveDown")}
            aria-label={t("common.moveDown")}
          ><ChevronDown size={15} /></button>
        </span>
      )}
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className="hidden text-neutral-400 hover:text-red-500 group-hover:block"
        title={t("todos.deleteTask")}
      ><Trash2 size={15} /></button>
    </div>
  );
}

function TodoDetail({
  todo, lists, onClose, onSaved,
}: {
  todo: TodoRow;
  lists: ListRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(todo.title);
  const [notes, setNotes] = useState(todo.notes ?? "");
  const [listId, setListId] = useState(todo.list_id ?? lists[0]?.id ?? "");
  const [due, setDue] = useState(todo.due_at ? toLocalInput(new Date(todo.due_at)) : "");
  const [priority, setPriority] = useState(todo.priority);
  const [subtaskTitle, setSubtaskTitle] = useState("");
  const [targets, setTargets] = useState<LinkTarget[]>([]);

  useEffect(() => { void allLinkTargets().then(setTargets); }, []);

  async function save() {
    await upsertTodo({
      id: todo.id, title: title.trim() || t("common.untitledParen"), notes: notes || null,
      list_id: listId, due_at: due ? fromLocalInput(due) : null, priority,
      completed: todo.completed, completed_at: todo.completed_at,
      parent_todo_id: todo.parent_todo_id, position: todo.position,
    });
    onSaved();
    onClose();
  }

  async function addSubtask() {
    if (!subtaskTitle.trim()) return;
    await upsertTodo({
      title: subtaskTitle.trim(), notes: null, list_id: listId, due_at: null,
      priority: 0, completed: 0, completed_at: null, parent_todo_id: todo.id, position: 0,
    });
    setSubtaskTitle("");
    onSaved();
  }

  async function convertToEvent() {
    const start = due ? new Date(due) : new Date();
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    await upsertEvent({
      summary: title.trim() || t("common.untitledParen"), description: notes || null, location: null,
      dtstart: start.toISOString(), dtend: end.toISOString(), all_day: 0,
      rrule: null, exdates: null, status: "CONFIRMED",
      categories: JSON.stringify(["Task"]), color: "#10b981",
    });
    onSaved();
    onClose();
    alert(t("todos.convertedToEvent"));
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t("todos.taskTitle")}
      footer={
        <>
          <Button variant="danger" onClick={async () => { await deleteTodo(todo.id); onSaved(); onClose(); }}>{t("common.delete")}</Button>
          <Button variant="ghost" onClick={convertToEvent}><span className="flex items-center gap-1.5"><CalendarPlus size={15} /> {t("todos.convertToEvent")}</span></Button>
          <Button variant="primary" onClick={save}>{t("common.save")}</Button>
        </>
      }
    >
      <div className="space-y-3">
        <input value={title} onChange={(e) => setTitle(e.target.value)} className="w-full rounded-lg border border-neutral-200 px-3 py-2 dark:border-neutral-600 dark:bg-neutral-700" />
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t("todos.notesPlaceholder")} rows={3} className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm dark:border-neutral-600 dark:bg-neutral-700" />
        <div className="grid grid-cols-2 gap-3">
          <label className="text-sm">
            <span className="mb-1 block text-xs text-neutral-500">{t("todos.list")}</span>
            <select value={listId} onChange={(e) => setListId(e.target.value)} className="w-full rounded border border-neutral-200 px-2 py-1.5 dark:border-neutral-600 dark:bg-neutral-700">
              {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-neutral-500">{t("todos.priority")}</span>
            <select value={priority} onChange={(e) => setPriority(Number(e.target.value))} className="w-full rounded border border-neutral-200 px-2 py-1.5 dark:border-neutral-600 dark:bg-neutral-700">
              {[0, 1, 2, 3].map((i) => <option key={i} value={i}>{t(priorityKey(i))}</option>)}
            </select>
          </label>
        </div>
        <label className="block text-sm">
          <span className="mb-1 block text-xs text-neutral-500">{t("todos.dueDate")}</span>
          <input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} className="w-full rounded border border-neutral-200 px-2 py-1.5 dark:border-neutral-600 dark:bg-neutral-700" />
        </label>

        {!todo.parent_todo_id && (
          <div>
            <span className="mb-1 block text-xs text-neutral-500">{t("todos.subtasks")}</span>
            <div className="flex gap-2">
              <input value={subtaskTitle} onChange={(e) => setSubtaskTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addSubtask()} placeholder={t("todos.addSubtask")} className="flex-1 rounded border border-neutral-200 px-2 py-1 text-sm dark:border-neutral-600 dark:bg-neutral-700" />
              <Button onClick={addSubtask}>{t("common.add")}</Button>
            </div>
          </div>
        )}

        <hr className="border-neutral-200 dark:border-neutral-700" />
        <TagEditor type="todo" id={todo.id} />
        <PeoplePanel type="todo" id={todo.id} />
        <LinksPanel type="todo" id={todo.id} targets={targets} />
      </div>
    </Modal>
  );
}
