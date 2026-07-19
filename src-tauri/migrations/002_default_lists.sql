-- 002_default_lists.sql
-- Replace the single seeded "Inbox" list with a couple of sensible defaults
-- (Personal, Work). Existing tasks in the old Inbox move to Personal so nothing
-- is lost.

INSERT OR IGNORE INTO lists (id, name, color) VALUES
  ('personal', 'Personal', '#3b82f6'),
  ('work',     'Work',     '#ef4444');

-- Rehome any tasks that were in the old default list (or had no list).
UPDATE todos SET list_id = 'personal' WHERE list_id = 'default' OR list_id IS NULL;

-- Drop the old Inbox default.
DELETE FROM lists WHERE id = 'default';
