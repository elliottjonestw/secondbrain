// The note-image path against the real runtime.
//
// Scoped to what ONLY the packaged app can answer. Markdown transforms, the
// placeholder swap and the render path are covered far more cheaply in the
// browser backend; repeating them here is just slower. What is untestable
// anywhere else is `tauri-plugin-sql`'s JSON bridge: whether a few hundred KB
// of base64 survives a round trip through it, and what that costs.
//
// It calls the plugin's commands directly rather than importing `db.ts` — a
// release build has no `/src/db.ts` to import (that request returns the SPA
// fallback HTML), and going straight at the bridge is the more honest test of
// the bridge anyway.
//
// The body below is deliberately straight-line, with NO inner functions: wdio
// compiles this spec with esbuild, whose `keepNames` wraps every function in
// `__name(...)`, and that helper does not exist in the page — the failure is
// "Can't find variable: __name", which looks nothing like its cause.

describe("note images (real Tauri runtime)", () => {
  it("round-trips a large image through tauri-plugin-sql", async () => {
    const result = await browser.execute(async () => {
      const tauri = (window as unknown as {
        __TAURI_INTERNALS__: { invoke(cmd: string, args: unknown): Promise<unknown> };
      }).__TAURI_INTERNALS__;
      const db = "sqlite:secondbrain.db";
      await tauri.invoke("plugin:sql|load", { db });

      const noteId = `e2e-${Date.now()}`;
      const imageId = `${noteId}-img`;
      // ~400KB of base64 — what a 1600px photo actually encodes to.
      const data = "QUJDREVGR0g".repeat(40_000).slice(0, 400_000);
      const now = new Date().toISOString();

      await tauri.invoke("plugin:sql|execute", {
        db,
        query: "INSERT INTO notes (id, title, body, pinned, created_at, updated_at) VALUES (?,?,?,?,?,?)",
        values: [noteId, "e2e", `![x](sbimg:${imageId})`, 0, now, now],
      });

      const t0 = performance.now();
      await tauri.invoke("plugin:sql|execute", {
        db,
        query: "INSERT INTO note_images (id, note_id, mime, data, width, height, created_at) VALUES (?,?,?,?,?,?,?)",
        values: [imageId, noteId, "image/jpeg", data, 1600, 1200, now],
      });
      const writeMs = performance.now() - t0;

      const t1 = performance.now();
      const rows = (await tauri.invoke("plugin:sql|select", {
        db, query: "SELECT * FROM note_images WHERE id = ?", values: [imageId],
      })) as Record<string, unknown>[];
      const readMs = performance.now() - t1;

      // The whole point of the separate table: the note list must not pay for it.
      const t2 = performance.now();
      const notes = (await tauri.invoke("plugin:sql|select", {
        db, query: "SELECT * FROM notes", values: [],
      })) as Record<string, unknown>[];
      const listMs = performance.now() - t2;

      // Clean up — this is the user's real database.
      await tauri.invoke("plugin:sql|execute", {
        db, query: "DELETE FROM note_images WHERE note_id = ?", values: [noteId],
      });
      await tauri.invoke("plugin:sql|execute", {
        db, query: "DELETE FROM notes WHERE id = ?", values: [noteId],
      });
      const left = (await tauri.invoke("plugin:sql|select", {
        db, query: "SELECT count(*) AS n FROM note_images WHERE note_id = ?", values: [noteId],
      })) as { n: number }[];

      return {
        intact: rows[0]?.data === data,
        lengthBack: String(rows[0]?.data ?? "").length,
        noteCount: notes.length,
        writeMs: Math.round(writeMs),
        readMs: Math.round(readMs),
        listMs: Math.round(listMs),
        leftBehind: Number(left[0].n),
      };
    });

    console.log("bridge timings (ms):", JSON.stringify(result));
    expect(result.intact).toBe(true);          // base64 survives the bridge unaltered
    expect(result.lengthBack).toBe(400_000);   // and isn't truncated
    expect(result.leftBehind).toBe(0);         // cleanup works without a FK cascade
    expect(result.listMs).toBeLessThan(150);   // listNotes stays cheap beside a big image
  });
});
