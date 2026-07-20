import { useEffect, useMemo, useState } from "react";
import { Plus, X, Trash2, CalendarPlus } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TodoRow, ListRow } from "../types";
import {
  listTodos, listLists, upsertTodo, toggleTodo, deleteTodo,
  upsertList, deleteList, reorderTodos, upsertEvent, allLinkTargets,
} from "../db";
import { Button, Modal, PriorityFlag, priorityKey, CATEGORY_COLORS } from "../components/ui";
import { TagEditor, LinksPanel, PeoplePanel, LinkTarget } from "../components/ItemMeta";
import { fmtDateTime, isOverdue, toLocalInput, fromLocalInput } from "../lib/format";

export default function TodosView({ onChange }: { onChange: () => void }) {
  const { t: tr } = useTranslation();
  const [todos, setTodos] = useState<TodoRow[]>([]);
  const [lists, setLists] = useState<ListRow[]>([]);
  const [activeList, setActiveList] = useState<string>("");
  const [editing, setEditing] = useState<TodoRow | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [addingList, setAddingList] = useState(false);
  const [newListName, setNewListName] = useState("");

  const reload = async () => {
    setTodos(await listTodos());
    const ls = await listLists();
    setLists(ls);
    // Keep a valid active list selected (first one by default).
    setActiveList((cur) => (ls.some((l) => l.id === cur) ? cur : ls[0]?.id ?? ""));
  };
  useEffect(() => { void reload(); }, []);

  const bump = () => { void reload(); onChange(); };

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
    await upsertTodo({
      title, notes: null, list_id: activeList, due_at: null, priority: 0,
      completed: 0, completed_at: null, parent_todo_id: null,
      position: topLevel.length,
    });
    setNewTitle("");
    bump();
  }

  async function addList() {
    const name = newListName.trim();
    if (!name) { setAddingList(false); return; }
    const color = CATEGORY_COLORS[lists.length % CATEGORY_COLORS.length];
    const id = await upsertList({ name, color });
    setNewListName("");
    setAddingList(false);
    await reload();
    setActiveList(id);
    onChange();
  }

  // drag reorder within top-level of the active list
  const [dragId, setDragId] = useState<string | null>(null);
  async function onDrop(targetId: string) {
    if (!dragId || dragId === targetId) return;
    const ids = topLevel.map((t) => t.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    await reorderTodos(ids);
    setDragId(null);
    bump();
  }

  return (
    <div className="flex h-full">
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
                onClick={async (e) => { e.stopPropagation(); if (confirm(tr("todos.confirmDeleteList", { name: l.name }))) { await deleteList(l.id); bump(); } }}
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
            {topLevel.map((t) => (
              <div key={t.id}>
                <TodoItem
                  todo={t}
                  onToggle={async (c) => { await toggleTodo(t.id, c); bump(); }}
                  onOpen={() => setEditing(t)}
                  onDelete={async () => { if (confirm(tr("todos.confirmDeleteTask", { title: t.title }))) { await deleteTodo(t.id); bump(); } }}
                  draggable
                  onDragStart={() => setDragId(t.id)}
                  onDrop={() => onDrop(t.id)}
                />
                {/* subtasks */}
                <div className="ml-7 space-y-1">
                  {subtasksOf(t.id).map((s) => (
                    <TodoItem
                      key={s.id}
                      todo={s}
                      small
                      onToggle={async (c) => { await toggleTodo(s.id, c); bump(); }}
                      onOpen={() => setEditing(s)}
                      onDelete={async () => { if (confirm(tr("todos.confirmDeleteSubtask", { title: s.title }))) { await deleteTodo(s.id); bump(); } }}
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
  todo, onToggle, onOpen, onDelete, small, draggable, onDragStart, onDrop,
}: {
  todo: TodoRow;
  onToggle: (c: boolean) => void;
  onOpen: () => void;
  onDelete: () => void;
  small?: boolean;
  draggable?: boolean;
  onDragStart?: () => void;
  onDrop?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={(e) => draggable && e.preventDefault()}
      onDrop={onDrop}
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
