-- Enforce case-insensitive uniqueness on lists.name.
--
-- Historically lists.name had no UNIQUE constraint (unlike tags.name in 001),
-- and nothing checked for collisions — so the demo seeder, the UI, and the AI
-- assistant could each create a second "Personal" while one already existed.
-- See db.ts upsertList for the app-level check that backs this up.
--
-- COLLATE NOCASE mirrors how the rest of the app treats list names:
--   * person_custom_fields.label uses COLLATE NOCASE (ensureCustomField)
--   * resolveListId matches case-insensitively via toLowerCase()
-- NOCASE folds ASCII only — the same limitation the app already documents for
-- collation/sorting (see db.ts collator() note). Non-ASCII names are compared
-- byte-wise, matching how normalizeKey (NFC) feeds them in.
--
-- Two steps: collapse any duplicates already in the DB, then add the index.

-- For each case-insensitive name group, pick the keeper = oldest row. rowid
-- increases with insert order, and the seeded 'personal'/'work' rows predate
-- any user-created UUID rows, so the defaults survive and dupes get dropped.
CREATE TEMP TABLE _list_dupe AS
SELECT l.id AS dupe_id, k.keep_id
FROM lists l
JOIN (
  SELECT LOWER(name) AS lname,
         (SELECT id FROM lists l2 WHERE LOWER(l2.name) = LOWER(lists.name)
          ORDER BY rowid LIMIT 1) AS keep_id,
         MIN(rowid) AS keep_rowid
  FROM lists
  GROUP BY LOWER(name)
  HAVING COUNT(*) > 1
) k ON LOWER(l.name) = k.lname AND l.rowid <> k.keep_rowid;

-- Rehome todos from each doomed duplicate onto its keeper before deleting.
-- Mirrors deleteList's "keep at least one list, move the tasks" contract.
UPDATE todos
SET list_id = (SELECT keep_id FROM _list_dupe WHERE dupe_id = todos.list_id)
WHERE list_id IN (SELECT dupe_id FROM _list_dupe);

-- Drop the duplicates, keeping only the oldest row per name.
DELETE FROM lists WHERE id IN (SELECT dupe_id FROM _list_dupe);

DROP TABLE _list_dupe;

CREATE UNIQUE INDEX IF NOT EXISTS idx_lists_name_nocase ON lists(name COLLATE NOCASE);
