-- 003_people.sql — People (contacts), modeled on vCard 4.0 (RFC 6350).
-- id doubles as the vCard UID (like events double as iCal UIDs), so a future
-- CardDAV sync + .vcf import/export is a straight field mapping.
--
-- People attach to events/todos/reminders/notes via the existing generic
-- `links` table, and are tagged via the existing `item_tags` table — no
-- changes needed to those tables (they key on a free-text item_type, which
-- now also accepts 'person').
--
-- Multi-value fields (emails/phones/addresses/urls) and user-defined custom
-- fields are stored as JSON on the row, mirroring how events store exdates /
-- categories. This round-trips to vCard cleanly and avoids child tables for
-- what is a small, single-user dataset.

CREATE TABLE IF NOT EXISTS people (
  id                TEXT PRIMARY KEY,   -- UUID, = vCard UID
  full_name         TEXT NOT NULL,      -- vCard FN (display name)
  given_name        TEXT,               -- vCard N components
  family_name       TEXT,
  additional_names  TEXT,
  honorific_prefix  TEXT,
  honorific_suffix  TEXT,
  nickname          TEXT,               -- vCard NICKNAME
  emails            TEXT,               -- JSON [{type,value,primary?}]  (EMAIL)
  phones            TEXT,               -- JSON [{type,value,primary?}]  (TEL)
  addresses         TEXT,               -- JSON [{type,street,city,region,postal_code,country}] (ADR)
  organization      TEXT,               -- vCard ORG
  title             TEXT,               -- vCard TITLE (job title)
  birthday          TEXT,               -- vCard BDAY (ISO date)
  urls              TEXT,               -- JSON [{type,value}] (URL)
  notes             TEXT,               -- vCard NOTE
  photo             TEXT,               -- vCard PHOTO (data URI/URL, optional)
  custom_fields     TEXT,               -- JSON [{label,value}] user-defined -> vCard X- props
  favorite          INTEGER NOT NULL DEFAULT 0,  -- app-specific
  sequence          INTEGER NOT NULL DEFAULT 0,  -- ~ vCard REV, app convention
  created_at        TEXT,
  updated_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_people_full_name ON people(full_name);
