/**
 * Access tokens are stateless (see middleware/authenticate.ts): revoking the
 * refresh tokens stops a session at its next refresh, up to
 * ACCESS_TOKEN_TTL_SECONDS later. That is fine for a role change, not for a
 * deleted account — for those minutes another phone could still read the
 * "deleted" business, and even add bills to it.
 *
 * So a deletion also leaves a short-lived mark in Redis, which every request
 * checks. Each mark only has to outlive the longest access token already
 * issued; after that no token naming it can exist.
 *
 * Fails open, like rate limiting: during a Redis outage the old bound (the
 * token's own expiry) applies. The refresh tokens are revoked in the database
 * either way, so no session survives past that.
 */
import { isRedisReady, redis } from '../../cache/redis.js';
import { env } from '../../config/env.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('revocations');

const tenantKey = (tenantId: string) => `revoked:tenant:${tenantId}`;
const userKey = (tenantId: string, userId: string) => `revoked:user:${tenantId}:${userId}`;

/** A minute of slack for clock skew between the API instances. */
const markSeconds = () => env.ACCESS_TOKEN_TTL_SECONDS + 60;

async function mark(key: string): Promise<void> {
  try {
    if (!isRedisReady()) throw new Error('Redis not ready');
    await redis.set(key, '1', 'EX', markSeconds());
  } catch (error) {
    // The deletion itself is already committed; only the early cut-off is lost.
    log.warn({ err: error, key }, 'Could not mark tokens revoked; they stop at their own expiry');
  }
}

/** Every access token for this business stops working now. */
export function revokeTenantAccess(tenantId: string): Promise<void> {
  return mark(tenantKey(tenantId));
}

/** This person's access tokens for this business stop working now. */
export function revokeUserAccess(tenantId: string, userId: string): Promise<void> {
  return mark(userKey(tenantId, userId));
}

/** True when the token's business was deleted or its holder's sign-in was. */
export async function isAccessRevoked(tenantId: string, userId: string): Promise<boolean> {
  if (!isRedisReady()) return false;
  try {
    const [tenant, user] = await redis.mget(tenantKey(tenantId), userKey(tenantId, userId));
    return tenant !== null || user !== null;
  } catch (error) {
    log.warn({ err: error }, 'Revocation check unavailable; allowing request');
    return false;
  }
}
