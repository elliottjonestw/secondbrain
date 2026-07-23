// Light/dark appearance.
//
// Tailwind is configured with `darkMode: "class"` rather than the default
// `media` strategy, because a *setting* has to be able to override the OS. The
// cost is that something must put the class on <html>, which is this module:
// `applyTheme()` resolves "system" through `matchMedia` and toggles it.
//
// Two things travel together and must not drift apart:
//
//  * the `dark` class, which every `dark:` utility in the app keys off, and
//  * `color-scheme`, which is what the *browser* renders natively — form
//    controls, scrollbars, and the date/time pickers the event and reminder
//    forms rely on. Setting only the class leaves a light date picker sitting
//    on a dark form.
//
// The preference lives in `settings.ts` like every other one, so it is scoped
// per signed-in account and is not part of the synced data model.

import { getSettings } from "./settings";

/** "system" follows the OS; the other two override it. */
export type ThemePreference = "system" | "light" | "dark";

export const THEME_PREFERENCES: ThemePreference[] = ["system", "light", "dark"];

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** What the OS is currently asking for. */
export function systemTheme(): "light" | "dark" {
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

/** The preference resolved against the OS — i.e. what to actually render. */
export function resolveTheme(pref: ThemePreference): "light" | "dark" {
  return pref === "system" ? systemTheme() : pref;
}

/**
 * Put the stored preference (or an explicit one) on the document.
 *
 * Called at boot before the first render, and again whenever the setting
 * changes. Idempotent, so calling it more often than necessary is free.
 */
export function applyTheme(pref: ThemePreference = getSettings().theme): void {
  const resolved = resolveTheme(pref);
  document.documentElement.classList.toggle("dark", resolved === "dark");
  // Not `light dark`: naming both hands the choice back to the OS, which is
  // exactly what an explicit preference is overriding.
  document.documentElement.style.colorScheme = resolved;
}

/**
 * Keep "system" live: the OS can flip while the app is open (macOS does it on a
 * schedule), and a preference that only reads the OS at boot would go stale
 * until the next reload. A no-op while an explicit theme is set, because
 * `applyTheme` re-reads the preference and ignores the query.
 *
 * Returns an unsubscribe function; call it from an effect's cleanup.
 *
 * Not reproducible in DevTools: toggling the emulated colour scheme changes
 * what `matches` reports but fires no `change` event at all (verified with a
 * control listener), and you can't dispatch one by hand either — `matchMedia`
 * hands back a *new* MediaQueryList per call, so an event dispatched on your
 * instance never reaches the listener registered on this one. Real OS changes
 * notify every live list. Don't "fix" this after failing to reproduce it.
 */
export function watchSystemTheme(): () => void {
  const mq = window.matchMedia(DARK_QUERY);
  const onChange = () => applyTheme();
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}
