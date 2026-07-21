import { useEffect, useRef, useState } from "react";
import { Plus, Pin, PinOff, Eye, Pencil, Trash2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTranslation } from "react-i18next";
import type { NoteRow } from "../types";
import { listNotes, upsertNote, deleteNote, searchNotes, allLinkTargets } from "../db";
import { Button } from "../components/ui";
import { TagEditor, LinksPanel, PeoplePanel, LinkTarget } from "../components/ItemMeta";
import { fmtDateTime } from "../lib/format";

export default function NotesView({ onChange, initialId }: { onChange: () => void; initialId?: string }) {
  const { t } = useTranslation();
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(initialId ?? null);
  const [query, setQuery] = useState("");
  const [targets, setTargets] = useState<LinkTarget[]>([]);

  const reload = async () => {
    const list = query.trim() ? await searchNotes(query) : await listNotes();
    setNotes(list);
    setTargets(await allLinkTargets());
  };
  useEffect(() => { void reload(); }, [query]);

  const selected = notes.find((n) => n.id === selectedId) ?? null;
  const bump = () => { void reload(); onChange(); };

  async function createNote() {
    const id = await upsertNote({ title: "", body: "", pinned: 0 });
    await reload();
    setSelectedId(id); // open it immediately for editing
    onChange();
  }

  return (
    <div className="flex h-full">
      {/* Notes list */}
      <aside className="flex w-72 shrink-0 flex-col border-r border-neutral-200 dark:border-neutral-700">
        <div className="space-y-2 border-b border-neutral-200 p-3 dark:border-neutral-700">
          <Button variant="primary" className="w-full" onClick={createNote}><span className="flex items-center justify-center gap-1.5"><Plus size={16} /> {t("notes.newNote")}</span></Button>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("notes.searchPlaceholder")}
            className="w-full rounded-lg border border-neutral-200 px-3 py-1.5 text-sm outline-none focus:border-blue-400 dark:border-neutral-600 dark:bg-neutral-800"
          />
        </div>
        <div className="flex-1 overflow-y-auto">
          {notes.map((n) => (
            <button
              key={n.id}
              onClick={() => setSelectedId(n.id)}
              className={`block w-full border-b border-neutral-100 px-3 py-2 text-left dark:border-neutral-800 ${
                selectedId === n.id ? "bg-blue-50 dark:bg-blue-900/30" : "hover:bg-neutral-50 dark:hover:bg-neutral-800"
              }`}
            >
              <div className="flex items-center gap-1 truncate font-medium">
                {n.pinned === 1 && <Pin size={13} className="shrink-0 text-blue-500" fill="currentColor" />}
                {n.title || t("common.untitled")}
              </div>
              <div className="truncate text-xs text-neutral-400">
                {(n.body ?? "").replace(/\s+/g, " ").trim().slice(0, 60) || t("notes.noContent")}
              </div>
            </button>
          ))}
          {notes.length === 0 && <p className="p-4 text-sm text-neutral-400">{t("notes.noneFound")}</p>}
        </div>
      </aside>

      {/* Editor — keyed by note id so local state resets cleanly on selection change */}
      <div className="flex-1 overflow-y-auto">
        {selected ? (
          <NoteEditor
            key={selected.id}
            note={selected}
            targets={targets}
            onChanged={bump}
            onDeleted={() => { setSelectedId(null); bump(); }}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-neutral-400">
            {t("notes.selectOrCreate")}
          </div>
        )}
      </div>
    </div>
  );
}

function NoteEditor({
  note, targets, onChanged, onDeleted,
}: {
  note: NoteRow;
  targets: LinkTarget[];
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  // Local state = source of truth while editing; DB writes are debounced so
  // typing stays instant and the note never re-fetches out from under you.
  const [title, setTitle] = useState(note.title ?? "");
  const [body, setBody] = useState(note.body ?? "");
  const [pinned, setPinned] = useState(note.pinned === 1);
  // Existing notes (with content) open in preview; a freshly-created empty note
  // opens straight into edit mode so you can start typing.
  const [preview, setPreview] = useState(() => !!(note.title?.trim() || note.body?.trim()));
  const saveTimer = useRef<number | null>(null);
  const pending = useRef<{ title: string; body: string; pinned: boolean } | null>(null);

  function scheduleSave(next: { title?: string; body?: string; pinned?: boolean }) {
    const draft = {
      title: next.title ?? title,
      body: next.body ?? body,
      pinned: next.pinned ?? pinned,
    };
    pending.current = draft;
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      pending.current = null;
      await upsertNote({ id: note.id, title: draft.title, body: draft.body, pinned: draft.pinned ? 1 : 0 });
      onChanged();
    }, 400);
  }

  // Flush any pending save exactly once, when the editor unmounts (switching
  // notes/views). Runs on unmount only — not on every keystroke.
  useEffect(() => () => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    const p = pending.current;
    if (p) void upsertNote({ id: note.id, title: p.title, body: p.body, pinned: p.pinned ? 1 : 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-3 flex items-center gap-2">
        <input
          value={title}
          onChange={(e) => { setTitle(e.target.value); scheduleSave({ title: e.target.value }); }}
          placeholder={t("notes.titlePlaceholder")}
          className="flex-1 bg-transparent text-2xl font-bold outline-none"
        />
        <Button variant="ghost" onClick={() => { const p = !pinned; setPinned(p); scheduleSave({ pinned: p }); }}>
          <span className="flex items-center gap-1.5">{pinned ? <><Pin size={15} fill="currentColor" /> {t("notes.pinned")}</> : <><PinOff size={15} /> {t("notes.pin")}</>}</span>
        </Button>
        <Button variant="ghost" onClick={() => setPreview((v) => !v)}>
          <span className="flex items-center gap-1.5">{preview ? <><Pencil size={15} /> {t("notes.edit")}</> : <><Eye size={15} /> {t("notes.preview")}</>}</span>
        </Button>
        <Button variant="danger" onClick={async () => { if (confirm(t("notes.confirmDelete"))) { if (saveTimer.current !== null) window.clearTimeout(saveTimer.current); await deleteNote(note.id); onDeleted(); } }}>
          <span className="flex items-center gap-1.5"><Trash2 size={15} /> {t("common.delete")}</span>
        </Button>
      </div>
      <div className="mb-2 text-xs text-neutral-400">{t("notes.updated", { when: fmtDateTime(note.updated_at) })}</div>

      {preview ? (
        <div className="prose prose-sm max-w-none rounded-lg border border-neutral-200 p-4 dark:prose-invert dark:border-neutral-700">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{body || t("notes.noContent")}</ReactMarkdown>
        </div>
      ) : (
        <textarea
          value={body}
          onChange={(e) => { setBody(e.target.value); scheduleSave({ body: e.target.value }); }}
          placeholder={t("notes.bodyPlaceholder")}
          className="h-96 w-full resize-none rounded-lg border border-neutral-200 p-4 font-mono text-sm outline-none focus:border-blue-400 dark:border-neutral-700 dark:bg-neutral-800"
        />
      )}

      <div className="mt-4 grid grid-cols-3 gap-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-700">
        <TagEditor type="note" id={note.id} />
        <PeoplePanel type="note" id={note.id} />
        <LinksPanel type="note" id={note.id} targets={targets} />
      </div>
    </div>
  );
}
