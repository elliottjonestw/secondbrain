// App settings, persisted in localStorage, scoped per signed-in account (see
// the note on KEY). Kept out of the database on purpose: "clear all data" must
// not erase the user's API key, and settings aren't part of the syncable
// calendar data model — which also means they don't follow you to a new device.
//
// The authStore import is safe in both directions: authStore depends only on
// @secondbrain/shared, so this cannot close a cycle.

import { getCachedSession } from "./authStore";
import type { ThemePreference } from "./theme";

/** Which text-to-speech engine speaks assistant replies. */
export type TtsEngine = "openai" | "system";

/** Bounds for `speechRate`. Both engines behave sensibly across this range. */
export const MIN_SPEECH_RATE = 0.5;
export const MAX_SPEECH_RATE = 2;

export function clampSpeechRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1;
  return Math.min(MAX_SPEECH_RATE, Math.max(MIN_SPEECH_RATE, rate));
}

export interface AppSettings {
  openaiApiKey: string;
  openaiModel: string;
  /** Speech-to-text model used for voice input. */
  sttModel: string;
  /**
   * Which engine speaks replies. "openai" is neural voices over the network
   * (billed); "system" is the OS's offline voices. Either way the system voice
   * below is the fallback, so a reply is never lost to a network problem.
   */
  ttsEngine: TtsEngine;
  /** Text-to-speech model used for spoken replies. */
  ttsModel: string;
  /**
   * Chosen OpenAI voice. A single setting rather than one per language: these
   * voices are multilingual, so the same voice reads both English and Chinese.
   * (System voices are the opposite — each one speaks a single language — which
   * is why `preferredVoices` below stays a per-language map.)
   */
  openaiVoice: string;
  /** Speaking rate multiplier, 1 = normal. Applies to both engines. */
  speechRate: number;
  /**
   * Chosen *system* voice per speech language, as BCP 47 tag → voiceURI.
   * Empty/absent means "let the app pick the best installed voice".
   */
  preferredVoices: Record<string, string>;
  /** UI language: "system" to follow the OS, or a code from lib/i18n LANGUAGES. */
  language: string;
  /**
   * Light or dark appearance, or "system" to follow the OS. Applied by
   * `lib/theme.ts`, which owns the `dark` class on <html> — Tailwind is on the
   * class strategy precisely so this setting can override the OS.
   */
  theme: ThemePreference;
  /**
   * Where to show the weather for, or null for "don't". Resolved once by the
   * Settings place search and stored whole: the Today tile then needs no
   * geocoding lookup, so a place that has been chosen keeps working offline
   * right up to the forecast call itself.
   */
  weatherLocation: WeatherLocation | null;
  /** Temperature unit for the weather tile. Open-Meteo converts server-side. */
  temperatureUnit: TemperatureUnit;
  /**
   * Symbols on the Today ticker, in the order they're shown. Empty means the
   * card doesn't render at all — like the weather tile with no location, an
   * empty ticker would just be a standing advert for a setting.
   *
   * Resolved whole by the Settings picker (ticker *and* display name), so the
   * card never has to look a symbol up before it can draw a row.
   */
  watchlist: StockSymbol[];
  /**
   * Order and visibility of the Today page's cards. Stored as the user arranged
   * it, NOT as the complete truth — read it through `mergeTodayLayout`, which
   * drops ids the app no longer has and appends ones it has gained. An empty
   * array means "never customised", i.e. every card in its default order.
   */
  todayLayout: TodayCardPref[];
  /**
   * Hold the Today page's "Your day" briefing for `summaryMaxAgeHours` after it
   * was written, instead of rewriting it whenever the day's facts change. Purely
   * a spend control — that card is the app's only *automatic* billed request, so
   * ticking off four todos otherwise buys four summaries. Off means the old
   * behaviour: any change to the day regenerates. The refresh button ignores
   * this either way.
   */
  summaryThrottle: boolean;
  /** How long a written briefing stays good for, in hours. */
  summaryMaxAgeHours: number;
}

export const MIN_SUMMARY_MAX_AGE_HOURS = 1;
export const MAX_SUMMARY_MAX_AGE_HOURS = 168; // a week

export function clampSummaryMaxAge(hours: number): number {
  if (!Number.isFinite(hours)) return DEFAULTS.summaryMaxAgeHours;
  return Math.min(MAX_SUMMARY_MAX_AGE_HOURS, Math.max(MIN_SUMMARY_MAX_AGE_HOURS, Math.round(hours)));
}

/**
 * How long a cached briefing may be reused even after the day's facts change,
 * in ms. 0 when the throttle is off, i.e. only an exact fact match is reusable.
 */
export function summaryMaxAgeMs(): number {
  const s = getSettings();
  return s.summaryThrottle ? clampSummaryMaxAge(s.summaryMaxAgeHours) * 3600_000 : 0;
}

/** One card's placement on the Today page. Order is the array's own order. */
export interface TodayCardPref {
  id: string;
  hidden: boolean;
}

/**
 * Reconcile a stored layout with the cards this build actually has.
 *
 * Storage is a *preference*, not an inventory: a card added in a later version
 * must show up for someone who arranged their page in an earlier one, and a
 * card that's been removed must not linger as a dead row in the editor. So
 * known ids keep their saved order and visibility, unknown ids are dropped, and
 * anything missing is appended visible.
 */
export function mergeTodayLayout(stored: TodayCardPref[], known: readonly string[]): TodayCardPref[] {
  const valid = stored.filter((p) => known.includes(p.id));
  const seen = new Set(valid.map((p) => p.id));
  return [...valid, ...known.filter((id) => !seen.has(id)).map((id) => ({ id, hidden: false }))];
}

export type TemperatureUnit = "celsius" | "fahrenheit";

/**
 * An instrument chosen in Settings. Lives here rather than in `stocks.ts` for
 * the same reason `WeatherLocation` does: it's the stored *configuration*, and
 * keeping it on this side means the provider module depends on settings and
 * never the other way round.
 */
export interface StockSymbol {
  /** Ticker as the quote service knows it, e.g. "AAPL", "0700.HK", "^GSPC". */
  symbol: string;
  /** Display name resolved once at pick time, e.g. "Apple Inc.". */
  name: string;
}

/** A place chosen in Settings, as returned by the geocoding search. */
export interface WeatherLocation {
  /** Display name, e.g. "Taipei". */
  name: string;
  /** Region/country for disambiguation in the UI, e.g. "Taiwan". */
  country: string;
  latitude: number;
  longitude: number;
}

/**
 * Settings are stored PER ACCOUNT, not per device.
 *
 * They used to be one shared bucket, which was harmless when the app had a
 * single user and no accounts. It stopped being harmless the moment anyone
 * could sign out and someone else could register on the same machine: the
 * second person inherited the first person's OpenAI API key and their iCloud
 * app-specific password, because a new account never cleared localStorage.
 *
 * Namespacing by user id fixes that, and also means a shared device keeps each
 * person's weather location, watchlist and Today layout separate.
 *
 * Signed out, reads and writes go to an `anon` bucket. That is why the login
 * screen shows the default language rather than the last user's: a preference
 * is not worth leaking which account was last used on a shared machine.
 *
 * **This is isolation, not secrecy.** Everything here is still plaintext in
 * localStorage, readable from devtools by anyone at the keyboard and by any
 * XSS on the origin. The real fix for the two secret-bearing values is the OS
 * keychain (see the note in `authStore.ts`), and on the web build it is not to
 * hold them at all.
 */
const KEY = "secondbrain.settings";

/** The signed-in user's id, or null. Read through authStore so this module
 *  never has to know how a session is persisted. */
function currentUserId(): string | null {
  return getCachedSession()?.user?.id ?? null;
}

/**
 * The storage key for this account, migrating the pre-account bucket into it
 * on first touch.
 *
 * The migration is lazy rather than a step in the sign-in flow because it must
 * hold whatever order things load in: whoever reads settings first after an
 * upgrade adopts the old values, and the shared copy is removed so no later
 * account can inherit it.
 */
function scopedKey(base: string): string {
  const uid = currentUserId();
  const key = `${base}.${uid ?? "anon"}`;
  if (uid) {
    const legacy = localStorage.getItem(base);
    if (legacy !== null) {
      // Don't clobber a bucket this account already has.
      if (localStorage.getItem(key) === null) localStorage.setItem(key, legacy);
      localStorage.removeItem(base);
    }
  }
  return key;
}

const DEFAULTS: AppSettings = {
  openaiApiKey: "",
  openaiModel: "gpt-4o-mini",
  sttModel: "whisper-1",
  // Natural voices by default — they're the reason this setting exists. Safe as
  // a default even though they're billed: a spoken reply only happens after
  // *speech input*, which already needs an OpenAI key for Whisper. With no key
  // it falls back to the system voice rather than failing.
  ttsEngine: "openai",
  ttsModel: "gpt-4o-mini-tts",
  openaiVoice: "",
  speechRate: 1,
  preferredVoices: {},
  language: "system",
  // Follow the OS unless told otherwise, same rule as the language.
  theme: "system",
  // A fresh install gets a populated weather tile and ticker rather than two
  // cards advertising a setting. Both are ordinary values the user can change
  // or clear in Settings; clearing sticks, because a stored settings object
  // overrides these defaults key by key.
  weatherLocation: { name: "New York", country: "United States", latitude: 40.7128, longitude: -74.006 },
  temperatureUnit: "celsius",
  watchlist: [
    { symbol: "AAPL", name: "Apple Inc." },
    { symbol: "GOOGL", name: "Alphabet Inc." },
  ],
  todayLayout: [],
  summaryThrottle: true,
  summaryMaxAgeHours: 6,
};

export function getSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(scopedKey(KEY));
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...getSettings(), ...patch };
  localStorage.setItem(scopedKey(KEY), JSON.stringify(next));
  return next;
}

/**
 * Is an OpenAI key present? This gates the text assistant AND all voice
 * transcription — both run on OpenAI.
 */
export function hasOpenAiKey(): boolean {
  return getSettings().openaiApiKey.trim().length > 0;
}

/** Is the text assistant usable? The assistant runs on OpenAI, so a key is all
 *  it needs. */
export function isAssistantConfigured(): boolean {
  return hasOpenAiKey();
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
  localVisible: boolean; // show the built-in Sekunda calendar
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
    const raw = localStorage.getItem(scopedKey(CAL_KEY));
    if (!raw) return { ...CAL_DEFAULTS };
    return { ...CAL_DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...CAL_DEFAULTS };
  }
}

export function saveCalendarSettings(patch: Partial<CalendarSettings>): CalendarSettings {
  const next = { ...getCalendarSettings(), ...patch };
  localStorage.setItem(scopedKey(CAL_KEY), JSON.stringify(next));
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
