// Local-data helpers. Historically this also seeded a demo dataset, but every
// domain is remote now (M2–M4), so there is nothing local left to seed.

import {
  db,
  DATA_TABLES,
} from "../db";

/** Remove every row from every LOCAL user table. Post-migration this only
 *  reaches note-image bytes (still local until M4b) and otherwise-empty tables;
 *  it does NOT clear the account's remote data. Settings' "clear all data" uses
 *  it, and it will be reworked into a server-side wipe alongside backup. */
export async function clearAllData(): Promise<void> {
  const d = await db();
  for (const table of DATA_TABLES) {
    await d.execute(`DELETE FROM ${table}`);
  }
}

/**
 * Retired. It used to wipe and re-seed a demo dataset, and it still runs on
 * every browser dev load — but with all domains remote, seeding here would
 * write to the signed-in account (or throw before sign-in). It now does
 * nothing; the demo easter egg and the whole browserDb demo path go away in the
 * migration's finale. Kept as a no-op so its callers still compile.
 */
export async function resetAndSeedDemo(): Promise<void> {
  /* no-op — see the doc comment */
}
