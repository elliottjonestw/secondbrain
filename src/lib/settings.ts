// App settings, persisted in localStorage. Kept out of the SQLite data file on
// purpose: the demo-reset wipes the database but must NOT erase the user's API
// key, and settings aren't part of the syncable calendar data model.

/** Where the assistant's *text* model runs. Voice/STT is always OpenAI. */
export type AssistantProvider = "openai" | "ollama";

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
  /** Which backend answers the text assistant. */
  assistantProvider: AssistantProvider;
  openaiApiKey: string;
  openaiModel: string;
  /** Base URL of a local Ollama server (OpenAI-compatible endpoint). */
  ollamaBaseUrl: string;
  /** Ollama model tag, e.g. "llama3.1". Must be a tools-capable model. */
  ollamaModel: string;
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

const KEY = "secondbrain.settings";

/** Default Ollama address. Only the port is realistically customised. */
export const DEFAULT_OLLAMA_URL = "http://localhost:11434";

const DEFAULTS: AppSettings = {
  assistantProvider: "openai",
  openaiApiKey: "",
  openaiModel: "gpt-4o-mini",
  ollamaBaseUrl: DEFAULT_OLLAMA_URL,
  ollamaModel: "",
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

/**
 * Is an OpenAI key present? This gates the OpenAI text assistant AND *all* voice
 * transcription — Ollama can't transcribe, so voice input needs an OpenAI key
 * regardless of which provider answers the text assistant.
 */
export function hasOpenAiKey(): boolean {
  return getSettings().openaiApiKey.trim().length > 0;
}

/** Is the text assistant usable with the currently selected provider? */
export function isAssistantConfigured(): boolean {
  const s = getSettings();
  return s.assistantProvider === "ollama"
    ? s.ollamaBaseUrl.trim().length > 0 && s.ollamaModel.trim().length > 0
    : s.openaiApiKey.trim().length > 0;
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
