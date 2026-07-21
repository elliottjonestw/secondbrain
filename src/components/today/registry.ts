// The Today page's widgets, in the order a fresh install gets them.
//
// This list is the single place a widget is registered. Adding one is a new
// file plus a line here — nothing else on the page changes, the layout editor
// picks it up, and `mergeTodayLayout` shows it to people who arranged their
// page before it existed.

import type { TodayWidget } from "./types";
import { summaryWidget } from "./SummaryWidget";
import { scheduleWidget } from "./ScheduleWidget";
import { dueWidget } from "./DueWidget";
import { weatherWidget } from "./WeatherWidget";
import { pinnedNotesWidget, recentNotesWidget } from "./NotesWidgets";
import { birthdaysWidget } from "./BirthdaysWidget";

export const WIDGETS: readonly TodayWidget[] = [
  summaryWidget,
  scheduleWidget,
  dueWidget,
  weatherWidget,
  pinnedNotesWidget,
  recentNotesWidget,
  birthdaysWidget,
];

/** Default order, and the set of ids a saved layout is reconciled against. */
export const WIDGET_IDS: readonly string[] = WIDGETS.map((w) => w.id);

export function findWidget(id: string): TodayWidget | undefined {
  return WIDGETS.find((w) => w.id === id);
}

export type { TodayWidget, TodayWidgetProps } from "./types";
