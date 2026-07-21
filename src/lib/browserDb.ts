// In-memory SQLite for running the app OUTSIDE Tauri (`npm run dev`).
//
// The native app talks to SQLite through `tauri-plugin-sql`, which needs the
// Tauri runtime — in a plain browser `Database.load` throws and every view
// renders "Failed to open the database". That made the whole UI untestable in a
// browser, which is where automated UI checks are cheapest to run.
//
// This backend is DEV/TEST SCAFFOLDING, not a browser port:
//   - the data is in memory and re-seeded from the demo dataset on every load,
//     so nothing you do here persists;
//   - it is a *different* SQLite build (sql.js/wasm) reached through a
//     different binding layer, so it proves the SQL and the UI, NOT the
//     plugin's JSON bridge or anything else runtime-specific.
//
// It runs the real `src-tauri/migrations/*.sql`, so the schema has exactly one
// source of truth and can't drift from the native app.

import type { SqlDb } from "../db";

/** The migration files, inlined at build time and ordered by filename. */
const MIGRATIONS = import.meta.glob("../../src-tauri/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/**
 * Bind values SQLite accepts. Booleans matter: this schema stores them as 0/1
 * and the plugin coerces them, so the browser backend must too or every
 * `completed`/`pinned` write lands as the string "true".
 */
function bind(params: unknown[]): (string | number | null | Uint8Array)[] {
  return params.map((p) => {
    if (p === undefined || p === null) return null;
    if (typeof p === "boolean") return p ? 1 : 0;
    if (typeof p === "number" || typeof p === "string") return p;
    if (p instanceof Uint8Array) return p;
    return String(p);
  });
}

export async function loadBrowserDb(): Promise<SqlDb> {
  // Dynamically imported so the wasm never enters the Tauri bundle. The
  // official build is used rather than sql.js because the schema needs FTS5
  // (and 005 needs the trigram tokenizer, so SQLite >= 3.45) — sql.js ships
  // without the FTS5 module and fails on migration 001.
  const { default: sqlite3InitModule } = await import("@sqlite.org/sqlite-wasm");
  const sqlite3 = await sqlite3InitModule();
  const raw = new sqlite3.oo1.DB(":memory:");

  for (const path of Object.keys(MIGRATIONS).sort()) {
    raw.exec(MIGRATIONS[path]);
  }

  const api: SqlDb = {
    async select<T>(query: string, params: unknown[] = []): Promise<T> {
      return raw.exec({
        sql: query,
        bind: bind(params),
        rowMode: "object",
        returnValue: "resultRows",
      }) as T;
    },
    async execute(query: string, params: unknown[] = []) {
      raw.exec({ sql: query, bind: bind(params) });
      return { rowsAffected: raw.changes(), lastInsertId: 0 };
    },
  };

  // Handle for inspecting DB state from the devtools console during UI testing
  // — checking what a click actually wrote is otherwise invisible from outside.
  // Dev-only and browser-only: it does not exist in the packaged app.
  (globalThis as unknown as { __sbdb?: SqlDb }).__sbdb = api;

  return api;
}
