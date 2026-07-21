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
