import { RefObject, useRef, useState } from "react";
import {
  Bold, Italic, Strikethrough, Heading1, Heading2, Heading3,
  List, ListOrdered, ListChecks, Link as LinkIcon, Code, Quote, Image as ImageIcon, SquarePlay,
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

type Props = {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  body: string;
  onEdit: (edit: MdEdit) => void;
  /** Insert a picked image file at the caret. Owned by the editor, which knows
   *  the note id the image has to be stored against. */
  onInsertImage: (file: File) => void;
  /** Insert a YouTube video at the caret, by id. */
  onInsertVideo: (id: string) => void;
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

export default function MarkdownToolbar({ textareaRef, body, onEdit, onInsertImage, onInsertVideo }: Props) {
  const { t } = useTranslation();
  const fileInput = useRef<HTMLInputElement>(null);
  // `window.prompt()` is a silent no-op in WKWebView, so asking for the video
  // takes a real dialog.
  const [videoOpen, setVideoOpen] = useState(false);
  const [videoInput, setVideoInput] = useState("");
  const videoId = youTubeId(videoInput);

  function addVideo() {
    if (!videoId) return;
    setVideoOpen(false);
    setVideoInput("");
    onInsertVideo(videoId);
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
    </div>
  );
}
