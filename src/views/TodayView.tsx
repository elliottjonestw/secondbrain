// The Today page: a header, an arrangeable grid of widgets, and the editor.
//
// It owns none of the cards' data. Each widget in `components/today/registry`
// fetches its own and renders itself inside an error boundary, so adding a
// widget touches nothing here and a widget that throws loses its own tile
// rather than the page.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronLeft, ChevronRight, ChevronUp, ChevronDown,
  SlidersHorizontal, Eye, EyeOff,
} from "lucide-react";
import type { GoTo } from "../types";
import { startOfDay, fmtFullDate, isToday } from "../lib/format";
import {
  getSettings, saveSettings, mergeTodayLayout, onCloudSettingsApplied,
  type TodayCardPref,
} from "../lib/settings";
import { WIDGET_IDS, findWidget } from "../components/today/registry";
import { nextRevision } from "../components/today/dayData";
import { CardBoundary } from "../components/today/CardBoundary";
import { LoadBarrier, BarrierProvider, useBarrierGate } from "../components/today/loadBarrier";
import { ViewLoading, SlowLoad } from "../components/ViewGate";
import { Modal, Button } from "../components/ui";

/**
 * The page's card order and visibility, persisted to settings.
 *
 * Always read through `mergeTodayLayout`, so a build that adds a widget shows
 * it to someone who arranged their page before it existed.
 */
function useTodayLayout() {
  const [layout, setLayout] = useState<TodayCardPref[]>(
    () => mergeTodayLayout(getSettings().todayLayout, WIDGET_IDS),
  );

  const apply = (next: TodayCardPref[]) => {
    setLayout(next);
    saveSettings({ todayLayout: next });
  };

  return {
    layout,
    /** Ids to render, in order. */
    visible: layout.filter((p) => !p.hidden).map((p) => p.id),
    toggle: (id: string) =>
      apply(layout.map((p) => (p.id === id ? { ...p, hidden: !p.hidden } : p))),
    move: (from: number, to: number) => {
      if (from === to || to < 0 || to >= layout.length) return;
      const next = [...layout];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      apply(next);
    },
    reset: () => apply(mergeTodayLayout([], WIDGET_IDS)),
  };
}

export default function TodayView({ onChange, goTo }: { onChange: () => void; goTo: GoTo }) {
  const { t: tr } = useTranslation();
  // The day on show. Always local midnight so it can be compared and stepped
  // without dragging a time-of-day along.
  const [day, setDay] = useState(() => startOfDay(new Date()));
  const [editing, setEditing] = useState(false);
  // Bumped after any mutation. Widgets fetch on it, and it clears the shared
  // per-day cache so nobody re-reads what was just changed. Seeded from a
  // module counter so *arriving* on the page is a cache miss too — data may
  // well have changed while the user was in another view.
  const [revision, setRevision] = useState(nextRevision);
  const cards = useTodayLayout();
  const viewingToday = isToday(day);
  // The first-load gate. The widgets own their data, so instead of one page
  // `load()` the barrier waits for every widget's opening fetch to land (see
  // loadBarrier.ts). Created once per mount; stepping days or mutating never
  // re-blocks, because `useAsync` only reports its first load.
  const barrierRef = useRef<LoadBarrier | null>(null);
  if (!barrierRef.current) barrierRef.current = new LoadBarrier();
  const gate = useBarrierGate(barrierRef.current);
  const blocked = gate === "loading";

  const stepDay = (delta: number) => {
    const next = new Date(day);
    next.setDate(next.getDate() + delta);
    setDay(startOfDay(next));
  };

  const bump = () => {
    setRevision(nextRevision());
    onChange();
  };

  // The account's widget settings arrive from the server shortly after launch,
  // by which time this page has already drawn from whatever this device had.
  // Widgets read those settings at render (a weather location, a watchlist, a
  // feed list), so a pull that changed something has to re-run their fetches —
  // otherwise a fresh device shows an empty News card until the user navigates
  // away and back. Bumping the revision is the same signal a mutation sends,
  // and it fires at most once per sign-in.
  useEffect(() => onCloudSettingsApplied(() => setRevision(nextRevision())), []);

  return (
    <div className="mx-auto h-full max-w-4xl overflow-y-auto p-4 md:p-6">
      {/* The page stays mounted while it loads so every widget can register its
          fetch with the barrier — hiding it, not unmounting it, is what lets the
          gate wait on loads that only start once their card exists. */}
      {blocked && <ViewLoading />}
      <SlowLoad state={{ status: gate === "slow" ? "slow" : "ready", error: null, retry: () => {} }} />
      <div className={blocked ? "hidden" : undefined}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{tr("nav.today")}</h1>
          <div className="flex items-center gap-1">
            <button
              onClick={() => stepDay(-1)}
              title={tr("today.prevDay")}
              aria-label={tr("today.prevDay")}
              className="rounded p-0.5 text-neutral-400 hover:text-blue-500"
            >
              <ChevronLeft size={16} />
            </button>
            <p className="text-sm text-neutral-400">{fmtFullDate(day)}</p>
            <button
              onClick={() => stepDay(1)}
              title={tr("today.nextDay")}
              aria-label={tr("today.nextDay")}
              className="rounded p-0.5 text-neutral-400 hover:text-blue-500"
            >
              <ChevronRight size={16} />
            </button>
            {/* Only worth showing once there's somewhere to come back from. */}
            {!viewingToday && (
              <button
                onClick={() => setDay(startOfDay(new Date()))}
                className="ml-1 rounded px-1.5 py-0.5 text-xs text-blue-500 hover:bg-neutral-100 dark:hover:bg-neutral-700"
              >
                {tr("today.backToToday")}
              </button>
            )}
          </div>
        </div>
        {/* shrink-0 so the header's flex row can't squeeze it narrow enough to
            wrap the label under the icon. */}
        <Button className="shrink-0" onClick={() => setEditing(true)}>
          <span className="flex items-center gap-1.5"><SlidersHorizontal size={14} /> {tr("today.edit")}</span>
        </Button>
      </div>

      <BarrierProvider value={barrierRef.current}>
      {/* `grid-cols-1` is not decoration: without it the single implicit track
          is `auto`, which sizes to the widest card's max-content and pushes the
          whole page past the viewport. Tailwind's numbered columns are
          `minmax(0,1fr)`, which clamps. `md:grid-cols-2` already did. */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {cards.visible.map((id) => {
          // A layout can name an id this build doesn't have; `mergeTodayLayout`
          // strips those, but rendering defensively costs nothing.
          const widget = findWidget(id);
          if (!widget) return null;
          const { Component } = widget;
          return (
            <CardBoundary key={id} label={tr(widget.labelKey)} resetKey={`${day.toISOString()}|${revision}`}>
              <Component
                day={day}
                viewingToday={viewingToday}
                revision={revision}
                onChange={bump}
                goTo={goTo}
              />
            </CardBoundary>
          );
        })}
      </div>
      </BarrierProvider>

      <LayoutEditor
        open={editing}
        onClose={() => setEditing(false)}
        layout={cards.layout}
        onMove={cards.move}
        onToggle={cards.toggle}
        onReset={cards.reset}
      />
      </div>
    </div>
  );
}

/**
 * The Today page's card editor: arrows to reorder, eye to hide.
 *
 * Changes apply to the page behind the modal as they're made — there's nothing
 * here worth a Save button, and seeing the real layout is the point.
 *
 * Reordering is buttons, NOT drag-and-drop. HTML5 drag was tried and doesn't
 * work in WKWebView here even with the setData/-webkit-user-drag incantations
 * that are supposed to fix it. Buttons are also keyboard-reachable, which drag
 * never was. Don't "restore" the drag handles.
 */
function LayoutEditor({
  open, onClose, layout, onMove, onToggle, onReset,
}: {
  open: boolean;
  onClose: () => void;
  layout: TodayCardPref[];
  onMove: (from: number, to: number) => void;
  onToggle: (id: string) => void;
  onReset: () => void;
}) {
  const { t: tr } = useTranslation();

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={tr("today.layoutTitle")}
      footer={
        <div className="flex items-center justify-between gap-3">
          <button onClick={onReset} className="text-sm text-neutral-400 hover:text-blue-500">
            {tr("today.resetLayout")}
          </button>
          <Button variant="primary" onClick={onClose}>{tr("today.done")}</Button>
        </div>
      }
    >
      <p className="mb-3 text-sm text-neutral-500">{tr("today.layoutHint")}</p>
      <div className="space-y-1.5">
        {layout.map((pref, i) => {
          const widget = findWidget(pref.id);
          if (!widget) return null;
          return (
            <div
              key={pref.id}
              className="flex items-center gap-2 rounded-lg border border-neutral-200 px-3 py-2 dark:border-neutral-600"
            >
              {/* Hidden rows stay put rather than dropping to the bottom, so the
                  position you gave a card survives switching it off and on. */}
              <span className={`flex-1 truncate text-sm ${pref.hidden ? "text-neutral-400 line-through" : ""}`}>
                {tr(widget.labelKey)}
              </span>
              <button
                onClick={() => onMove(i, i - 1)}
                disabled={i === 0}
                className="rounded p-1 text-neutral-400 hover:text-blue-500 disabled:opacity-30 disabled:hover:text-neutral-400"
                aria-label={tr("common.moveUp")}
                title={tr("common.moveUp")}
              >
                <ChevronUp size={15} />
              </button>
              <button
                onClick={() => onMove(i, i + 1)}
                disabled={i === layout.length - 1}
                className="rounded p-1 text-neutral-400 hover:text-blue-500 disabled:opacity-30 disabled:hover:text-neutral-400"
                aria-label={tr("common.moveDown")}
                title={tr("common.moveDown")}
              >
                <ChevronDown size={15} />
              </button>
              <button
                onClick={() => onToggle(pref.id)}
                className="rounded p-1 text-neutral-400 hover:text-blue-500"
                aria-label={pref.hidden ? tr("today.showCard") : tr("today.hideCard")}
                title={pref.hidden ? tr("today.showCard") : tr("today.hideCard")}
              >
                {pref.hidden ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
