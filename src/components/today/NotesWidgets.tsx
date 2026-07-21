// Pinned and recent notes. Two widgets in one file because they're the same
// card with a different filter — separating them would duplicate the shell to
// no benefit, and they're registered (and hidden, and reordered) independently.

import { useTranslation } from "react-i18next";
import { Pin } from "lucide-react";
import { CardShell, CardEmpty } from "./CardShell";
import { useAsync } from "./useAsync";
import { loadNotes } from "./dayData";
import type { TodayWidget, TodayWidgetProps } from "./types";
import type { NoteRow } from "../../types";
import { fmtDateTime } from "../../lib/format";

/** How many notes a card lists before it stops being a summary. */
const LIMIT = 5;

function PinnedNotes({ revision, goTo }: TodayWidgetProps) {
  const { t: tr } = useTranslation();
  const { data: notes, loading, error } = useAsync(() => loadNotes(revision), [revision]);
  const pinned = (notes ?? []).filter((n) => n.pinned).slice(0, LIMIT);

  return (
    <CardShell
      title={tr("today.pinnedNotes")}
      onHeaderClick={() => goTo("notes")}
      loading={loading && !notes}
      error={error}
    >
      {pinned.length === 0 ? <CardEmpty>{tr("today.noPinned")}</CardEmpty> : pinned.map((n) => (
        <NoteRowButton key={n.id} note={n} onOpen={() => goTo("notes", { noteId: n.id })} pinned />
      ))}
    </CardShell>
  );
}

function RecentNotes({ revision, goTo }: TodayWidgetProps) {
  const { t: tr } = useTranslation();
  const { data: notes, loading, error } = useAsync(() => loadNotes(revision), [revision]);
  const recent = (notes ?? []).filter((n) => !n.pinned).slice(0, LIMIT);

  return (
    <CardShell
      title={tr("today.recentNotes")}
      onHeaderClick={() => goTo("notes")}
      loading={loading && !notes}
      error={error}
    >
      {recent.length === 0 ? <CardEmpty>{tr("today.noNotes")}</CardEmpty> : recent.map((n) => (
        <NoteRowButton key={n.id} note={n} onOpen={() => goTo("notes", { noteId: n.id })} />
      ))}
    </CardShell>
  );
}

function NoteRowButton({ note, onOpen, pinned }: { note: NoteRow; onOpen: () => void; pinned?: boolean }) {
  const { t: tr } = useTranslation();
  return (
    <button
      onClick={onOpen}
      className="flex w-full items-center justify-between gap-2 rounded py-1 text-left hover:bg-neutral-50 dark:hover:bg-neutral-700/50"
    >
      <span className="flex min-w-0 items-center gap-1.5">
        {pinned && <Pin size={13} className="shrink-0 text-blue-500" fill="currentColor" />}
        <span className="truncate">{note.title || tr("common.untitled")}</span>
      </span>
      {/* The pinned card leads with the pin; the recent one earns its name from
          the timestamp, so only it shows one. */}
      {!pinned && <span className="shrink-0 text-xs text-neutral-400">{fmtDateTime(note.updated_at)}</span>}
    </button>
  );
}

export const pinnedNotesWidget: TodayWidget = {
  id: "pinnedNotes",
  labelKey: "today.pinnedNotes",
  Component: PinnedNotes,
};

export const recentNotesWidget: TodayWidget = {
  id: "recentNotes",
  labelKey: "today.recentNotes",
  Component: RecentNotes,
};
