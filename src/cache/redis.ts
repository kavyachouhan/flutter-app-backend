/**
 * The Redis client.
 *
 * Backs four things: rate limiting, the read cache, OTP storage and
 * idempotency keys. Nothing in Redis is a source of truth — every key is
 * either reconstructible from Postgres or short-lived by design — which is
 * what lets the API degrade rather than fail when Redis is unavailable.
 *
 * That degradation is deliberate per subsystem, and the choices differ:
 *   - cache miss      → read from Postgres. Slower, still correct.
 *   - rate limiting   → fail OPEN. A rate limiter that rejects everything
 *                       during a Redis blip is a self-inflicted outage.
 *   - OTP             → fail CLOSED. No OTP store means no verification, and
 *                       "allow the login anyway" is not an option.
 *   - idempotency     → fail CLOSED for writes, so a retry cannot double-post.
 */
import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { createLogger } from '../lib/logger.js';
import { describeError } from '../lib/errors.js';

const log = createLogger('redis');

export const redis = new Redis(env.REDIS_URL, {
  // Disable the offline queue so that commands fail fast when Redis is down.
  enableOfflineQueue: false,
  maxRetriesPerRequest: 2,
  connectTimeout: 5_000,
  commandTimeout: 3_000,

  // Exponential backoff capped at 3s, so a Redis restart reconnects promptly
  // without a reconnect storm from every API instance at once.
  retryStrategy: (times) => Math.min(times * 200, 3_000),

  // Lazy connect so that the API can start even if Redis is down, and
  // reconnect automatically. The API will degrade gracefully in that case.
  lazyConnect: true,

  keyPrefix: 'khata:',
});

let connectionLogged = false;

redis.on('connect', () => {
  if (!connectionLogged) {
    log.info('Redis connected');
    connectionLogged = true;
  }
});

redis.on('error', (error: Error) => {
  // ioredis emits on every reconnect attempt; logging each one would flood.
  // `debug` here, with the real signal coming from /readyz.
  log.debug({ err: error }, 'Redis client error');
});

redis.on('close', () => {
  connectionLogged = false;
});

/** Establishes the lazy connection. Called once at startup; never throws. */
export async function connectRedis(): Promise<void> {
  try {
    await redis.connect();
  } catch (error) {
    log.warn(
      { err: error },
      'Redis unavailable at startup — the API will run in degraded mode (cache misses, ' +
        'rate limiting open) and reconnect automatically.',
    );
  }
}

export function isRedisReady(): boolean {
  return redis.status === 'ready';
}

export interface RedisHealth {
  ok: boolean;
  latencyMs: number;
  status: string;
  error?: string;
}

export async function checkRedisHealth(): Promise<RedisHealth> {
  const startedAt = performance.now();
  try {
    await redis.ping();
    return {
      ok: true,
      latencyMs: Math.round(performance.now() - startedAt),
      status: redis.status,
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - startedAt),
      status: redis.status,
      error: describeError(error),
    };
  }
}

export async function closeRedis(): Promise<void> {
  try {
    // `quit` drains in-flight commands; `disconnect` would drop them.
    await redis.quit();
    log.info('Redis connection closed');
  } catch {
    redis.disconnect();
  }
}
