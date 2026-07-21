import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Plus, Pin, PinOff, Eye, Pencil, Trash2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTranslation } from "react-i18next";
import type { NoteRow } from "../types";
import { listNotes, upsertNote, deleteNote, searchNotes, allLinkTargets, insertNoteImage } from "../db";
import { Button } from "../components/ui";
import MarkdownToolbar, { mdActions, MdEdit } from "../components/MarkdownToolbar";
import DictateButton from "../components/DictateButton";
import NoteImage, { SBIMG, primeNoteImage, releaseNoteImages, noteUrlTransform } from "../components/NoteImage";
import { NoteLink, normalizeEmbeds, youTubeId, youTubeUrl } from "../components/YouTubeEmbed";
import { encodeNoteImage } from "../lib/images";
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

  // Cached image object URLs are shared across notes, so they're only revoked
  // when the whole view goes away — not on every note switch.
  useEffect(() => releaseNoteImages, []);

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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // React owns the textarea's value, so a toolbar edit's caret position can only
  // be restored after the re-render that carries the new text.
  const pendingSel = useRef<[number, number] | null>(null);
  // Mirrors `body` so async image inserts can patch the *latest* text rather
  // than the snapshot they closed over before encoding started.
  const bodyRef = useRef(body);
  const imageSeq = useRef(0);
  const [imageError, setImageError] = useState(false);
  const dictateSeq = useRef(0);
  const [dictateError, setDictateError] = useState("");

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

  useLayoutEffect(() => {
    const sel = pendingSel.current;
    if (!sel || !textareaRef.current) return;
    pendingSel.current = null;
    textareaRef.current.focus();
    textareaRef.current.setSelectionRange(sel[0], sel[1]);
  }, [body]);

  /** Toolbar/shortcut edits go through the same debounced save as typing. */
  function applyEdit(edit: MdEdit) {
    pendingSel.current = [edit.start, edit.end];
    setBody(edit.body);
    bodyRef.current = edit.body;
    scheduleSave({ body: edit.body });
  }

  /**
   * Insert an image at the caret.
   *
   * Encoding and the DB write are async, and the user keeps typing meanwhile —
   * so a placeholder token goes in synchronously at the caret and is swapped
   * for the real `sbimg:` reference when the write lands. Resolving the caret
   * position after the await would drop the image wherever the cursor had
   * wandered to.
   */
  async function insertImage(file: File) {
    const el = textareaRef.current;
    const at = el ? [el.selectionStart, el.selectionEnd] : [body.length, body.length];
    const token = `sbimg:pending-${++imageSeq.current}`;
    const alt = file.name.replace(/\.[^.]+$/, "") || t("notes.md.imageAlt");
    const md = `![${alt}](${token})`;
    const withPlaceholder = body.slice(0, at[0]) + md + body.slice(at[1]);
    applyEdit({ body: withPlaceholder, start: at[0] + md.length, end: at[0] + md.length });

    try {
      const encoded = await encodeNoteImage(file);
      const id = await insertNoteImage(note.id, encoded);
      primeNoteImage(id, encoded.mime, encoded.data, encoded.width, encoded.height);
      swapToken(token, `${SBIMG}${id}`);
    } catch {
      swapToken(token, null); // drop the placeholder rather than leave a dead ref
      setImageError(true);
    }
  }

  /** Replace (or remove) a placeholder in whatever the body has become since.
   *  Reads `bodyRef`, not the `body` closure — the user has been typing. */
  function swapToken(token: string, replacement: string | null) {
    const current = bodyRef.current;
    // Matched with the closing paren, so `pending-1` can't match inside
    // `pending-11` — which it does on the eleventh image pasted into a note.
    const next = replacement === null
      ? current.replace(new RegExp(`!\\[[^\\]]*\\]\\(${token}\\)`), "")
      : current.replace(`(${token})`, `(${replacement})`);
    if (next === current) return; // the user deleted the placeholder mid-flight
    setBody(next);
    bodyRef.current = next;
    scheduleSave({ body: next });
  }

  /**
   * Dictation lands where you *started* speaking.
   *
   * Same problem as an image insert — the transcription round-trip is async and
   * the caret moves meanwhile — so the same answer: a marker goes in
   * synchronously at the caret and is swapped for the transcript when it
   * arrives. It doubles as feedback about where the words are going to appear.
   */
  function beginDictation(): string {
    const el = textareaRef.current;
    const at = el ? [el.selectionStart, el.selectionEnd] : [body.length, body.length];
    // Bracketed, so the marker for dictation 1 can't match inside dictation 11.
    const token = `⟦${t("notes.md.dictating")} ${++dictateSeq.current}⟧`;
    const next = body.slice(0, at[0]) + token + body.slice(at[1]);
    applyEdit({ body: next, start: at[0] + token.length, end: at[0] + token.length });
    return token;
  }

  /** Swap a dictation marker for its transcript (or drop it on failure). */
  function endDictation(token: string, text: string | null) {
    const current = bodyRef.current;
    // A function replacement, so `$&` and friends in a transcript stay literal.
    const next = current.replace(token, () => text ?? "");
    if (next === current) return; // the marker was deleted mid-flight
    setBody(next);
    bodyRef.current = next;
    scheduleSave({ body: next });
  }

  /** Insert text on its own line at the caret, leaving the caret after it.
   *  A newline is added on either side only when there isn't one already — so
   *  inserting into empty space doesn't push blank lines into the note. */
  function insertLine(text: string) {
    const el = textareaRef.current;
    const at = el ? [el.selectionStart, el.selectionEnd] : [body.length, body.length];
    const before = body.slice(0, at[0]);
    const after = body.slice(at[1]);
    const lead = before === "" || before.endsWith("\n") ? "" : "\n";
    const trail = after === "" || after.startsWith("\n") ? "" : "\n";
    const inserted = lead + text + trail;
    const caret = at[0] + lead.length + text.length;
    applyEdit({ body: before + inserted + after, start: caret, end: caret });
  }

  /** A YouTube embed snippet, pasted straight from the Share ▸ Embed button,
   *  goes in as its plain watch URL — which is what the preview renders as a
   *  player. Raw HTML in a body renders as nothing at all. */
  function insertVideo(id: string) {
    insertLine(youTubeUrl(id));
  }

  /** Pasting a screenshot inserts it, and pasting a YouTube embed inserts the
   *  video; every other paste falls through to the textarea's own handling. */
  function onBodyPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const text = e.clipboardData.getData("text/plain");
    if (/<iframe\b/i.test(text)) {
      const id = youTubeId(text);
      if (id) {
        e.preventDefault();
        insertVideo(id);
        return;
      }
    }
    const file = Array.from(e.clipboardData.files).find((f) => f.type.startsWith("image/"));
    if (!file) return;
    e.preventDefault();
    setImageError(false);
    void insertImage(file);
  }

  function onBodyKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key !== "b" && key !== "i" && key !== "k") return;
    const el = e.currentTarget;
    const actions = mdActions(body, el.selectionStart, el.selectionEnd, {
      text: t("notes.md.linkText"),
      url: t("notes.md.linkUrl"),
    });
    e.preventDefault();
    applyEdit(key === "b" ? actions.bold() : key === "i" ? actions.italic() : actions.link());
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
          {/* `img` is overridden so `sbimg:` references resolve to stored rows,
              and the URL sanitizer is widened to let that scheme survive.
              `a` turns a bare YouTube URL into a player; `normalizeEmbeds`
              catches embed `<iframe>`s that reached the body some other way. */}
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{ img: NoteImage, a: NoteLink }}
            urlTransform={noteUrlTransform}
          >
            {body ? normalizeEmbeds(body) : t("notes.noContent")}
          </ReactMarkdown>
        </div>
      ) : (
        <div>
          <MarkdownToolbar
            textareaRef={textareaRef}
            body={body}
            onEdit={applyEdit}
            onInsertImage={(file) => { setImageError(false); void insertImage(file); }}
            onInsertVideo={insertVideo}
            onInsertTable={insertLine}
          />
          {/* Relative so the mic can sit in the corner of the field itself; the
              textarea's extra bottom padding keeps long text out from under it. */}
          <div className="relative">
            {/* `block` on the textarea matters: as an inline element it leaves a
                few pixels of descender gap under it, so the wrapper ends up
                taller than the field and the mic's bottom offset no longer
                matches its right one. */}
            <textarea
              ref={textareaRef}
              value={body}
              onChange={(e) => { setBody(e.target.value); bodyRef.current = e.target.value; scheduleSave({ body: e.target.value }); }}
              onKeyDown={onBodyKeyDown}
              onPaste={onBodyPaste}
              placeholder={t("notes.bodyPlaceholder")}
              className="block h-96 w-full resize-none rounded-b-lg border border-neutral-200 p-4 pb-14 font-mono text-sm outline-none focus:border-blue-400 dark:border-neutral-700 dark:bg-neutral-800"
            />
            <DictateButton
              onStart={beginDictation}
              onResult={endDictation}
              onError={setDictateError}
              className="absolute bottom-3 right-3"
            />
          </div>
          {imageError && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{t("notes.md.imageError")}</p>}
          {dictateError && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{dictateError}</p>}
        </div>
      )}

      <div className="mt-4 grid grid-cols-3 gap-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-700">
        <TagEditor type="note" id={note.id} />
        <PeoplePanel type="note" id={note.id} />
        <LinksPanel type="note" id={note.id} targets={targets} />
      </div>
    </div>
  );
}
