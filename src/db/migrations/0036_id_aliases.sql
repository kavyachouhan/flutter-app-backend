-- 0036 — Aliases for records that were merged into an existing one.
--
-- Two phones, both offline, each add the same customer (same phone number), item (same code),
-- category (same name under the same parent) or supplier. Each uses its own client-made id, and a
-- business keeps one record per key, so the second to arrive cannot simply be inserted. Rejecting
-- it lost the second phone's work and stranded every bill and payment that phone had already
-- queued against its own copy.
--
-- Instead the server matches the second create to the record that already exists and remembers
-- that the second phone's id now means that record:
--
-- Table contract:
--   id_aliases   (tenant, alias_id) -> canonical_id, with the kind of record. Written once, when
--                a create is merged; never changed or deleted (the rule below makes it
--                append-only). Every later operation from the second phone that names the alias
--                id is rewritten to the canonical id before it is applied, so its queued bills,
--                payments and edits land on the one real record.
--
-- Additive only: one new table, one index. No existing table, row, column, index, policy or
-- function is altered or removed.
--
-- Not part of the change stream: devices learn of a merge from the answer to the operation that
-- caused it, so the table is not enrolled with app.setup_tenant_table. Its row-level security is
-- written out by hand, as for sync_batches in 0006.

SET LOCAL search_path = public, extensions;

-- no-tenant-setup: id_aliases — merge bookkeeping, never part of the change stream
CREATE TABLE id_aliases (
  tenant_id    UUID        NOT NULL REFERENCES tenants (id),
  entity       TEXT        NOT NULL CHECK (entity IN ('customer', 'supplier', 'item', 'category')),
  alias_id     UUID        NOT NULL,
  canonical_id UUID        NOT NULL,
  device_id    UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, alias_id),
  CHECK (alias_id <> canonical_id)
);

CREATE INDEX id_aliases_canonical_idx ON id_aliases (tenant_id, canonical_id);

ALTER TABLE id_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE id_aliases FORCE ROW LEVEL SECURITY;
CREATE POLICY id_aliases_read ON id_aliases FOR SELECT USING (tenant_id = app.current_tenant_id());
CREATE POLICY id_aliases_append ON id_aliases FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id());
SELECT app.restrict_table('id_aliases', ARRAY['UPDATE', 'DELETE']);

SELECT app.grant_runtime_privileges();
