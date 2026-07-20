import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft, ChevronRight, Plus, Repeat, Square, Upload, Download,
  Layers, Loader2, CloudOff,
} from "lucide-react";
import {
  addDays, addMonths, addWeeks, differenceInCalendarDays,
} from "date-fns";
import { useTranslation } from "react-i18next";
import type { TodoRow, EventOccurrence, UnifiedEvent } from "../types";
import { listTodos } from "../db";
import {
  getOccurrences, listCalendars, setCalendarVisible, updateEvent, invalidateCache,
  defaultCalendarId, type CalendarInfo,
} from "../lib/calendars";
import {
  startOfMonth, endOfMonth, startOfWeek, endOfWeek, startOfDay, endOfDay,
  isSameDay, isToday, fmtTime, fmtHour, fmtDate, fmtMonthYear, fmtFullDate,
  fmtWeekdayShort, weekdayNames,
} from "../lib/format";
import { exportCalendar, importCalendar } from "../lib/ics";
import { Button } from "../components/ui";
import EventForm from "../components/EventForm";

type ViewMode = "month" | "week" | "day";
const HOUR_PX = 48;

export default function CalendarView({ onChange, openEventId }: { onChange: () => void; openEventId?: string }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<ViewMode>("month");
  const [cursor, setCursor] = useState(new Date());
  const [occurrences, setOccurrences] = useState<EventOccurrence[]>([]);
  const [todos, setTodos] = useState<TodoRow[]>([]);
  const [editing, setEditing] = useState<{ event: UnifiedEvent | null; calendarId?: string; start?: Date; occ?: Date } | null>(null);
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [calendars, setCalendars] = useState<CalendarInfo[]>(() => listCalendars());
  const [showFilter, setShowFilter] = useState(false);
  // Bumped to force a refetch after a write; the window itself is unchanged.
  const [nonce, setNonce] = useState(0);

  // Visible window depends on mode.
  const [winStart, winEnd] = useMemo<[Date, Date]>(() => {
    if (mode === "month") return [startOfWeek(startOfMonth(cursor)), endOfWeek(endOfMonth(cursor))];
    if (mode === "week") return [startOfWeek(cursor), endOfWeek(cursor)];
    return [startOfDay(cursor), endOfDay(cursor)];
  }, [mode, cursor]);

  // Remote calendars are fetched per visible window, so this runs on every
  // navigation. `seq` discards out-of-order responses when the user pages
  // faster than the network answers.
  const seq = useRef(0);
  useEffect(() => {
    const mine = ++seq.current;
    setLoading(true);
    void (async () => {
      const [{ occurrences: occs, errors: errs }, allTodos] = await Promise.all([
        getOccurrences(winStart, winEnd),
        listTodos(),
      ]);
      if (seq.current !== mine) return; // a newer window won
      setOccurrences(occs);
      setErrors(errs);
      setTodos(allTodos.filter((t) => t.due_at && !t.completed));
      setLoading(false);
    })();
  }, [winStart, winEnd, nonce]);

  const reload = () => { invalidateCache(); setCalendars(listCalendars()); setNonce((n) => n + 1); };
  const bump = () => { reload(); onChange(); };

  // Open a specific event when navigated here with a target (e.g. from Today).
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !openEventId || occurrences.length === 0) return;
    const match = occurrences.find((o) => o.event.id === openEventId);
    if (match) {
      opened.current = true;
      setEditing({ event: match.event, occ: match.start });
    }
  }, [occurrences, openEventId]);

  async function doExport() {
    const path = await exportCalendar();
    setMsg(path ? t("calendar.exportedTo", { path }) : "");
  }
  async function doImport() {
    const n = await importCalendar();
    setMsg(t("calendar.imported", { count: n }));
    bump();
  }

  const move = (dir: number) => {
    if (mode === "month") setCursor((c) => addMonths(c, dir));
    else if (mode === "week") setCursor((c) => addWeeks(c, dir));
    else setCursor((c) => addDays(c, dir));
  };

  const title =
    mode === "month" ? fmtMonthYear(cursor)
    : mode === "week" ? t("calendar.weekOf", { date: fmtDate(startOfWeek(cursor)) })
    : fmtFullDate(cursor);

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-3 dark:border-neutral-700">
        <div className="flex items-center gap-2">
          <Button onClick={() => setCursor(new Date())}>{t("nav.today")}</Button>
          <Button variant="ghost" onClick={() => move(-1)} aria-label={t("calendar.previous")}><ChevronLeft size={18} /></Button>
          <Button variant="ghost" onClick={() => move(1)} aria-label={t("calendar.next")}><ChevronRight size={18} /></Button>
          <h2 className="ml-2 text-lg font-semibold">{title}</h2>
        </div>
        <div className="flex items-center gap-1">
          {loading && <Loader2 size={15} className="mr-1 animate-spin text-neutral-400" />}
          {(["month", "week", "day"] as ViewMode[]).map((m) => (
            <Button key={m} variant={mode === m ? "primary" : "ghost"} onClick={() => setMode(m)}>
              {t(`calendar.mode.${m}`)}
            </Button>
          ))}

          {/* Per-calendar visibility — view them individually or together. */}
          <div className="relative">
            <Button variant="ghost" onClick={() => setShowFilter((v) => !v)} aria-label={t("settings.sections.calendars")}>
              <Layers size={16} />
            </Button>
            {showFilter && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setShowFilter(false)} />
                <div className="absolute right-0 top-full z-20 mt-1 w-56 rounded-lg border border-neutral-200 bg-white p-2 shadow-lg dark:border-neutral-700 dark:bg-neutral-800">
                  <div className="px-1 pb-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-400">{t("settings.sections.calendars")}</div>
                  {calendars.map((cal) => (
                    <label key={cal.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-700/50">
                      <input
                        type="checkbox"
                        checked={cal.visible}
                        onChange={(e) => { setCalendarVisible(cal.id, e.target.checked); reload(); }}
                        className="accent-blue-600"
                      />
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: cal.color ?? "#3b82f6" }} />
                      <span className="truncate">{cal.name}</span>
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>

          <Button variant="primary" className="ml-1" onClick={() => setEditing({ event: null, calendarId: defaultCalendarId(), start: cursor })}><span className="flex items-center gap-1"><Plus size={16} /> {t("itemType.event")}</span></Button>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {mode === "month" ? (
          <MonthGrid
            winStart={winStart}
            cursor={cursor}
            occurrences={occurrences}
            todos={todos}
            onNewEvent={(d) => setEditing({ event: null, calendarId: defaultCalendarId(), start: d })}
            onOpen={(occ) => setEditing({ event: occ.event, occ: occ.start })}
            onReschedule={async (occ, day) => {
              const delta = differenceInCalendarDays(day, occ.start);
              const ns = addDays(new Date(occ.event.dtstart), delta);
              const ne = occ.event.dtend ? addDays(new Date(occ.event.dtend), delta) : null;
              try {
                await updateEvent(occ.event, {
                  dtstart: ns.toISOString(),
                  dtend: ne ? ne.toISOString() : null,
                });
                bump();
              } catch (e) {
                setMsg(e instanceof Error ? e.message : String(e));
              }
            }}
          />
        ) : (
          <TimeGrid
            days={eachDay(winStart, winEnd)}
            occurrences={occurrences}
            todos={todos}
            onNewEvent={(d) => setEditing({ event: null, calendarId: defaultCalendarId(), start: d })}
            onOpen={(occ) => setEditing({ event: occ.event, occ: occ.start })}
          />
        )}
      </div>

      {/* Bottom bar — ICS import/export, shown across all calendar views. */}
      <div className="flex items-center justify-between gap-3 border-t border-neutral-200 px-4 py-2 dark:border-neutral-700">
        <div className="flex min-w-0 items-center gap-3">
          <span className="truncate text-xs text-neutral-400">{msg}</span>
          {errors.length > 0 && (
            <span
              className="flex shrink-0 items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700 dark:bg-amber-950/40 dark:text-amber-400"
              title={errors.join("\n")}
            >
              <CloudOff size={12} /> {t("calendar.someUnavailable")}
            </span>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          <Button onClick={doImport}><span className="flex items-center gap-1.5"><Upload size={15} /> {t("calendar.importIcs")}</span></Button>
          <Button onClick={doExport}><span className="flex items-center gap-1.5"><Download size={15} /> {t("calendar.exportIcs")}</span></Button>
        </div>
      </div>

      {editing && (
        <EventForm
          event={editing.event}
          calendarId={editing.calendarId}
          defaultStart={editing.start}
          occurrenceDate={editing.occ}
          onClose={() => setEditing(null)}
          onSaved={bump}
        />
      )}
    </div>
  );
}

function eachDay(start: Date, end: Date): Date[] {
  const days: Date[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
  return days;
}

// ---------------------------------------------------------------------------
// Month grid
// ---------------------------------------------------------------------------
function MonthGrid({
  winStart, cursor, occurrences, todos, onNewEvent, onOpen, onReschedule,
}: {
  winStart: Date;
  cursor: Date;
  occurrences: EventOccurrence[];
  todos: TodoRow[];
  onNewEvent: (d: Date) => void;
  onOpen: (occ: EventOccurrence) => void;
  onReschedule: (occ: EventOccurrence, day: Date) => void;
}) {
  const { t: tr } = useTranslation();
  const days = eachDay(winStart, addDays(winStart, 41)); // 6 weeks
  const [drag, setDrag] = useState<EventOccurrence | null>(null);

  return (
    <div className="grid grid-cols-7 border-t border-neutral-200 dark:border-neutral-700">
      {weekdayNames().map((d) => (
        <div key={d} className="border-b border-r border-neutral-200 bg-neutral-50 px-2 py-1 text-center text-xs font-semibold text-neutral-500 dark:border-neutral-700 dark:bg-neutral-800">{d}</div>
      ))}
      {days.map((day) => {
        const dayOccs = occurrences.filter((o) => isSameDay(o.start, day));
        const dayTodos = todos.filter((t) => t.due_at && isSameDay(new Date(t.due_at), day));
        const inMonth = day.getMonth() === cursor.getMonth();
        return (
          <div
            key={day.toISOString()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => { if (drag) { onReschedule(drag, day); setDrag(null); } }}
            onDoubleClick={() => onNewEvent(new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9))}
            className={`min-h-[96px] border-b border-r border-neutral-200 p-1 dark:border-neutral-700 ${inMonth ? "" : "bg-neutral-50/60 dark:bg-neutral-900/40"}`}
          >
            <div className={`mb-1 text-right text-xs ${isToday(day) ? "font-bold text-blue-600" : "text-neutral-400"}`}>
              {isToday(day) ? <span className="rounded-full bg-blue-600 px-1.5 py-0.5 text-white">{day.getDate()}</span> : day.getDate()}
            </div>
            <div className="space-y-0.5">
              {dayOccs.map((o, i) => (
                <button
                  key={o.event.id + i}
                  draggable={!o.event.rrule}
                  onDragStart={() => setDrag(o)}
                  onClick={() => onOpen(o)}
                  className="flex w-full items-center gap-0.5 rounded px-1 py-0.5 text-left text-xs text-white"
                  style={{ background: o.event.color ?? "#3b82f6" }}
                  title={o.event.summary}
                >
                  <span className="truncate">{o.event.all_day ? "" : fmtTime(o.start) + " "}{o.event.summary}</span>
                  {o.isRecurringInstance && <Repeat size={10} className="shrink-0 opacity-90" />}
                </button>
              ))}
              {dayTodos.map((t) => (
                <div
                  key={t.id}
                  className="flex items-center gap-1 truncate rounded border border-dashed border-neutral-400 px-1 py-0.5 text-xs text-neutral-500"
                  title={`${tr("itemType.todo")}: ${t.title}`}
                >
                  <Square size={10} className="shrink-0" /> <span className="truncate">{t.title}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Week / Day time grid
// ---------------------------------------------------------------------------
function TimeGrid({
  days, occurrences, todos, onNewEvent, onOpen,
}: {
  days: Date[];
  occurrences: EventOccurrence[];
  todos: TodoRow[];
  onNewEvent: (d: Date) => void;
  onOpen: (occ: EventOccurrence) => void;
}) {
  const hours = Array.from({ length: 24 }, (_, i) => i);

  return (
    <div className="flex">
      {/* hour labels */}
      <div className="w-14 shrink-0 pt-6">
        {hours.map((h) => (
          <div key={h} style={{ height: HOUR_PX }} className="relative -top-2 pr-1 text-right text-xs text-neutral-400">
            {h === 0 ? "" : fmtHour(h)}
          </div>
        ))}
      </div>

      <div className="flex flex-1">
        {days.map((day) => {
          const dayOccs = occurrences.filter((o) => isSameDay(o.start, day) && !o.event.all_day);
          const allDayOccs = occurrences.filter((o) => isSameDay(o.start, day) && o.event.all_day);
          const dayTodos = todos.filter((t) => t.due_at && isSameDay(new Date(t.due_at), day));
          return (
            <div key={day.toISOString()} className="flex-1 border-l border-neutral-200 dark:border-neutral-700">
              {/* day header */}
              <div className={`sticky top-0 z-10 border-b border-neutral-200 bg-white py-1 text-center text-sm dark:border-neutral-700 dark:bg-neutral-900 ${isToday(day) ? "text-blue-600" : ""}`}>
                <div className="font-semibold">{fmtWeekdayShort(day)}</div>
                <div className="text-lg">{day.getDate()}</div>
                {(allDayOccs.length > 0 || dayTodos.length > 0) && (
                  <div className="space-y-0.5 px-1 pt-1">
                    {allDayOccs.map((o, i) => (
                      <button key={i} onClick={() => onOpen(o)} className="block w-full truncate rounded px-1 text-xs text-white" style={{ background: o.event.color ?? "#3b82f6" }}>{o.event.summary}</button>
                    ))}
                    {dayTodos.map((t) => (
                      <div key={t.id} className="flex items-center gap-1 truncate rounded border border-dashed border-neutral-400 px-1 text-xs text-neutral-500"><Square size={10} className="shrink-0" /> <span className="truncate">{t.title}</span></div>
                    ))}
                  </div>
                )}
              </div>
              {/* hour cells */}
              <div className="relative overflow-hidden" style={{ height: 24 * HOUR_PX }}>
                {hours.map((h) => (
                  <div
                    key={h}
                    onClick={() => onNewEvent(new Date(day.getFullYear(), day.getMonth(), day.getDate(), h))}
                    style={{ height: HOUR_PX }}
                    className="border-b border-neutral-100 hover:bg-blue-50/50 dark:border-neutral-800 dark:hover:bg-blue-900/20"
                  />
                ))}
                {dayOccs.map((o, i) => {
                  const startMin = o.start.getHours() * 60 + o.start.getMinutes();
                  const durMin = o.end ? Math.max((o.end.getTime() - o.start.getTime()) / 60000, 30) : 60;
                  const height = (durMin / 60) * HOUR_PX;
                  const showTime = height >= 34; // hide the time line when the block is too short to fit it
                  return (
                    <button
                      key={i}
                      onClick={() => onOpen(o)}
                      className="absolute left-1 right-1 flex flex-col overflow-hidden rounded px-1 py-0.5 text-left leading-tight text-white"
                      style={{ top: (startMin / 60) * HOUR_PX, height, background: o.event.color ?? "#3b82f6" }}
                      title={`${o.event.summary} · ${fmtTime(o.start)}`}
                    >
                      <span className="flex items-center gap-0.5 truncate text-[11px] font-medium"><span className="truncate">{o.event.summary}</span>{o.isRecurringInstance && <Repeat size={9} className="shrink-0" />}</span>
                      {showTime && <span className="truncate text-[10px] opacity-80">{fmtTime(o.start)}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
