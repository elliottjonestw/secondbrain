-- Images embedded in notes.
--
-- The bytes deliberately do NOT live in `notes.body`, even though the markdown
-- reference does. Two reasons, both load-bearing:
--
--   1. `listNotes` is `SELECT *` and runs on every keystroke in the search box.
--      A data URI in the body means every image of every note is re-read to
--      draw the sidebar list.
--   2. `notes_fts` is a *trigram* index (005). Indexing every 3-character
--      window of a base64 blob would dwarf the note text it exists to search.
--
-- So the body holds `![alt](sbimg:<id>)` and the bytes are fetched by id, once,
-- only by the preview that actually renders them.
--
-- No FOREIGN KEY, matching the rest of the schema: `PRAGMA foreign_keys` is a
-- per-connection setting, and the one in 001 applies to the migration
-- connection only — not to the runtime one the app opens later. Children are
-- deleted explicitly in db.ts (see `deleteTodo` doing the same for subtasks).

CREATE TABLE note_images (
  id         TEXT PRIMARY KEY,   -- UUID; the `sbimg:` reference in the markdown
  note_id    TEXT NOT NULL,      -- owning note; cleaned up by deleteNote()
  mime       TEXT NOT NULL,
  data       TEXT NOT NULL,      -- base64 payload, no `data:` prefix
  width      INTEGER NOT NULL,   -- intrinsic size, stored so the preview can
  height     INTEGER NOT NULL,   -- reserve space instead of reflowing on decode
  created_at TEXT NOT NULL
);

CREATE INDEX idx_note_images_note ON note_images(note_id);
