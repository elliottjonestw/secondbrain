-- 001_init.sql — initial schema for Second Brain
-- Design notes:
--  * All syncable rows use TEXT UUID primary keys (= iCalendar UID).
--  * Events carry RFC 5545 fields directly (summary/dtstart/rrule/...).
--  * created_at / updated_at / sequence on every syncable row mirror
--    iCalendar SEQUENCE + CalDAV conflict resolution.
--  * Four domain tables stay separate; they connect via links + tags.
-- This migration is applied by tauri-plugin-sql (versioned, idempotent).

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Shared: tags + generic linking
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tags (
  id   TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS item_tags (
  tag_id     TEXT NOT NULL,
  item_type  TEXT NOT NULL,      -- 'event' | 'reminder' | 'todo' | 'note'
  item_id    TEXT NOT NULL,
  created_at TEXT,
  PRIMARY KEY (tag_id, item_type, item_id)
);
CREATE INDEX IF NOT EXISTS idx_item_tags_item ON item_tags(item_type, item_id);

CREATE TABLE IF NOT EXISTS links (
  id          TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,     -- 'event' | 'reminder' | 'todo' | 'note'
  source_id   TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  created_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_links_source ON links(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_type, target_id);

-- ---------------------------------------------------------------------------
-- Calendar events (iCalendar VEVENT shape)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,        -- UUID, = iCal UID
  summary     TEXT NOT NULL,
  description TEXT,
  location    TEXT,
  dtstart     TEXT NOT NULL,           -- ISO 8601
  dtend       TEXT,
  all_day     INTEGER NOT NULL DEFAULT 0,
  rrule       TEXT,                    -- RFC 5545 recurrence string
  exdates     TEXT,                    -- JSON array of excluded ISO dates
  status      TEXT NOT NULL DEFAULT 'CONFIRMED',
  categories  TEXT,                    -- JSON array
  color       TEXT,                    -- UI color for the category
  sequence    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT,
  updated_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_dtstart ON events(dtstart);

-- ---------------------------------------------------------------------------
-- Reminders (iCalendar VTODO-ish, alarm-driven)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reminders (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  notes          TEXT,
  due_at         TEXT,
  remind_at      TEXT,                 -- specific alert time
  rrule          TEXT,
  priority       INTEGER NOT NULL DEFAULT 0,
  completed      INTEGER NOT NULL DEFAULT 0,
  completed_at   TEXT,
  linked_todo_id TEXT,
  sequence       INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT,
  updated_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(due_at);
CREATE INDEX IF NOT EXISTS idx_reminders_remind ON reminders(remind_at);

-- ---------------------------------------------------------------------------
-- To-Do: lists + tasks (with subtasks via parent_todo_id)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lists (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL,
  color TEXT
);

CREATE TABLE IF NOT EXISTS todos (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  notes          TEXT,
  list_id        TEXT,
  due_at         TEXT,
  priority       INTEGER NOT NULL DEFAULT 0,
  completed      INTEGER NOT NULL DEFAULT 0,
  completed_at   TEXT,
  parent_todo_id TEXT,                 -- for subtasks
  position       INTEGER,
  sequence       INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT,
  updated_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_todos_list ON todos(list_id);
CREATE INDEX IF NOT EXISTS idx_todos_parent ON todos(parent_todo_id);
CREATE INDEX IF NOT EXISTS idx_todos_due ON todos(due_at);

-- ---------------------------------------------------------------------------
-- Notes (markdown) + full-text search via FTS5
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notes (
  id         TEXT PRIMARY KEY,
  title      TEXT,
  body       TEXT,                     -- markdown
  pinned     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT,
  updated_at TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  title, body,
  content='notes',
  content_rowid='rowid'
);

-- Keep the FTS index in sync with the notes table.
CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO notes_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

-- A default list so the To-Do UI always has somewhere to put tasks.
INSERT OR IGNORE INTO lists (id, name, color) VALUES ('default', 'Inbox', '#3b82f6');
