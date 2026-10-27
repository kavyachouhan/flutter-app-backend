import { env } from '../../config/env.js';
import type { Tx } from '../../db/tx.js';
import { EntitlementError, ErrorCode, InternalError } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { DEFAULT_PLAN, PLANS, featureGrantsFor, type PlanCode } from './plans.js';

export type QuotaResource = 'users' | 'outlets' | 'counters' | 'items' | 'devices';

/**
 * Capabilities a plan may or may not include, as opposed to quotas, which are
 * counts. Keys are grouped with dots so a whole group can be granted at once.
 * Additive only: a rename silently un-grants whatever every existing
 * subscription row already stores.
 */
export const FEATURES = [
  'offline_mode',
  'reports.all',
  'credit_notes',
  'purchases',
  'sales_orders',
  'price_lists',
  'discount_rules',
  'gst_workings',
  'storefront',
  'bulk_edit',
  'barcode_printing',
  'vertical.pharmacy',
  'vertical.electronics',
  'tally_sync',
  'einvoice',
] as const;
export type Feature = (typeof FEATURES)[number];

export interface Subscription {
  plan: string;
  status: string;
  maxUsers: number | null;
  maxOutlets: number | null;
  maxCounters: number | null;
  maxItems: number | null;
  maxDevices: number | null;
  features: Record<string, unknown>;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
}

const SUBSCRIPTION_COLUMNS = `
  plan, status, max_users AS "maxUsers", max_outlets AS "maxOutlets", max_counters AS "maxCounters",
  max_items AS "maxItems", max_devices AS "maxDevices", features,
  trial_ends_at AS "trialEndsAt", current_period_end AS "currentPeriodEnd"`;

const USAGE_SQL: Record<QuotaResource, string> = {
  users: 'SELECT count(*) AS used FROM memberships WHERE is_active AND deleted_at IS NULL',
  outlets: 'SELECT count(*) AS used FROM outlets WHERE deleted_at IS NULL',
  counters: 'SELECT count(*) AS used FROM counters WHERE deleted_at IS NULL',
  items: 'SELECT count(*) AS used FROM items WHERE deleted_at IS NULL',
  devices: 'SELECT count(*) AS used FROM devices WHERE is_active AND deleted_at IS NULL',
};

const LIMIT_FIELD = {
  users: 'maxUsers',
  outlets: 'maxOutlets',
  counters: 'maxCounters',
  items: 'maxItems',
  devices: 'maxDevices',
} as const satisfies Record<QuotaResource, keyof Subscription>;

// past_due stays writable so a declined renewal does not stop a shop billing mid-day.
const WRITABLE_STATUSES = new Set(['active', 'past_due']);

/**
 * Keys consulted for one feature, most specific first: the feature itself,
 * then its group wildcard, then the global one. An explicit entry therefore
 * beats a wildcard in both directions, so a single feature can be withheld
 * from an otherwise all-inclusive plan.
 */
function grantKeys(feature: string): string[] {
  const keys = [feature];
  const dot = feature.lastIndexOf('.');
  if (dot > 0) keys.push(`${feature.slice(0, dot)}.*`);
  keys.push('*');
  return keys;
}

export function hasFeature(features: Record<string, unknown>, feature: string): boolean {
  if (env.PLAN_DEV_GRANT_ALL) return true;
  for (const key of grantKeys(feature)) {
    const granted = features[key];
    if (granted === true) return true;
    if (granted === false) return false;
  }
  return false;
}

/**
 * Seeds the subscription a new shop starts on, from the plan catalogue.
 *
 * The quotas and grants are copied rather than referenced, so a later pricing
 * change does not silently move an existing shop's ceiling, and an add-on can
 * raise one subscription without inventing a plan code for it.
 */
export async function insertSubscription(tx: Tx, plan: PlanCode = DEFAULT_PLAN): Promise<void> {
  const definition = PLANS[plan];
  const trialEndsAt =
    definition.trialDays > 0
      ? new Date(Date.now() + definition.trialDays * 24 * 60 * 60 * 1000)
      : null;

  await tx.query(
    `INSERT INTO subscriptions
       (id, tenant_id, plan, status, max_users, max_outlets, max_counters, max_items, max_devices,
        features, trial_ends_at)
     VALUES ($1, app.current_tenant_id(), $2, 'active', $3, $4, $5, $6, $7, $8::jsonb, $9)`,
    [
      newId(),
      plan,
      definition.maxUsers,
      definition.maxOutlets,
      definition.maxCounters,
      definition.maxItems,
      definition.maxDevices,
      JSON.stringify(featureGrantsFor(plan)),
      trialEndsAt,
    ],
  );
}

/**
 * The gate for paid capabilities. No row lock, unlike `assertQuota`: nothing
 * is being counted, so there is no race between two concurrent checks.
 */
export async function assertFeature(tx: Tx, feature: Feature): Promise<void> {
  const subscription = await tx.one<Subscription>(
    `SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions`,
  );
  if (!subscription) throw new InternalError('Tenant has no subscription.');
  if (!WRITABLE_STATUSES.has(subscription.status)) {
    throw new EntitlementError('Your subscription is not active.');
  }
  if (!hasFeature(subscription.features, feature)) {
    throw new EntitlementError(
      'Your plan does not include this feature.',
      ErrorCode.FEATURE_NOT_IN_PLAN,
      { details: { feature } },
    );
  }
}

/**
 * Locks the subscription row, so two concurrent creates serialise here and
 * cannot both observe room for one more.
 */
export async function assertQuota(tx: Tx, resource: QuotaResource): Promise<void> {
  if (env.PLAN_DEV_GRANT_ALL) return;
  const subscription = await tx.one<Subscription>(
    `SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions FOR UPDATE`,
  );
  if (!subscription) throw new InternalError('Tenant has no subscription.');
  if (!WRITABLE_STATUSES.has(subscription.status)) {
    throw new EntitlementError('Your subscription is not active.');
  }

  const limit = subscription[LIMIT_FIELD[resource]];
  if (limit === null) return;

  const used = (await tx.one<{ used: number }>(USAGE_SQL[resource]))?.used ?? 0;
  if (used >= limit) {
    throw new EntitlementError(`Your plan allows ${limit} ${resource}.`, ErrorCode.QUOTA_EXCEEDED, {
      details: { resource, limit, used },
    });
  }
}

export async function getSubscriptionWithUsage(tx: Tx) {
  const subscription = await tx.one<Subscription>(
    `SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions`,
  );
  if (!subscription) throw new InternalError('Tenant has no subscription.');

  const usage: Record<string, number> = {};
  for (const resource of Object.keys(USAGE_SQL) as QuotaResource[]) {
    usage[resource] = (await tx.one<{ used: number }>(USAGE_SQL[resource]))?.used ?? 0;
  }
  return { ...subscription, usage };
}
