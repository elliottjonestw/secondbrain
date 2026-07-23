-- ---------------------------------------------------------------------------
-- Widget settings that follow the account, not the device.
--
-- Settings have always lived in localStorage (see lib/settings.ts) and most of
-- them still do. The ones on Settings → Widgets are different in kind: an RSS
-- subscription list is something a user builds up over months, and a weather
-- location and a watchlist are answers to "where am I" and "what do I own",
-- neither of which changes because you opened the app on another machine.
--
-- A key/value table rather than a column per setting, and rather than a domain
-- table per feature:
--
--   * The values are small JSON blobs with shapes owned by the client
--     (`WeatherLocation`, `StockSymbol[]`, `RssFeed[]`). Giving each a table
--     would mean a migration every time a widget gains a field, to store data
--     the Worker never reads, filters or ranks — it only hands it back.
--   * Which keys are allowed to be here is enforced in code
--     (`CLOUD_SETTING_KEYS` in @secondbrain/shared, checked by the route), NOT
--     by the schema. That allowlist is load-bearing: it is what guarantees the
--     OpenAI API key and the iCloud app-specific password can never be written
--     to the server, whatever a future client tries to sync. Widen it only
--     after asking whether the value is a secret.
--
-- Deliberately NOT in DATA_TABLES, so it is neither exported by a backup nor
-- deleted by "clear all data". That keeps the rule the localStorage settings
-- already established: settings are configuration, not content. Wiping your
-- data should not also forget where you live and which feeds you read, and a
-- backup file restored into a fresh account should not carry them either.
--
-- Last write wins, per key. There is no merge and no conflict detection: two
-- devices editing the same watchlist minutes apart is not a scenario worth a
-- vector clock, and every value here is one the user can see and re-set.
--
-- No foreign key on space_id — see CLAUDE.md: PRAGMA foreign_keys applies to
-- the migration connection only, so a declared FK here would never fire.
-- ---------------------------------------------------------------------------

CREATE TABLE space_settings (
  space_id   TEXT NOT NULL,
  key        TEXT NOT NULL,
  -- JSON, always. Even a scalar is stored as its JSON encoding so reads need
  -- no per-key knowledge of the shape on either side.
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (space_id, key)
);
