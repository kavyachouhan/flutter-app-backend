import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';
import { requireRedis } from '../../cache/redis.js';
import {
  AppError,
  AuthError,
  DependencyError,
  ErrorCode,
  RateLimitError,
  UnprocessableError,
} from '../../lib/errors.js';
import { createLogger } from '../../lib/logger.js';
import { otpDeliveries } from '../../observability/metrics.js';
import {
  DeliveryError,
  getOtpDeliveryProvider,
  type OtpDeliveryChannel,
} from './delivery/index.js';
import { maskPhone } from './phone.js';

const log = createLogger('otp');

const otpKey = (phone: string) => `otp:${phone}`;
const cooldownKey = (phone: string) => `otp:cooldown:${phone}`;

export interface OtpIssued {
  /** How the code was sent, so the client can say "sent by SMS" without assuming. */
  channel: OtpDeliveryChannel;
  /** "+••••••••1234" — confirms the destination without echoing the number. */
  maskedDestination: string;
  expiresInSeconds: number;
  resendAfterSeconds: number;
}

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

export async function issueOtp(phone: string): Promise<OtpIssued> {
  const redis = requireRedis('OTP store');
  const provider = getOtpDeliveryProvider();

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

    const startedAt = performance.now();
    try {
      const receipt = await provider.sendOtp({ phone, code, ttlSeconds: env.OTP_TTL_SECONDS });
      otpDeliveries.inc({ provider: provider.name, result: 'delivered' });
      log.info(
        {
          provider: provider.name,
          channel: provider.channel,
          providerMessageId: receipt.providerMessageId,
          latencyMs: Math.round(performance.now() - startedAt),
        },
        'OTP delivered',
      );
    } catch (error) {
      // Clear the cooldown too, so the person can retry as soon as the
      // provider recovers or after correcting the number.
      await redis.del(otpKey(phone), cooldownKey(phone));

      // Anything that is not a DeliveryError is a provider bug or an
      // unexpected transport failure; treat it as transient rather than
      // telling the person their number is wrong.
      const retryable = error instanceof DeliveryError ? error.retryable : true;
      otpDeliveries.inc({
        provider: provider.name,
        result: retryable ? 'retryable_error' : 'terminal_error',
      });
      log.warn(
        {
          err: error,
          provider: provider.name,
          retryable,
          latencyMs: Math.round(performance.now() - startedAt),
        },
        'OTP delivery failed',
      );

      if (retryable) throw new DependencyError('OTP delivery', { cause: error });
      throw new UnprocessableError(
        'We could not send a code to this number. Check it and try again.',
        ErrorCode.OTP_DELIVERY_FAILED,
        { cause: error, details: { channel: provider.channel } },
      );
    }
  });

  return {
    channel: provider.channel,
    maskedDestination: maskPhone(phone),
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
