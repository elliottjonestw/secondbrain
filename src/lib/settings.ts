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
