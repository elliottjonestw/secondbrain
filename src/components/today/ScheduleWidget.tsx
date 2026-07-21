import { useTranslation } from "react-i18next";
import { CardShell, CardEmpty } from "./CardShell";
import { useAsync } from "./useAsync";
import { loadEvents } from "./dayData";
import type { TodayWidget, TodayWidgetProps } from "./types";
import { fmtTime } from "../../lib/format";

function Schedule({ day, viewingToday, revision, goTo }: TodayWidgetProps) {
  const { t: tr } = useTranslation();
  const { data: occs, loading, error } = useAsync(
    () => loadEvents(day, revision),
    [day.getTime(), revision],
  );

  return (
    <CardShell
      title={tr("today.schedule")}
      onHeaderClick={() => goTo("calendar")}
      loading={loading && !occs}
      error={error}
    >
      {!occs?.length ? (
        <CardEmpty>{viewingToday ? tr("today.noEvents") : tr("today.noEventsDay")}</CardEmpty>
      ) : occs.map((o) => (
        <button
          key={`${o.event.id}|${o.start.toISOString()}`}
          onClick={() => goTo("calendar", { eventId: o.event.id })}
          className="flex w-full items-center gap-2 rounded py-1.5 text-left hover:bg-neutral-50 dark:hover:bg-neutral-700/50"
        >
          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: o.event.color ?? "#3b82f6" }} />
          <span className="w-24 shrink-0 truncate text-xs text-neutral-400">
            {o.event.all_day ? tr("event.allDay") : fmtTime(o.start)}
          </span>
          <span className="truncate">{o.event.summary}</span>
        </button>
      ))}
    </CardShell>
  );
}

export const scheduleWidget: TodayWidget = {
  id: "schedule",
  labelKey: "today.schedule",
  Component: Schedule,
};
