-- 0001_init.sql — Second Brain, Cloudflare D1 schema.
--
-- This is a SQUASH of src-tauri/migrations/001..007 plus multi-tenancy. It is
-- deliberately not a replay of those seven migrations: the local SQLite data
-- they built is disposable (see docs/cloud-migration-plan.md §1), so there is
-- no history worth preserving and no reason to debug a seven-step chain on a
-- new platform.
--
-- Differences from the local schema, each load-bearing:
--
--  * Every domain row carries `space_id`, not `user_id`. Sharing between
--    accounts is planned; with `space_id` that is one space_members insert (or
--    one additive `shares` table), whereas `owner_id` would mean altering all
--    eleven domain tables and rewriting every endpoint's WHERE clause.
--
--  * Every UNIQUE that was global is now per-space. `tags.name` and
--    `lists.name` were globally unique locally, which is correct for one user
--    and a cross-tenant collision here: the first account to create a tag
--    named "work" would permanently stop every other account from doing so,
--    surfacing as an unrelated write error.
--
--  * No PRAGMA foreign_keys. It was a no-op locally (it applies per
--    connection, and 001's applied only to the migration connection), D1
--    rejects it, and children are still deleted explicitly in the Worker.
--    There are no FOREIGN KEY constraints anywhere, matching the local schema.
--
--  * No seeded lists. 002 seeded lists with the fixed ids 'personal'/'work';
--    fixed ids cannot be shared across tenants. Default lists are created per
--    space at registration time (the Worker's space provisioning), which is
--    where ensureDefaultLists' invariant now lives.
--
--  * `notes_fts` is created with the trigram tokenizer directly. 005 had to
--    DROP and rebuild because it was altering a populated index; a fresh
--    database just declares it.
--
--  * created_at / updated_at are NOT NULL. The Worker always sets them —
--    clock skew between a user's devices would corrupt them, so they are
--    server-generated — which makes a nullable column a bug detector we don't
--    need.
--
--  * note_images stores an R2 object key, never the bytes. D1 caps any row at
--    2 MB, so the local `data TEXT` base64 column cannot survive. Wiring the
--    R2 upload/stream path is M4; the schema is R2-shaped from the start so
--    that milestone is not also a data migration.

-- ---------------------------------------------------------------------------
-- Identity: users, spaces, membership, sessions
-- ---------------------------------------------------------------------------

-- Passwords use a CLIENT-side KDF plus a SERVER-side verifier, not a
-- server-side argon2id. The Workers free plan caps CPU at 10 ms per request
-- and a correctly tuned argon2id costs 50–150 ms by design, so the choice was
-- to move the work or to weaken it. Moving it costs nothing:
--
--   client:  dk = argon2id(password, kdf_salt, kdf_params)      -- slow, ~100ms
--   wire:    dk                                                 -- over TLS
--   server:  verifier = sha256(verifier_salt || dk || PEPPER)   -- fast, ~0.01ms
--
-- An attacker holding this table still has to run the full argon2id per guess,
-- so offline-cracking resistance is unchanged. The server-side hash is what
-- stops a database dump from being directly replayable as a login: `dk` is
-- password-equivalent, so it must never be what's stored.
--
-- kdf_salt and kdf_params are necessarily PUBLIC — a client has to fetch them
-- before it can derive anything — which is why the verifier has its own
-- separate, server-generated salt.
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL,           -- as the user typed it, for display
  email_norm    TEXT NOT NULL UNIQUE,    -- lowercased + NFC; the lookup key
  kdf_salt      TEXT NOT NULL,           -- base64, >=16 bytes, client-generated
  kdf_params    TEXT NOT NULL,           -- JSON {alg,m,t,p}; floor enforced server-side
  verifier_salt TEXT NOT NULL,           -- base64, 16 bytes, server-generated
  verifier_hash TEXT NOT NULL,           -- base64 sha-256
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE spaces (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Membership is the only thing that grants access to a space's rows.
-- role: 'owner' | 'editor' | 'viewer'
CREATE TABLE space_members (
  space_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (space_id, user_id)
);
CREATE INDEX idx_space_members_user ON space_members(user_id);

-- Refresh-token sessions. Access tokens are stateless JWTs and are not stored.
-- Tokens are stored HASHED: a leaked database read must not yield usable
-- credentials. `family_id` + `replaced_by` implement rotation with theft
-- detection — presenting an already-rotated token revokes the whole family.
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  family_id    TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,   -- sha-256 of the refresh token
  replaced_by  TEXT,                   -- session id that rotated this one
  device_label TEXT,
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT,
  last_used_at TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_family ON sessions(family_id);

-- ---------------------------------------------------------------------------
-- Shared: tags + generic linking
-- ---------------------------------------------------------------------------

CREATE TABLE tags (
  id       TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  name     TEXT NOT NULL
);
-- Was `name TEXT UNIQUE` in 001. Per-space, or one tenant's tag blocks every
-- other tenant's. Names arrive NFC-normalized (normalizeKey), applied
-- server-side because a client-side-only normalization is unenforceable once
-- several clients exist and macOS IMEs emit NFD.
CREATE UNIQUE INDEX idx_tags_space_name ON tags(space_id, name);

CREATE TABLE item_tags (
  tag_id     TEXT NOT NULL,
  space_id   TEXT NOT NULL,
  item_type  TEXT NOT NULL,   -- 'event' | 'reminder' | 'todo' | 'note' | 'person'
  item_id    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tag_id, item_type, item_id)
);
CREATE INDEX idx_item_tags_item ON item_tags(space_id, item_type, item_id);

CREATE TABLE links (
  id          TEXT PRIMARY KEY,
  space_id    TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id   TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_links_source ON links(space_id, source_type, source_id);
CREATE INDEX idx_links_target ON links(space_id, target_type, target_id);

-- ---------------------------------------------------------------------------
-- Calendar events (iCalendar VEVENT shape; id doubles as the iCal UID)
-- ---------------------------------------------------------------------------

CREATE TABLE events (
  id          TEXT PRIMARY KEY,
  space_id    TEXT NOT NULL,
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
  color       TEXT,
  sequence    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_events_dtstart ON events(space_id, dtstart);

-- ---------------------------------------------------------------------------
-- Reminders
-- ---------------------------------------------------------------------------

CREATE TABLE reminders (
  id             TEXT PRIMARY KEY,
  space_id       TEXT NOT NULL,
  title          TEXT NOT NULL,
  notes          TEXT,
  due_at         TEXT,
  remind_at      TEXT,
  rrule          TEXT,
  priority       INTEGER NOT NULL DEFAULT 0,
  completed      INTEGER NOT NULL DEFAULT 0,
  completed_at   TEXT,
  linked_todo_id TEXT,
  sequence       INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX idx_reminders_due ON reminders(space_id, due_at);
CREATE INDEX idx_reminders_remind ON reminders(space_id, remind_at);

-- ---------------------------------------------------------------------------
-- To-Do: lists + tasks (subtasks via parent_todo_id)
-- ---------------------------------------------------------------------------

CREATE TABLE lists (
  id       TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  name     TEXT NOT NULL,
  color    TEXT
);
-- 007's idx_lists_name_nocase, scoped. NOCASE folds ASCII only — the same
-- limitation the app already documents for collation — so non-ASCII names are
-- compared byte-wise, which is why they are NFC-normalized on the way in.
CREATE UNIQUE INDEX idx_lists_space_name_nocase ON lists(space_id, name COLLATE NOCASE);

CREATE TABLE todos (
  id             TEXT PRIMARY KEY,
  space_id       TEXT NOT NULL,
  title          TEXT NOT NULL,
  notes          TEXT,
  list_id        TEXT,
  due_at         TEXT,
  priority       INTEGER NOT NULL DEFAULT 0,
  completed      INTEGER NOT NULL DEFAULT 0,
  completed_at   TEXT,
  parent_todo_id TEXT,
  position       INTEGER,
  sequence       INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX idx_todos_list ON todos(space_id, list_id);
CREATE INDEX idx_todos_parent ON todos(space_id, parent_todo_id);
CREATE INDEX idx_todos_due ON todos(space_id, due_at);

-- ---------------------------------------------------------------------------
-- Notes (markdown) + full-text search
-- ---------------------------------------------------------------------------

CREATE TABLE notes (
  id         TEXT PRIMARY KEY,
  space_id   TEXT NOT NULL,
  title      TEXT,
  body       TEXT,                     -- markdown; images are `sbimg:<id>` refs
  pinned     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_notes_space ON notes(space_id);

-- trigram, not unicode61: CJK writing has no spaces, so unicode61 indexed an
-- entire CJK sentence as ONE token and a search for a word inside it returned
-- nothing — while FTS5 accepts any codepoint > 127 as a bareword, so the query
-- parsed fine and silently matched no rows. trigram indexes every 3-character
-- window. `remove_diacritics 1` keeps the accent folding unicode61 gave for
-- free ("cafe" finds "Café"); without it, fixing Chinese would quietly regress
-- French and Spanish.
--
-- CALLERS: trigram cannot answer queries shorter than 3 characters, and the
-- commonest Chinese words are exactly 2 (北京, 會議, 預算). The Worker routes
-- queries under 3 characters to LIKE instead. Both paths must exist and both
-- must AND the terms.
--
-- TENANCY: this index carries no space_id. Every query MUST join back to
-- `notes` and filter `notes.space_id = ?`, or it leaks other tenants' note
-- text through search. That join lives in exactly one function in the Worker.
CREATE VIRTUAL TABLE notes_fts USING fts5(
  title, body,
  content='notes',
  content_rowid='rowid',
  tokenize='trigram remove_diacritics 1'
);

CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
END;
CREATE TRIGGER notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO notes_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

-- Image metadata only. The bytes live in R2 under `r2_key`; the note body
-- still holds `![alt](sbimg:<id>)`, so the ReactMarkdown img/urlTransform
-- pairing and the assistant prompt's "preserve sbimg: refs verbatim" rule are
-- both unchanged. width/height are stored so the preview reserves space
-- instead of reflowing on decode.
CREATE TABLE note_images (
  id         TEXT PRIMARY KEY,   -- UUID; the `sbimg:` reference in the markdown
  space_id   TEXT NOT NULL,
  note_id    TEXT NOT NULL,      -- owning note; deleted explicitly by deleteNote
  mime       TEXT NOT NULL,
  r2_key     TEXT NOT NULL,      -- spaces/<space_id>/notes/<note_id>/<image_id>
  byte_size  INTEGER NOT NULL,
  width      INTEGER NOT NULL,
  height     INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_note_images_note ON note_images(space_id, note_id);

-- ---------------------------------------------------------------------------
-- People (vCard 4.0 shape; id doubles as the vCard UID)
-- ---------------------------------------------------------------------------

CREATE TABLE people (
  id                TEXT PRIMARY KEY,
  space_id          TEXT NOT NULL,
  full_name         TEXT NOT NULL,      -- vCard FN
  given_name        TEXT,               -- vCard N components
  family_name       TEXT,
  additional_names  TEXT,
  honorific_prefix  TEXT,
  honorific_suffix  TEXT,
  nickname          TEXT,
  emails            TEXT,               -- JSON [{type,value,primary?}]
  phones            TEXT,               -- JSON [{type,value,primary?}]
  addresses         TEXT,               -- JSON [{type,street,city,...}]
  organization      TEXT,
  title             TEXT,
  birthday          TEXT,               -- ISO date
  urls              TEXT,               -- JSON [{type,value}]
  notes             TEXT,
  photo             TEXT,
  custom_fields     TEXT,               -- JSON [{label,value}]
  favorite          INTEGER NOT NULL DEFAULT 0,
  sequence          INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_people_full_name ON people(space_id, full_name);

-- The shared, ordered registry of custom-field LABELS. Each person's value for
-- a label lives in that person's people.custom_fields JSON, so the vCard X-
-- mapping is unchanged.
CREATE TABLE person_custom_fields (
  id       TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  label    TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);
-- New constraint: the local schema enforced this only in application code
-- (ensureCustomField's COLLATE NOCASE lookup). Making it a real index matches
-- lists and closes the check-then-insert race that two devices can now hit.
CREATE UNIQUE INDEX idx_person_custom_fields_label ON person_custom_fields(space_id, label COLLATE NOCASE);
