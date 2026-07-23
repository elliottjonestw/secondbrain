-- Repair legacy list ids left over from the retired local-SQLite stack.
--
-- The old on-device seeder gave the default lists slug primary keys
-- ("personal", "work") instead of UUIDs. When a space was migrated into D1
-- those slugs came along, but every id in the cloud schema is meant to be a
-- UUID (architecture rule 5), and the todos API enforces it: `list_id` is
-- validated as `z.string().uuid()`, so `POST /todos` with `list_id = "personal"`
-- is rejected with 400 "Invalid uuid" and the user simply cannot add a task to
-- that list. New accounts are unaffected — registration seeds `crypto.randomUUID()`
-- — so this only touches the handful of pre-migration spaces.
--
-- The fix rewrites the two known slugs to fixed UUIDs and repoints any todo that
-- referenced them (there are no foreign keys, so the todo rows must be updated
-- explicitly, and links/item_tags never reference a list). Matching only the
-- exact slug strings makes this a safe no-op in every environment that already
-- uses UUIDs.
UPDATE todos SET list_id = '6ba1dc71-b613-44d4-a083-930495925a2f' WHERE list_id = 'personal';
UPDATE lists SET id      = '6ba1dc71-b613-44d4-a083-930495925a2f' WHERE id = 'personal';

UPDATE todos SET list_id = '91de939c-2ee7-4157-bc19-b9762a85088b' WHERE list_id = 'work';
UPDATE lists SET id      = '91de939c-2ee7-4157-bc19-b9762a85088b' WHERE id = 'work';
