// Internationalization. i18next + react-i18next, with catalogs bundled at build
// time rather than fetched — this is an offline desktop app, so there is no
// backend to load translations from.
//
// react-i18next's useTranslation() subscribes to i18next's `languageChanged`
// event, so switching language re-renders the tree on its own. That matters
// here: settings.ts is a plain localStorage store with no subscription
// mechanism, so without this we'd be hand-rolling one.

import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { enUS, zhTW } from "date-fns/locale";
import type { Locale } from "date-fns";
import { getSettings } from "./settings";
import { setDateLocale } from "./format";

import en from "../locales/en/app.json";
import zhHant from "../locales/zh-TW/app.json";

/** Languages the app ships catalogs for. `nativeName` is what the picker shows. */
export const LANGUAGES = [
  { code: "en", nativeName: "English" },
  { code: "zh-TW", nativeName: "繁體中文" },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]["code"];

/** The setting value meaning "follow the OS". */
export const SYSTEM_LANGUAGE = "system";

const DATE_LOCALES: Record<LanguageCode, Locale> = {
  en: enUS,
  "zh-TW": zhTW,
};

/**
 * Map an OS locale tag onto a language we ship.
 *
 * Only Traditional variants map to zh-TW: showing Traditional characters to a
 * Simplified reader is worse than showing English, so zh-CN/zh-Hans fall back
 * rather than being force-fitted.
 */
export function matchSystemLanguage(tag: string): LanguageCode {
  const lower = tag.toLowerCase();
  if (/^zh\b.*\b(hant|tw|hk|mo)\b/.test(lower.replace(/-/g, " "))) return "zh-TW";
  if (lower.startsWith("en")) return "en";
  return "en";
}

/** Resolve a stored preference ("system" | a code) to a concrete language. */
export function resolveLanguage(preference: string): LanguageCode {
  if (preference !== SYSTEM_LANGUAGE) {
    const known = LANGUAGES.find((l) => l.code === preference);
    if (known) return known.code;
  }
  return matchSystemLanguage(navigator.language || "en");
}

/**
 * Side effects that must follow the language but live outside React:
 * - `<html lang>` drives CJK glyph selection (without it a Traditional reader
 *   can get Japanese glyph variants for unified codepoints) and line breaking.
 * - date-fns needs its own locale object; format.ts holds it so the existing
 *   fmtTime(d)-style call sites keep their one-argument signatures.
 */
function applyLanguage(code: LanguageCode): void {
  document.documentElement.lang = code;
  setDateLocale(DATE_LOCALES[code] ?? enUS);
}

export async function initI18n(): Promise<void> {
  const initial = resolveLanguage(getSettings().language);

  await i18next.use(initReactI18next).init({
    resources: {
      en: { app: en },
      "zh-TW": { app: zhHant },
    },
    lng: initial,
    fallbackLng: "en",
    defaultNS: "app",
    ns: ["app"],
    interpolation: { escapeValue: false }, // React already escapes
    returnNull: false,
  });

  applyLanguage(initial);
  i18next.on("languageChanged", (lng) => applyLanguage(lng as LanguageCode));
}

/** Switch language at runtime. Views re-render via useTranslation(). */
export async function changeLanguage(preference: string): Promise<void> {
  await i18next.changeLanguage(resolveLanguage(preference));
}

/** The active language, for code outside React (voice, Whisper hints). */
export function currentLanguage(): LanguageCode {
  return (i18next.resolvedLanguage as LanguageCode) ?? "en";
}

export default i18next;
