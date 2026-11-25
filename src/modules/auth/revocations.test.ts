import { beforeEach, describe, expect, it, vi } from 'vitest';

// An in-memory stand-in for the Redis client: set with EX, mget, and a switch
// for "Redis is down".
const store = new Map<string, { value: string; ex: number }>();
const state = { ready: true, failing: false };
vi.mock('../../cache/redis.js', () => ({
  isRedisReady: () => state.ready,
  redis: {
    set: vi.fn((key: string, value: string, _ex: string, seconds: number) => {
      if (state.failing) return Promise.reject(new Error('connection lost'));
      store.set(key, { value, ex: seconds });
      return Promise.resolve('OK');
    }),
    mget: vi.fn((...keys: string[]) => {
      if (state.failing) return Promise.reject(new Error('connection lost'));
      return Promise.resolve(keys.map((k) => store.get(k)?.value ?? null));
    }),
  },
}));

const { isAccessRevoked, revokeTenantAccess, revokeUserAccess } = await import('./revocations.js');
const { env } = await import('../../config/env.js');

const TENANT = '0190a000-0000-7000-8000-000000000001';
const OTHER_TENANT = '0190a000-0000-7000-8000-000000000002';
const USER = '0190a000-0000-7000-8000-0000000000aa';
const OTHER_USER = '0190a000-0000-7000-8000-0000000000bb';

beforeEach(() => {
  store.clear();
  state.ready = true;
  state.failing = false;
});

describe('access revocation after an account deletion', () => {
  // REGRESSION: a live test deleted a business, then the old access token still
  // read /tenant and /customers for up to ACCESS_TOKEN_TTL_SECONDS.
  it('a deleted business blocks every token of that business, and no other', async () => {
    await revokeTenantAccess(TENANT);
    expect(await isAccessRevoked(TENANT, USER)).toBe(true);
    expect(await isAccessRevoked(TENANT, OTHER_USER)).toBe(true);
    expect(await isAccessRevoked(OTHER_TENANT, USER)).toBe(false);
  });

  it('a deleted sign-in blocks only that person in that business', async () => {
    await revokeUserAccess(TENANT, USER);
    expect(await isAccessRevoked(TENANT, USER)).toBe(true);
    expect(await isAccessRevoked(TENANT, OTHER_USER)).toBe(false);
    expect(await isAccessRevoked(OTHER_TENANT, USER)).toBe(false);
  });

  it('the mark outlives every access token already issued', async () => {
    await revokeTenantAccess(TENANT);
    const [entry] = [...store.values()];
    expect(entry?.ex).toBeGreaterThan(env.ACCESS_TOKEN_TTL_SECONDS);
  });

  it('fails open when Redis is down: the token then stops at its own expiry', async () => {
    await revokeTenantAccess(TENANT);
    state.failing = true;
    expect(await isAccessRevoked(TENANT, USER)).toBe(false);
    state.failing = false;
    state.ready = false;
    expect(await isAccessRevoked(TENANT, USER)).toBe(false);
  });

  it('a failed mark does not fail the deletion that called it', async () => {
    state.failing = true;
    await expect(revokeTenantAccess(TENANT)).resolves.toBeUndefined();
  });
});
