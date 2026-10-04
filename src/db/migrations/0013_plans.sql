-- 0013 — Named plans: the published price list, expressed in the schema.
--
-- Until now a subscription was 'free' | 'trial' | 'paid' with its grants
-- assembled from PLAN_FREE_* environment variables. That shape cannot say
-- which of three priced tiers a shop is on, and the report gate in particular
-- was a comma-separated list of report ids in the environment — workable at
-- thirteen reports, unworkable at thirty-eight.
--
-- Plan codes now match what the price list sells: lite, standard, pro, plus
-- the trial every printer buyer gets. 'free' and 'paid' stay in the CHECK so
-- rows written before this migration remain valid; nothing issues them.
--
-- `features` stays a JSONB map and stays the runtime source of truth, so an
-- add-on or a one-off support grant is still a per-tenant override. What
-- changes is where the seed comes from: src/modules/entitlements/plans.ts
-- rather than the environment.

SET LOCAL search_path = public, extensions;

ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_plan_check;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_plan_check
  CHECK (plan IN ('trial', 'lite', 'standard', 'pro', 'free', 'paid'));

-- Devices are both a plan limit and a paid add-on (₹799/year for one more),
-- so the ceiling is per-subscription like every other quota rather than a
-- constant derived from the plan code.
ALTER TABLE subscriptions ADD COLUMN max_devices INTEGER CHECK (max_devices > 0);

COMMENT ON COLUMN subscriptions.max_devices IS
  'Devices that may hold an active registration. NULL means unlimited. Raised by the extra-device add-on, so it is stored per subscription rather than read off the plan.';

SELECT app.grant_runtime_privileges();
