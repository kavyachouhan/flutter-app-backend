-- 0050 — Account deletion requests.
--
-- The App Store and Google Play require that a person can delete their account
-- from inside the app. Deletion happens in two steps:
--
--   1. In the request (src/modules/account): the business is closed at once —
--      status 'cancelled', every sign-in revoked, every device deactivated —
--      and the person's own name, email and phone number are erased. Nobody can
--      reach the data from that moment.
--   2. The purge (src/db/purge-deleted-accounts.ts), run on a schedule by an
--      operator: every row of the business, in every table that carries its
--      tenant_id, and its stored files are deleted for good.
--
-- The purge is not done inside the request because it touches every business
-- table and must briefly lock them; a nightly job is the place for that.
--
-- Table contract:
--   account_deletions   one row per request. Holds ids and dates only — no
--                       personal data — so it survives the purge as the record
--                       that the deletion was asked for and when it was done.
--                       Deliberately has no foreign keys: the tenant and user
--                       rows it names are what the purge deletes.
--
-- Additive only: one new table and its policies.

SET LOCAL search_path = public, extensions;

-- no-tenant-setup: account_deletions — purge bookkeeping that must outlive the tenant it names; never synced
CREATE TABLE account_deletions (
  id            UUID        PRIMARY KEY,
  tenant_id     UUID        NOT NULL,
  user_id       UUID        NOT NULL,
  -- business: the whole business and everything in it.
  -- login:    one person's sign-in for this business; the business carries on.
  scope         TEXT        NOT NULL CHECK (scope IN ('business', 'login')),
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- When the purge should have run by; the Privacy Policy promises this.
  purge_due_at  TIMESTAMPTZ NOT NULL,
  -- Null until the purge has deleted the data. A 'login' request needs no
  -- purge and is complete when made.
  purged_at     TIMESTAMPTZ,
  CHECK (purge_due_at >= requested_at)
);

-- A business is deleted once.
CREATE UNIQUE INDEX account_deletions_business_uq ON account_deletions (tenant_id)
  WHERE scope = 'business';
-- What the purge job reads.
CREATE INDEX account_deletions_due_idx ON account_deletions (purge_due_at)
  WHERE purged_at IS NULL;

ALTER TABLE account_deletions ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_deletions FORCE ROW LEVEL SECURITY;
CREATE POLICY account_deletions_read ON account_deletions FOR SELECT
  USING (tenant_id = app.current_tenant_id());
CREATE POLICY account_deletions_insert ON account_deletions FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id());
-- Written once by the app; only the purge (which bypasses RLS) marks it done.
SELECT app.restrict_table('account_deletions', ARRAY['UPDATE', 'DELETE']);

SELECT app.grant_runtime_privileges();
