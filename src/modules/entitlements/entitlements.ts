import { env } from '../../config/env.js';
import type { Tx } from '../../db/tx.js';
import { EntitlementError, ErrorCode, InternalError } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';

export type QuotaResource = 'users' | 'outlets' | 'counters' | 'items';

export interface Subscription {
  plan: string;
  status: string;
  maxUsers: number | null;
  maxOutlets: number | null;
  maxCounters: number | null;
  maxItems: number | null;
  features: Record<string, unknown>;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
}

const SUBSCRIPTION_COLUMNS = `
  plan, status, max_users AS "maxUsers", max_outlets AS "maxOutlets", max_counters AS "maxCounters",
  max_items AS "maxItems", features, trial_ends_at AS "trialEndsAt", current_period_end AS "currentPeriodEnd"`;

const USAGE_SQL: Record<QuotaResource, string> = {
  users: 'SELECT count(*) AS used FROM memberships WHERE is_active AND deleted_at IS NULL',
  outlets: 'SELECT count(*) AS used FROM outlets WHERE deleted_at IS NULL',
  counters: 'SELECT count(*) AS used FROM counters WHERE deleted_at IS NULL',
  items: 'SELECT count(*) AS used FROM items WHERE deleted_at IS NULL',
};

const LIMIT_FIELD = {
  users: 'maxUsers',
  outlets: 'maxOutlets',
  counters: 'maxCounters',
  items: 'maxItems',
} as const satisfies Record<QuotaResource, keyof Subscription>;

// past_due stays writable so a declined renewal does not stop a shop billing mid-day.
const WRITABLE_STATUSES = new Set(['active', 'past_due']);

export async function insertFreeSubscription(tx: Tx): Promise<void> {
  await tx.query(
    `INSERT INTO subscriptions (id, tenant_id, plan, status, max_users, max_outlets, max_counters, max_items, features)
     VALUES ($1, app.current_tenant_id(), 'free', 'active', $2, $3, $4, $5, '{}'::jsonb)`,
    [
      newId(),
      env.PLAN_FREE_MAX_USERS ?? null,
      env.PLAN_FREE_MAX_OUTLETS ?? null,
      env.PLAN_FREE_MAX_COUNTERS ?? null,
      env.PLAN_FREE_MAX_ITEMS ?? null,
    ],
  );
}

/**
 * Locks the subscription row, so two concurrent creates serialise here and
 * cannot both observe room for one more.
 */
export async function assertQuota(tx: Tx, resource: QuotaResource): Promise<void> {
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
