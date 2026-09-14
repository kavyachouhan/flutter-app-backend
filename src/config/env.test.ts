/**
 * Guard #3 from the plan: proof that the development auth bypass cannot reach
 * production.
 *
 * These assertions are the reason the bypass is safe to have at all. If
 * someone later "simplifies" the gate in env.ts, this suite fails in CI rather
 * than the bypass quietly shipping. Treat a failure here as a security
 * incident in the making, not a flaky test.
 *
 * The validators are tested directly against synthetic configuration objects
 * rather than by mutating process.env and re-importing — env.ts freezes its
 * result at import time, so a re-import would return the cached module.
 */
import { describe, expect, it } from 'vitest';
import { __testing } from './env.js';

const { envSchema, assertProductionSafety, assertCoherence } = __testing;

/** A configuration that is valid and safe for production. */
function productionConfig(overrides: Record<string, string> = {}) {
  return envSchema.parse({
    APP_ENV: 'production',
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://app_user:pw@db.example.supabase.co:6543/postgres',
    DATABASE_SSL: 'true',
    JWT_SECRET: 'Zq4mR8tK2wF6yB1nX9cV3hJ7sL5gD0pA',
    SMS_PROVIDER: 'msg91',
    SMS_API_KEY: 'real-key',
    CORS_ALLOWED_ORIGINS: 'https://app.example.com',
    LOG_PRETTY: 'false',
    ...overrides,
  });
}

describe('production safety gate', () => {
  it('accepts a correctly configured production environment', () => {
    expect(() => assertProductionSafety(productionConfig())).not.toThrow();
  });

  it('refuses to start when the auth bypass is enabled', () => {
    const config = productionConfig({ AUTH_DEV_BYPASS: 'true' });
    expect(() => assertProductionSafety(config)).toThrow(/AUTH_DEV_BYPASS/);
  });

  it('refuses to start when a fixed OTP is set', () => {
    const config = productionConfig({ AUTH_DEV_FIXED_OTP: '000000' });
    expect(() => assertProductionSafety(config)).toThrow(/AUTH_DEV_FIXED_OTP/);
  });

  it('refuses to start with the console SMS provider', () => {
    const config = productionConfig({ SMS_PROVIDER: 'console' });
    expect(() => assertProductionSafety(config)).toThrow(/SMS_PROVIDER/);
  });

  it('refuses to start with a placeholder JWT secret', () => {
    for (const secret of [
      'dev-only-insecure-secret-change-me-0123456789',
      'CHANGE-ME-this-is-a-placeholder-secret-value',
      'ci-only-secret-value-at-least-thirty-two-chars',
    ]) {
      const config = productionConfig({ JWT_SECRET: secret });
      expect(() => assertProductionSafety(config)).toThrow(/JWT_SECRET/);
    }
  });

  it('refuses to start when connecting as the Supabase `postgres` role', () => {
    // This role has BYPASSRLS: connecting as it silently disables every
    // tenant-isolation policy while the application still appears to work.
    const config = productionConfig({
      DATABASE_URL:
        'postgresql://postgres.abcdefgh:pw@aws-0-ap-south-1.pooler.supabase.com:6543/postgres',
    });
    expect(() => assertProductionSafety(config)).toThrow(/BYPASSRLS/);
  });

  it('accepts the same Supabase pooler host under the app_user role', () => {
    const config = productionConfig({
      DATABASE_URL: 'postgresql://app_user:pw@aws-0-ap-south-1.pooler.supabase.com:6543/postgres',
    });
    expect(() => assertProductionSafety(config)).not.toThrow();
  });

  it('refuses a wildcard CORS origin', () => {
    const config = productionConfig({ CORS_ALLOWED_ORIGINS: 'https://app.example.com,*' });
    expect(() => assertProductionSafety(config)).toThrow(/CORS/);
  });

  it('requires TLS to the database', () => {
    const config = productionConfig({ DATABASE_SSL: 'false' });
    expect(() => assertProductionSafety(config)).toThrow(/DATABASE_SSL/);
  });

  it('requires an API key when a real SMS provider is selected', () => {
    const config = envSchema.parse({
      APP_ENV: 'production',
      DATABASE_URL: 'postgresql://app_user:pw@host:6543/postgres',
      DATABASE_SSL: 'true',
      JWT_SECRET: 'Zq4mR8tK2wF6yB1nX9cV3hJ7sL5gD0pA',
      SMS_PROVIDER: 'twilio',
      CORS_ALLOWED_ORIGINS: 'https://app.example.com',
    });
    expect(() => assertProductionSafety(config)).toThrow(/SMS_API_KEY/);
  });

  it('reports every violation at once, not one per restart', () => {
    const config = productionConfig({
      AUTH_DEV_BYPASS: 'true',
      AUTH_DEV_FIXED_OTP: '000000',
      SMS_PROVIDER: 'console',
      DATABASE_SSL: 'false',
    });

    let message = '';
    try {
      assertProductionSafety(config);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toMatch(/AUTH_DEV_BYPASS/);
    expect(message).toMatch(/AUTH_DEV_FIXED_OTP/);
    expect(message).toMatch(/SMS_PROVIDER/);
    expect(message).toMatch(/DATABASE_SSL/);
    expect(message).toMatch(/4 unsafe setting/);
  });

  it('leaves development configurations alone', () => {
    const config = envSchema.parse({
      APP_ENV: 'development',
      DATABASE_URL: 'postgresql://khata:khata@localhost:5432/khata',
      JWT_SECRET: 'dev-only-insecure-secret-change-me-0123456789abcdef',
      AUTH_DEV_BYPASS: 'true',
      AUTH_DEV_FIXED_OTP: '000000',
      SMS_PROVIDER: 'console',
    });
    expect(() => assertProductionSafety(config)).not.toThrow();
  });
});

describe('coherence checks', () => {
  it('rejects a fixed OTP without the bypass switch', () => {
    const config = envSchema.parse({
      APP_ENV: 'development',
      DATABASE_URL: 'postgresql://khata:khata@localhost:5432/khata',
      JWT_SECRET: 'test-only-secret-value-at-least-32-characters',
      AUTH_DEV_BYPASS: 'false',
      AUTH_DEV_FIXED_OTP: '000000',
    });
    expect(() => assertCoherence(config)).toThrow(/AUTH_DEV_BYPASS/);
  });

  it('rejects a fixed OTP whose length could never match a real one', () => {
    const config = envSchema.parse({
      APP_ENV: 'development',
      DATABASE_URL: 'postgresql://khata:khata@localhost:5432/khata',
      JWT_SECRET: 'test-only-secret-value-at-least-32-characters',
      AUTH_DEV_BYPASS: 'true',
      AUTH_DEV_FIXED_OTP: '0000',
      OTP_LENGTH: '6',
    });
    expect(() => assertCoherence(config)).toThrow(/OTP_LENGTH/);
  });
});

describe('schema validation', () => {
  it('requires a JWT secret of at least 32 characters', () => {
    const result = envSchema.safeParse({
      DATABASE_URL: 'postgresql://khata:khata@localhost:5432/khata',
      JWT_SECRET: 'too-short',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-postgres database URL', () => {
    const result = envSchema.safeParse({
      DATABASE_URL: 'mysql://localhost:3306/khata',
      JWT_SECRET: 'test-only-secret-value-at-least-32-characters',
    });
    expect(result.success).toBe(false);
  });

  it('parses boolean strings correctly, including "false"', () => {
    // Boolean('false') is true. Getting this wrong turns every security
    // toggle into a permanently-on switch.
    const config = envSchema.parse({
      DATABASE_URL: 'postgresql://khata:khata@localhost:5432/khata',
      JWT_SECRET: 'test-only-secret-value-at-least-32-characters',
      AUTH_DEV_BYPASS: 'false',
      DATABASE_SSL: '0',
      METRICS_ENABLED: 'no',
    });
    expect(config.AUTH_DEV_BYPASS).toBe(false);
    expect(config.DATABASE_SSL).toBe(false);
    expect(config.METRICS_ENABLED).toBe(false);
  });

  it('parses a comma-separated origin list, trimming and de-duplicating', () => {
    const config = envSchema.parse({
      DATABASE_URL: 'postgresql://khata:khata@localhost:5432/khata',
      JWT_SECRET: 'test-only-secret-value-at-least-32-characters',
      CORS_ALLOWED_ORIGINS:
        ' https://a.example.com , https://b.example.com ,https://a.example.com,',
    });
    expect(config.CORS_ALLOWED_ORIGINS).toEqual(['https://a.example.com', 'https://b.example.com']);
  });
});
