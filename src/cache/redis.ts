/**
 * Redis holds nothing authoritative, so each consumer picks its own failure mode:
 *   rate limiting  fails open  — rejecting all traffic during a blip is a self-made outage
 *   OTP            fails closed — no store means no verification
 */
import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { createLogger } from '../lib/logger.js';
import { DependencyError, describeError } from '../lib/errors.js';

const log = createLogger('redis');

export const redis = new Redis(env.REDIS_URL, {
  // Fail commands immediately while disconnected instead of queueing them
  // behind a connection that may not come back.
  enableOfflineQueue: false,
  lazyConnect: true,
  maxRetriesPerRequest: env.REDIS_MAX_RETRIES_PER_REQUEST,
  connectTimeout: env.REDIS_CONNECT_TIMEOUT_MS,
  commandTimeout: env.REDIS_COMMAND_TIMEOUT_MS,
  retryStrategy: (times) =>
    Math.min(times * env.REDIS_RECONNECT_STEP_MS, env.REDIS_RECONNECT_MAX_DELAY_MS),
  keyPrefix: env.REDIS_KEY_PREFIX,
});

// ioredis emits on every reconnect attempt; /readyz is the real signal.
redis.on('error', (error: Error) => log.debug({ err: error }, 'Redis client error'));

export async function connectRedis(): Promise<void> {
  try {
    await redis.connect();
    log.info('Redis connected');
  } catch (error) {
    log.warn({ err: error }, 'Redis unavailable at startup; running degraded and reconnecting');
  }
}

export function isRedisReady(): boolean {
  return redis.status === 'ready';
}

/** For consumers that must fail closed. */
export function requireRedis(purpose: string): Redis {
  if (!isRedisReady()) throw new DependencyError(purpose);
  return redis;
}

export async function checkRedisHealth(): Promise<{ ok: boolean; status: string; error?: string }> {
  try {
    await redis.ping();
    return { ok: true, status: redis.status };
  } catch (error) {
    return { ok: false, status: redis.status, error: describeError(error) };
  }
}

export async function closeRedis(): Promise<void> {
  try {
    await redis.quit();
  } catch {
    redis.disconnect();
  }
}
