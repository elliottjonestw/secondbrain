import { RefObject, useRef, useState } from "react";
import {
  Bold, Italic, Strikethrough, Heading1, Heading2, Heading3,
  List, ListOrdered, ListChecks, Link as LinkIcon, Code, Quote, Image as ImageIcon, SquarePlay,
  Table as TableIcon, AlignLeft, AlignCenter, AlignRight,
} from "lucide-react";
import { IMAGE_ACCEPT } from "../lib/images";
import { useTranslation } from "react-i18next";
import { youTubeId } from "./YouTubeEmbed";
import { Button, Modal } from "./ui";

/** The result of a toolbar action: the new body plus where the caret should land. */
export type MdEdit = { body: string; start: number; end: number };

/** Wrap the selection in `before`/`after`. With nothing selected, insert the
 * markers and put the caret between them so you can just start typing. */
export function wrap(body: string, start: number, end: number, before: string, after = before): MdEdit {
  const sel = body.slice(start, end);
  // Already wrapped? Unwrap, so the button toggles.
  if (sel.startsWith(before) && sel.endsWith(after) && sel.length >= before.length + after.length) {
    const inner = sel.slice(before.length, sel.length - after.length);
    return { body: body.slice(0, start) + inner + body.slice(end), start, end: start + inner.length };
  }
  const next = body.slice(0, start) + before + sel + after + body.slice(end);
  return { body: next, start: start + before.length, end: start + before.length + sel.length };
}

/** Expand [start,end) to whole lines — line prefixes apply to every line touched. */
function lineRange(body: string, start: number, end: number): [number, number] {
  const from = body.lastIndexOf("\n", start - 1) + 1;
  const nl = body.indexOf("\n", end);
  return [from, nl === -1 ? body.length : nl];
}

/** Any list/heading/quote marker already on a line, so applying one replaces
 * another rather than stacking `- > ## text`. */
const MARKER = /^(\s*)(?:(?:[-*+]\s\[[ xX]\]\s)|(?:[-*+]\s)|(?:\d+\.\s)|(?:#{1,6}\s)|(?:>\s))?/;

/** Apply a line prefix to every selected line. `marker` is either a literal
 * (`"- "`, `"## "`) or a function for numbered lists. Re-applying removes it. */
export function prefixLines(
  body: string, start: number, end: number,
  marker: string | ((i: number) => string),
): MdEdit {
  const [from, to] = lineRange(body, start, end);
  const lines = body.slice(from, to).split("\n");
  const at = (i: number) => (typeof marker === "string" ? marker : marker(i));
  // Toggle off only when every line already carries exactly this marker —
  // an exact match, so clicking "bullet" on a checklist converts it rather
  // than stripping it (`- [ ] x` starts with `- ` but isn't a bullet).
  const markerOf = (line: string) => line.replace(/^\s*/, "").match(MARKER)?.[0] ?? "";
  const allSet = lines.every((l, i) => markerOf(l) === at(i));
  const next = lines
    .map((line, i) => {
      const indent = line.match(/^\s*/)?.[0] ?? "";
      const bare = line.replace(MARKER, "");
      return allSet ? indent + bare : indent + at(i) + bare;
    })
    .join("\n");
  const body2 = body.slice(0, from) + next + body.slice(to);
  return { body: body2, start: from, end: from + next.length };
}

/** Link: `[selection](url)`, caret on the placeholder that still needs filling. */
export function link(body: string, start: number, end: number, textLabel: string, urlLabel: string): MdEdit {
  const sel = body.slice(start, end);
  const text = sel || textLabel;
  const inserted = `[${text}](${urlLabel})`;
  const next = body.slice(0, start) + inserted + body.slice(end);
  // Select whichever half is still a placeholder: the url if there was a
  // selection to use as the label, otherwise the label itself.
  const urlAt = start + text.length + 3;
  return sel
    ? { body: next, start: urlAt, end: urlAt + urlLabel.length }
    : { body: next, start: start + 1, end: start + 1 + text.length };
}

export type TableAlign = "left" | "center" | "right";

/** The largest table the grid picker offers. Past this you're better off
 *  pasting than drawing, and Word/Docs pickers stop around here too. */
const GRID_MAX = 8;

/** A GFM table skeleton, padded so the *source* stays readable — an unpadded
 *  table is legal markdown but a mess to edit by hand afterwards, which is the
 *  whole point of inserting one from a dialog. `rows` counts body rows; the
 *  header is always there because GFM has no headerless table. */
export function tableMarkdown(rows: number, cols: number, align: TableAlign, header: string): string {
  const heads = Array.from({ length: cols }, (_, i) => (cols > 1 ? `${header} ${i + 1}` : header));
  // Three dashes is the minimum a delimiter cell can be, plus one per colon.
  const minDelim = align === "center" ? 5 : 4;
  const widths = heads.map((h) => Math.max(h.length, minDelim));
  const row = (cells: string[]) => `| ${cells.map((c, i) => c.padEnd(widths[i])).join(" | ")} |`;
  const delim = widths.map((w) =>
    align === "left" ? ":" + "-".repeat(w - 1)
      : align === "right" ? "-".repeat(w - 1) + ":"
        : ":" + "-".repeat(w - 2) + ":");
  const body = Array.from({ length: rows }, () => row(heads.map(() => "")));
  return [row(heads), row(delim), ...body].join("\n");
}

type Props = {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  body: string;
  onEdit: (edit: MdEdit) => void;
  /** Insert a picked image file at the caret. Owned by the editor, which knows
   *  the note id the image has to be stored against. */
  onInsertImage: (file: File) => void;
  /** Insert a YouTube video at the caret, by id. */
  onInsertVideo: (id: string) => void;
  /** Insert a block of markdown on its own line at the caret. */
  onInsertTable: (markdown: string) => void;
};

/** Builds the action set once so the buttons and the keyboard shortcuts in
 * NotesView run exactly the same code. */
export function mdActions(body: string, start: number, end: number, labels: { text: string; url: string }) {
  return {
    bold: () => wrap(body, start, end, "**"),
    italic: () => wrap(body, start, end, "*"),
    strike: () => wrap(body, start, end, "~~"),
    code: () => wrap(body, start, end, "`"),
    h1: () => prefixLines(body, start, end, "# "),
    h2: () => prefixLines(body, start, end, "## "),
    h3: () => prefixLines(body, start, end, "### "),
    bullet: () => prefixLines(body, start, end, "- "),
    ordered: () => prefixLines(body, start, end, (i) => `${i + 1}. `),
    checklist: () => prefixLines(body, start, end, "- [ ] "),
    quote: () => prefixLines(body, start, end, "> "),
    link: () => link(body, start, end, labels.text, labels.url),
  };
}

export default function MarkdownToolbar({ textareaRef, body, onEdit, onInsertImage, onInsertVideo, onInsertTable }: Props) {
  const { t } = useTranslation();
  const fileInput = useRef<HTMLInputElement>(null);
  // `window.prompt()` is a silent no-op in WKWebView, so asking for the video
  // takes a real dialog.
  const [videoOpen, setVideoOpen] = useState(false);
  const [videoInput, setVideoInput] = useState("");
  const videoId = youTubeId(videoInput);

  const [tableOpen, setTableOpen] = useState(false);
  const [size, setSize] = useState({ rows: 3, cols: 3 });
  // What the pointer is currently over, so the grid can preview a size without
  // committing to it. Null means "show the committed size".
  const [hover, setHover] = useState<{ rows: number; cols: number } | null>(null);
  const [align, setAlign] = useState<TableAlign>("left");
  const shown = hover ?? size;

  function addVideo() {
    if (!videoId) return;
    setVideoOpen(false);
    setVideoInput("");
    onInsertVideo(videoId);
  }

  function openTable() {
    setSize({ rows: 3, cols: 3 });
    setHover(null);
    setTableOpen(true);
  }

  function addTable(rows = size.rows, cols = size.cols) {
    setTableOpen(false);
    onInsertTable(tableMarkdown(rows, cols, align, t("notes.md.tableHeader")));
  }

  function run(pick: (a: ReturnType<typeof mdActions>) => MdEdit) {
    const el = textareaRef.current;
    if (!el) return;
    const actions = mdActions(body, el.selectionStart, el.selectionEnd, {
      text: t("notes.md.linkText"),
      url: t("notes.md.linkUrl"),
    });
    onEdit(pick(actions));
  }

  const items: { key: string; icon: typeof Bold; label: string; run: () => void; group: number }[] = [
    { key: "bold", icon: Bold, label: t("notes.md.bold"), run: () => run((a) => a.bold()), group: 0 },
    { key: "italic", icon: Italic, label: t("notes.md.italic"), run: () => run((a) => a.italic()), group: 0 },
    { key: "strike", icon: Strikethrough, label: t("notes.md.strikethrough"), run: () => run((a) => a.strike()), group: 0 },
    { key: "h1", icon: Heading1, label: t("notes.md.h1"), run: () => run((a) => a.h1()), group: 1 },
    { key: "h2", icon: Heading2, label: t("notes.md.h2"), run: () => run((a) => a.h2()), group: 1 },
    { key: "h3", icon: Heading3, label: t("notes.md.h3"), run: () => run((a) => a.h3()), group: 1 },
    { key: "bullet", icon: List, label: t("notes.md.bulletList"), run: () => run((a) => a.bullet()), group: 2 },
    { key: "ordered", icon: ListOrdered, label: t("notes.md.numberedList"), run: () => run((a) => a.ordered()), group: 2 },
    { key: "checklist", icon: ListChecks, label: t("notes.md.checklist"), run: () => run((a) => a.checklist()), group: 2 },
    { key: "link", icon: LinkIcon, label: t("notes.md.link"), run: () => run((a) => a.link()), group: 3 },
    { key: "code", icon: Code, label: t("notes.md.code"), run: () => run((a) => a.code()), group: 3 },
    { key: "quote", icon: Quote, label: t("notes.md.quote"), run: () => run((a) => a.quote()), group: 3 },
    { key: "table", icon: TableIcon, label: t("notes.md.table"), run: openTable, group: 4 },
    { key: "image", icon: ImageIcon, label: t("notes.md.image"), run: () => fileInput.current?.click(), group: 4 },
    { key: "video", icon: SquarePlay, label: t("notes.md.video"), run: () => setVideoOpen(true), group: 4 },
  ];

  return (
    <div
      role="toolbar"
      aria-label={t("notes.md.toolbar")}
      className="flex flex-wrap items-center gap-0.5 rounded-t-lg border border-b-0 border-neutral-200 bg-neutral-50 px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-800/60"
    >
      {items.map((item, i) => (
        <span key={item.key} className="flex items-center">
          {i > 0 && items[i - 1].group !== item.group && (
            <span className="mx-1 h-4 w-px bg-neutral-200 dark:bg-neutral-600" />
          )}
          <button
            type="button"
            title={item.label}
            aria-label={item.label}
            // Keep the textarea's selection: mousedown would blur it first.
            onMouseDown={(e) => e.preventDefault()}
            onClick={item.run}
            className="rounded p-1.5 text-neutral-500 transition-colors hover:bg-neutral-200 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700 dark:hover:text-neutral-100"
          >
            <item.icon size={15} />
          </button>
        </span>
      ))}
      <input
        ref={fileInput}
        type="file"
        accept={IMAGE_ACCEPT}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onInsertImage(file);
          e.target.value = ""; // so re-picking the same file fires again
        }}
      />
      <Modal
        open={videoOpen}
        onClose={() => setVideoOpen(false)}
        title={t("notes.md.video")}
        footer={
          <>
            <Button onClick={() => setVideoOpen(false)}>{t("common.cancel")}</Button>
            <Button variant="primary" disabled={!videoId} onClick={addVideo}>{t("common.add")}</Button>
          </>
        }
      >
        <input
          autoFocus
          value={videoInput}
          onChange={(e) => setVideoInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addVideo()}
          placeholder={t("notes.md.videoPlaceholder")}
          className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-blue-400 dark:border-neutral-600 dark:bg-neutral-700"
        />
        {/* Only complain once there's something to complain about — the field
            starts empty and shouldn't open showing an error. */}
        <p className="mt-2 text-xs text-neutral-400">
          {videoInput.trim() && !videoId ? t("notes.md.videoInvalid") : t("notes.md.videoHint")}
        </p>
      </Modal>
      <Modal
        open={tableOpen}
        onClose={() => setTableOpen(false)}
        title={t("notes.md.table")}
        footer={
          <>
            <Button onClick={() => setTableOpen(false)}>{t("common.cancel")}</Button>
            <Button variant="primary" onClick={() => addTable()}>{t("common.add")}</Button>
          </>
        }
      >
        {/* Drag-to-size grid, the Docs/Word gesture: one click picks both
            dimensions for the common small table. The steppers below cover
            keyboard use and anything past GRID_MAX. */}
        <div
          className="inline-grid gap-1"
          style={{ gridTemplateColumns: `repeat(${GRID_MAX}, 1.25rem)` }}
          onMouseLeave={() => setHover(null)}
        >
          {Array.from({ length: GRID_MAX * GRID_MAX }, (_, i) => {
            const r = Math.floor(i / GRID_MAX) + 1;
            const c = (i % GRID_MAX) + 1;
            // Row 1 is the header row, so it takes r-1 body rows to reach r.
            const on = r <= shown.rows + 1 && c <= shown.cols;
            return (
              <button
                key={i}
                type="button"
                tabIndex={-1}
                aria-hidden
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setHover({ rows: r - 1, cols: c })}
                onClick={() => addTable(r - 1, c)}
                className={`h-5 rounded-sm border ${
                  on
                    ? "border-blue-500 bg-blue-100 dark:bg-blue-500/30"
                    : "border-neutral-200 dark:border-neutral-600"
                } ${r === 1 ? "border-b-2" : ""}`}
              />
            );
          })}
        </div>
        <p className="mt-2 text-sm text-neutral-500">
          {t("notes.md.tableSize", { cols: shown.cols, rows: shown.rows })}
        </p>

        <div className="mt-4 flex flex-wrap items-end gap-4">
          {([["cols", t("notes.md.tableColumns")], ["rows", t("notes.md.tableRows")]] as const).map(([field, label]) => (
            <label key={field} className="text-xs text-neutral-500">
              {label}
              <input
                type="number"
                min={1}
                max={field === "cols" ? 20 : 100}
                value={size[field]}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (!Number.isFinite(n)) return;
                  setHover(null);
                  setSize((s) => ({ ...s, [field]: Math.max(1, Math.round(n)) }));
                }}
                className="mt-1 block w-20 rounded-lg border border-neutral-200 px-2 py-1 text-sm text-neutral-800 outline-none focus:border-blue-400 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100"
              />
            </label>
          ))}
          <div className="text-xs text-neutral-500">
            {t("notes.md.tableAlign")}
            <div className="mt-1 flex gap-0.5">
              {([
                ["left", AlignLeft, t("notes.md.alignLeft")],
                ["center", AlignCenter, t("notes.md.alignCenter")],
                ["right", AlignRight, t("notes.md.alignRight")],
              ] as const).map(([value, Icon, label]) => (
                <button
                  key={value}
                  type="button"
                  title={label}
                  aria-label={label}
                  aria-pressed={align === value}
                  onClick={() => setAlign(value)}
                  className={`rounded p-1.5 ${
                    align === value
                      ? "bg-blue-100 text-blue-700 dark:bg-blue-500/30 dark:text-blue-200"
                      : "text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-700"
                  }`}
                >
                  <Icon size={15} />
                </button>
              ))}
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
}
