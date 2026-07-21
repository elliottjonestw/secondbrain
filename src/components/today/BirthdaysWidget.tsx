import { useTranslation } from "react-i18next";
import { Cake } from "lucide-react";
import { CardShell, CardEmpty } from "./CardShell";
import { useAsync } from "./useAsync";
import { loadPeople } from "./dayData";
import { upcomingBirthdays } from "./derive";
import type { TodayWidget, TodayWidgetProps } from "./types";

/** How far ahead the card looks. */
const HORIZON_DAYS = 30;

function Birthdays({ day, revision }: TodayWidgetProps) {
  const { t: tr } = useTranslation();
  const { data: people, loading, error } = useAsync(() => loadPeople(revision), [revision]);
  // Counted forward from the day on show, so stepping to next Friday lists the
  // birthdays coming up from there rather than from today.
  const birthdays = upcomingBirthdays(people ?? [], HORIZON_DAYS, day);

  return (
    <CardShell title={tr("today.birthdays")} loading={loading && !people} error={error}>
      {birthdays.length === 0 ? <CardEmpty>{tr("today.noBirthdays")}</CardEmpty> : birthdays.map((b) => (
        <div key={b.person.id} className="flex items-center gap-2 py-1">
          <Cake size={14} className="shrink-0 text-pink-500" />
          <span className="flex-1 truncate">{b.person.full_name || tr("people.newContact")}</span>
          <span className="shrink-0 text-xs text-neutral-400">{b.dateLabel}</span>
          <span className={`shrink-0 text-xs ${b.days === 0 ? "font-medium text-pink-500" : "text-neutral-400"}`}>
            {b.awayLabel}
          </span>
        </div>
      ))}
    </CardShell>
  );
}

export const birthdaysWidget: TodayWidget = {
  id: "birthdays",
  labelKey: "today.birthdays",
  Component: Birthdays,
};
