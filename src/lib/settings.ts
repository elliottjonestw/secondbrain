// App settings, persisted in localStorage. Kept out of the SQLite data file on
// purpose: the demo-reset wipes the database but must NOT erase the user's API
// key, and settings aren't part of the syncable calendar data model.

export interface AppSettings {
  openaiApiKey: string;
  openaiModel: string;
  /** Speech-to-text model used for voice input. */
  sttModel: string;
}

const KEY = "secondbrain.settings";

const DEFAULTS: AppSettings = {
  openaiApiKey: "",
  openaiModel: "gpt-4o-mini",
  sttModel: "whisper-1",
};

export function getSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...getSettings(), ...patch };
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}

export function hasApiKey(): boolean {
  return getSettings().openaiApiKey.trim().length > 0;
}

// ---------------------------------------------------------------------------
// Calendar accounts (CalDAV)
//
// Which calendars exist, which are visible, and which is the default is
// *configuration*, not calendar data — and remote events are never stored in
// SQLite — so all of it lives here in localStorage rather than in the DB. Same
// trade-off as the OpenAI key: the app-specific password is stored in plain
// text on this device. Kept under its own key so the shape can grow without
// disturbing AppSettings.
// ---------------------------------------------------------------------------

/** A calendar collection discovered on a CalDAV server. */
export interface CalDavCalendar {
  id: string; // stable identity = the collection href
  href: string; // absolute URL of the calendar collection
  displayName: string;
  color: string | null; // from CalDAV calendar-color, else a fallback
  visible: boolean;
  supportsVEVENT: boolean;
  readOnly: boolean;
}

export interface CalDavAccount {
  provider: "icloud"; // future: "google" | "fastmail" | "generic"
  username: string; // Apple ID
  appPassword: string; // app-specific password (2FA accounts require one)
  principalUrl?: string; // discovered
  calendarHomeUrl?: string; // discovered
  calendars: CalDavCalendar[]; // discovered, cached here
}

export interface CalendarSettings {
  account: CalDavAccount | null;
  localVisible: boolean; // show the built-in Second Brain calendar
  defaultCalendarId: string; // where new events land — "local" or a calendar id
}

const CAL_KEY = "secondbrain.calendars";

const CAL_DEFAULTS: CalendarSettings = {
  account: null,
  localVisible: true,
  defaultCalendarId: "local",
};

export function getCalendarSettings(): CalendarSettings {
  try {
    const raw = localStorage.getItem(CAL_KEY);
    if (!raw) return { ...CAL_DEFAULTS };
    return { ...CAL_DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...CAL_DEFAULTS };
  }
}

export function saveCalendarSettings(patch: Partial<CalendarSettings>): CalendarSettings {
  const next = { ...getCalendarSettings(), ...patch };
  localStorage.setItem(CAL_KEY, JSON.stringify(next));
  return next;
}

/** Replace the stored calendar list for the connected account (e.g. after a
 * visibility toggle or a re-discovery). No-op when nothing is connected. */
export function saveAccountCalendars(calendars: CalDavCalendar[]): CalendarSettings {
  const s = getCalendarSettings();
  if (!s.account) return s;
  return saveCalendarSettings({ account: { ...s.account, calendars } });
}

export function hasCalendarAccount(): boolean {
  const s = getCalendarSettings();
  return !!s.account && s.account.calendars.length > 0;
}
