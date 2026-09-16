import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';
import { requireRedis } from '../../cache/redis.js';
import {
  AppError,
  AuthError,
  DependencyError,
  ErrorCode,
  RateLimitError,
} from '../../lib/errors.js';
import { getSmsProvider } from './sms.js';

const otpKey = (phone: string) => `otp:${phone}`;
const cooldownKey = (phone: string) => `otp:cooldown:${phone}`;

// HMAC-keyed so the small code space cannot be brute-forced offline from a
// Redis dump, and bound to the phone so a hash is useless for another number.
function hashCode(phone: string, code: string): Buffer {
  return createHmac('sha256', env.OTP_HASH_SECRET).update(`${phone}:${code}`).digest();
}

// OTP fails closed: an unreachable store is a 503, never a skipped check.
async function withStore<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new DependencyError('OTP store', { cause: error });
  }
}

export async function issueOtp(
  phone: string,
): Promise<{ expiresInSeconds: number; resendAfterSeconds: number }> {
  const redis = requireRedis('OTP store');

  await withStore(async () => {
    const acquired = await redis.set(
      cooldownKey(phone),
      '1',
      'EX',
      env.OTP_RESEND_COOLDOWN_SECONDS,
      'NX',
    );
    if (acquired !== 'OK') {
      throw new RateLimitError(Math.max(await redis.ttl(cooldownKey(phone)), 1));
    }

    const code = String(randomInt(10 ** env.OTP_LENGTH)).padStart(env.OTP_LENGTH, '0');
    await redis
      .multi()
      .hset(otpKey(phone), { hash: hashCode(phone, code).toString('hex'), attempts: 0 })
      .expire(otpKey(phone), env.OTP_TTL_SECONDS)
      .exec();

    try {
      await getSmsProvider().sendOtp(phone, code);
    } catch (error) {
      // Clear the cooldown too, so the user can retry as soon as the provider recovers.
      await redis.del(otpKey(phone), cooldownKey(phone));
      throw new DependencyError('SMS delivery', { cause: error });
    }
  });

  return {
    expiresInSeconds: env.OTP_TTL_SECONDS,
    resendAfterSeconds: env.OTP_RESEND_COOLDOWN_SECONDS,
  };
}

export async function verifyOtp(phone: string, code: string): Promise<void> {
  if (
    env.AUTH_DEV_BYPASS &&
    env.AUTH_DEV_FIXED_OTP !== undefined &&
    code === env.AUTH_DEV_FIXED_OTP
  ) {
    return;
  }

  const redis = requireRedis('OTP store');
  const key = otpKey(phone);

  await withStore(async () => {
    // Incrementing and reading in one MULTI means parallel guesses cannot all
    // be compared before the attempt counter moves.
    const results = await redis.multi().hincrby(key, 'attempts', 1).hget(key, 'hash').exec();
    const attempts = Number(results?.[0]?.[1]);
    const storedHex = results?.[1]?.[1];

    if (typeof storedHex !== 'string') {
      // HINCRBY recreated an expired key without a TTL; remove it.
      await redis.del(key);
      throw new AuthError('The code has expired. Request a new one.', ErrorCode.OTP_EXPIRED);
    }
    if (attempts > env.OTP_MAX_ATTEMPTS) {
      await redis.del(key);
      throw new AuthError(
        'Too many incorrect attempts. Request a new code.',
        ErrorCode.OTP_EXPIRED,
      );
    }

    const stored = Buffer.from(storedHex, 'hex');
    const candidate = hashCode(phone, code);
    if (stored.length !== candidate.length || !timingSafeEqual(stored, candidate)) {
      throw new AuthError('The code is incorrect.', ErrorCode.OTP_INVALID, {
        details: { attemptsRemaining: Math.max(env.OTP_MAX_ATTEMPTS - attempts, 0) },
      });
    }

    await redis.del(key, cooldownKey(phone));
  });
}
