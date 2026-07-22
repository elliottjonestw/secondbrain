/**
 * Platform detection, split out from db.ts so the API client can import it
 * without creating a cycle (db.ts → api.ts → db.ts).
 */

/** True inside the Tauri webview; false under `npm run dev` in a browser. */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
