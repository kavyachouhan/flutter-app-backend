import { beforeEach, describe, expect, it, vi } from 'vitest';

// The real env, with the demo settings overridable per test.
const overrides: Record<string, unknown> = vi.hoisted(() => ({}));
vi.mock('../../config/env.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../config/env.js')>();
  return {
    ...real,
    // Over a copy: a proxy may not change what a frozen object's keys hold.
    env: new Proxy(
      { ...real.env },
      {
        get: (target, key) =>
          typeof key === 'string' && key in overrides
            ? overrides[key]
            : (target as unknown as Record<string | symbol, unknown>)[key],
      },
    ),
  };
});

// An in-memory Redis covering what the OTP code uses.
const store = vi.hoisted(() => new Map<string, Record<string, string> | string>());
vi.mock('../../cache/redis.js', () => {
  const redis = {
    set: (key: string, value: string, _ex: string, _s: number, nx?: string) => {
      if (nx === 'NX' && store.has(key)) return Promise.resolve(null);
      store.set(key, value);
      return Promise.resolve('OK');
    },
    ttl: () => Promise.resolve(30),
    del: (...keys: string[]) => {
      keys.forEach((k) => store.delete(k));
      return Promise.resolve(keys.length);
    },
    multi: () => {
      const ops: (() => unknown)[] = [];
      const chain = {
        hset: (key: string, fields: Record<string, unknown>) => {
          ops.push(() =>
            store.set(
              key,
              Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, String(v)])),
            ),
          );
          return chain;
        },
        expire: () => chain,
        hincrby: (key: string, field: string) => {
          ops.push(() => {
            const h = (store.get(key) as Record<string, string> | undefined) ?? {};
            h[field] = String(Number(h[field] ?? 0) + 1);
            store.set(key, h);
            return Number(h[field]);
          });
          return chain;
        },
        hget: (key: string, field: string) => {
          ops.push(() => (store.get(key) as Record<string, string> | undefined)?.[field] ?? null);
          return chain;
        },
        exec: () => Promise.resolve(ops.map((op) => [null, op()])),
      };
      return chain;
    },
  };
  return { requireRedis: () => redis, isRedisReady: () => true, redis };
});

// Records what would have been sent by SMS.
const sent = vi.hoisted(() => [] as { phone: string; code: string }[]);
vi.mock('./delivery/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./delivery/index.js')>();
  return {
    ...real,
    getOtpDeliveryProvider: () => ({
      name: 'test',
      channel: 'sms',
      sendOtp: (input: { phone: string; code: string }) => {
        sent.push(input);
        return Promise.resolve({ provider: 'test', channel: 'sms' });
      },
    }),
  };
});

const { issueOtp, verifyOtp } = await import('./otp.js');

const PHONE = '918169225516';

beforeEach(() => {
  for (const k of Object.keys(overrides)) delete overrides[k];
  store.clear();
  sent.length = 0;
});

const demo = (on: boolean) =>
  Object.assign(overrides, { AUTH_DEV_FIXED_OTP: undefined, DEMO_OTP_ENABLED: on });

describe('demo switch on', () => {
  it('sends no SMS, and 000000 signs in', async () => {
    demo(true);
    await issueOtp(PHONE);
    expect(sent).toEqual([]);
    await expect(verifyOtp(PHONE, '000000')).resolves.toBeUndefined();
  });

  it('works for any number', async () => {
    demo(true);
    await expect(verifyOtp('919876543210', '000000')).resolves.toBeUndefined();
  });

  it('refuses any other code', async () => {
    demo(true);
    await issueOtp(PHONE);
    await expect(verifyOtp(PHONE, '123456')).rejects.toMatchObject({ code: 'OTP_INVALID' });
  });

  it('keeps the 30-second resend wait', async () => {
    demo(true);
    await issueOtp(PHONE);
    await expect(issueOtp(PHONE)).rejects.toMatchObject({ statusCode: 429 });
  });
});

describe('demo switch off', () => {
  it('sends a real SMS; its code signs in and 000000 does not', async () => {
    demo(false);
    await issueOtp(PHONE);
    expect(sent).toHaveLength(1);
    await expect(verifyOtp(PHONE, '000000')).rejects.toMatchObject({ code: 'OTP_INVALID' });
    await expect(verifyOtp(PHONE, sent[0]!.code)).resolves.toBeUndefined();
  });
});
