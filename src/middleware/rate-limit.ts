import type { Request, RequestHandler } from 'express';
import { RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';
import { redis } from '../cache/redis.js';
import { RateLimitError } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('rate-limit');

export interface RateLimitOptions {
  name: string;
  points: number;
  windowSeconds: number;
  /** Returning undefined skips limiting for the request. */
  key: (req: Request) => string | undefined;
}

export function rateLimit(options: RateLimitOptions): RequestHandler {
  const limiter = new RateLimiterRedis({
    storeClient: redis,
    keyPrefix: `rate:${options.name}`,
    points: options.points,
    duration: options.windowSeconds,
    rejectIfRedisNotReady: true,
  });

  return async (req, res, next) => {
    const key = options.key(req);
    if (key === undefined) {
      next();
      return;
    }
    try {
      const result = await limiter.consume(key);
      res.setHeader('RateLimit-Remaining', String(result.remainingPoints));
      next();
    } catch (error) {
      if (error instanceof RateLimiterRes) {
        next(new RateLimitError(Math.ceil(error.msBeforeNext / 1000)));
        return;
      }
      // Fail open: a Redis outage must not turn into rejecting every request.
      log.warn({ err: error, limiter: options.name }, 'Rate limiter unavailable; allowing request');
      next();
    }
  };
}
