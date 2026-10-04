-- 0017 — Soft-delete price list entries, so a removed price reaches the tills.
--
-- The change feed in sync.repository.ts can only emit rows that still exist:
-- each branch is a `SELECT ... WHERE server_seq > $1` over the table itself,
-- and `deleted` is derived from `deleted_at IS NOT NULL`. A hard DELETE is
-- therefore invisible to a device — it would keep pricing a wholesale customer
-- at a figure the shop removed, indefinitely and silently.
--
-- `price_list_items` was created without `deleted_at` in 0016, which made every
-- removal exactly that bug. Prices are the one kind of row where a stale copy
-- costs real money.
--
-- The primary key stays as it is. A re-added price reuses the row and clears
-- the flag, which is also why the upsert sets `deleted_at = NULL`: without
-- that, re-adding a price the shop had deleted would appear to succeed and
-- change nothing.

SET LOCAL search_path = public, extensions;

ALTER TABLE price_list_items ADD COLUMN deleted_at TIMESTAMPTZ;

-- Only live prices are ever read; the index keeps that the cheap path.
CREATE INDEX price_list_items_live_idx
  ON price_list_items (tenant_id, price_list_id, item_id, min_quantity)
  WHERE deleted_at IS NULL;

COMMENT ON COLUMN price_list_items.deleted_at IS
  'Soft delete, required rather than cosmetic: the sync change feed cannot report a row that no longer exists, so a hard delete would leave devices pricing at a removed figure.';

SELECT app.grant_runtime_privileges();
