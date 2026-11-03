-- 0035 — Idempotency keys for operations pushed by a device.
--
-- A phone queues each change with a client-made `opId` and may send it more than once (a reply
-- lost in transit, a retry after a crash). Until now the server only echoed the id back, so a
-- repeat relied on every service happening to tolerate it — and two of them (marking a bill or
-- credit note printed) counted the repeat as a second print.
--
-- Table contract:
--   operation_keys   one row per applied operation, written in the SAME transaction as the
--                    operation's effects. A key therefore exists exactly when its effects
--                    committed: a rolled-back operation leaves no key, and a retry runs fresh.
--                    `payload_hash` ties the key to what was sent, so reusing an opId for
--                    something different is refused rather than answered with the wrong result.
--                    `result` is what the first call returned (the affected id and any
--                    warnings), replayed verbatim to a repeat. Rows expire (`expires_at`) and
--                    are purged in small batches by the push path.
--
-- Additive only: one new table, one index. No existing table, row, column, index, policy or
-- function is altered or removed.
--
-- The table is bookkeeping and must never reach other devices, so it does not use
-- app.setup_tenant_table (which would stamp server_seq and enrol it in the change stream). Its
-- row-level security is written out by hand, as for device_sync_state in 0006. Unlike
-- sync_batches it is not append-only: a row is completed after it is claimed and purged later.

SET LOCAL search_path = public, extensions;

-- no-tenant-setup: operation_keys — idempotency bookkeeping, never part of the change stream
CREATE TABLE operation_keys (
  tenant_id    UUID        NOT NULL REFERENCES tenants (id),
  op_id        UUID        NOT NULL,
  device_id    UUID        NOT NULL,
  user_id      UUID,
  op_type      TEXT        NOT NULL,
  payload_hash BYTEA       NOT NULL,
  result       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, op_id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices (tenant_id, id)
);

CREATE INDEX operation_keys_expiry_idx ON operation_keys (tenant_id, expires_at);

CREATE TRIGGER operation_keys_tenant_fixed BEFORE UPDATE ON operation_keys
  FOR EACH ROW EXECUTE FUNCTION app.forbid_tenant_change();

ALTER TABLE operation_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE operation_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON operation_keys
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

SELECT app.grant_runtime_privileges();
