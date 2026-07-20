-- 004_person_custom_fields.sql — global registry of People custom-field labels.
-- Custom fields are user-defined data points (e.g. "Eye color"). The LABEL set
-- is global: a field you add appears on every person. Each person's VALUE for a
-- field still lives in that person's `people.custom_fields` JSON, keyed by label
-- (so the vCard X- mapping is unchanged). This table just holds the shared,
-- ordered list of labels the People editor renders for everyone.

CREATE TABLE IF NOT EXISTS person_custom_fields (
  id       TEXT PRIMARY KEY,
  label    TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);
