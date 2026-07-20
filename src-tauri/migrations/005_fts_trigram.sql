-- Rebuild the notes full-text index with the trigram tokenizer.
--
-- The default tokenizer (unicode61) classifies Han/Kana/Hangul as letters, and
-- CJK writing has no spaces between words — so an entire CJK sentence was
-- indexed as ONE token. Searching a word inside it returned nothing, and the
-- LIKE fallback in db.ts never fired because FTS5 accepts any codepoint > 127
-- as a bareword: the query parsed fine and simply matched no rows.
--
--   note:   今天下午去北京開會討論預算
--   tokens: ["今天下午去北京開會討論預算"]   <- one token
--   search 北京 -> 0 rows
--
-- trigram indexes every 3-character window, which makes substring search work
-- for CJK and also makes Latin infix matching ("eeting" finds "meeting") work.
--
-- `remove_diacritics 1` keeps the accent-folding unicode61 gave us for free
-- (searching "cafe" still finds "Café"). Without it, switching to trigram would
-- fix Chinese while quietly regressing French/Spanish. Requires SQLite >= 3.45;
-- the app bundles 3.46 via libsqlite3-sys.
--
-- NOTE for callers: trigram cannot answer queries shorter than 3 characters —
-- and the commonest Chinese words are exactly 2 (北京, 會議, 預算). db.ts
-- therefore routes queries under 3 characters to LIKE instead. Keep both paths.
--
-- The sync triggers live on `notes`, not on `notes_fts`, so they survive the
-- swap and do not need recreating. 'rebuild' repopulates from the content table,
-- so existing notes stay searchable.

DROP TABLE IF EXISTS notes_fts;

CREATE VIRTUAL TABLE notes_fts USING fts5(
  title, body,
  content='notes',
  content_rowid='rowid',
  tokenize='trigram remove_diacritics 1'
);

INSERT INTO notes_fts(notes_fts) VALUES('rebuild');
