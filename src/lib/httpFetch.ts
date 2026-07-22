/**
 * The one way this app reaches an EXTERNAL host (OpenAI, Open-Meteo, Yahoo,
 * iCloud). `lib/api.ts` has its own copy of this pick for the Worker, because
 * it also owns auth, retries and offline detection; everything else comes here.
 *
 * Inside Tauri the webview's own `fetch` is blocked by CORS from
 * `tauri://localhost`, so requests must go through `tauri-plugin-http` (which
 * runs in Rust, outside the browser's origin rules) and the host must be scoped
 * in `capabilities/default.json`. In a browser or on mobile the plugin doesn't
 * exist — calling it invokes an IPC command that isn't there — so the native
 * `fetch` is the only option.
 *
 * Resolved at runtime, never imported at the top, because a static
 * `import { fetch } from "@tauri-apps/plugin-http"` is exactly what made the
 * web build fail: the module loads fine and then every call throws.
 *
 * **This does not make every feature work on the web.** It removes the Tauri
 * dependency; it cannot remove the browser's origin rules, and the plugin was
 * doing double duty as a CORS bypass. On the web each host is subject to its
 * own CORS policy:
 *
 *   - Open-Meteo sends `Access-Control-Allow-Origin: *` — weather works.
 *   - OpenAI allows browser requests — the assistant and TTS work, though the
 *     API key is then exposed to anything running on the page.
 *   - Yahoo's quote endpoint sends no CORS headers — stocks cannot work on the
 *     web without a proxy.
 *   - iCloud CalDAV sends no CORS headers — connected calendars cannot work on
 *     the web without a proxy.
 *
 * The honest fix for the last two is a proxy route on the Worker. Until then
 * they are desktop-only, and `isTauri()` is what a caller should branch on if
 * it wants to hide the feature rather than let it fail.
 */
import { isTauri } from "./platform";

/**
 * `RequestInit` plus the plugin-only options this app actually uses.
 *
 * `maxRedirections` is not a web `fetch` option and has no equivalent: the
 * browser follows redirects itself and gives no hook to re-sign each hop. It
 * matters to `caldav/client.ts`, which sets it to 0 because `reqwest` drops
 * `Authorization` across hosts and iCloud always redirects to a per-user shard.
 * On the web it is simply inert — which is survivable only because CalDAV can't
 * reach iCloud from a browser anyway (no CORS headers), so that code path is
 * desktop-only regardless. Do not "clean this up" by deleting the option.
 */
export type HttpFetchInit = RequestInit & {
  maxRedirections?: number;
  /** Plugin-only; the web fetch has no connect-phase timeout at all. */
  connectTimeout?: number;
};

export async function httpFetch(input: string, init?: HttpFetchInit): Promise<Response> {
  if (isTauri()) {
    const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
    return tauriFetch(input, init);
  }
  // Strip the plugin-only keys rather than passing them to a spec-compliant
  // fetch, which is free to reject unknown members.
  const { maxRedirections: _maxRedirections, connectTimeout: _connectTimeout, ...webInit } = init ?? {};
  return fetch(input, webInit);
}
