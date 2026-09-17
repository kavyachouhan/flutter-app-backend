/**
 * Proof that development-only auth shortcuts cannot reach production. A
 * failure here is a security regression, not a flaky test.
 */
import { describe, expect, it } from 'vitest';
import { __testing } from './env.js';
import { testEnv } from '../../tests/fixtures/env.js';

const { envSchema, assertProductionSafety, assertCoherence } = __testing;

const SAFE_PRODUCTION: Record<string, string> = {
  ...testEnv,
  APP_ENV: 'production',
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://app_user.projref:pw@pooler.example.invalid:6543/postgres',
  DATABASE_APP_ROLE_NAME: 'app_user',
  DATABASE_SSL: 'true',
  DATABASE_SSL_REJECT_UNAUTHORIZED: 'true',
  DATABASE_SSL_CA: '-----BEGIN CERTIFICATE-----\\nMIIB\\n-----END CERTIFICATE-----',
  JWT_SECRET: 'Zq4mR8tK2wF6yB1nX9cV3hJ7sL5gD0pAq1w2',
  OTP_HASH_SECRET: 'Pa9sD8fG7hJ6kL5zX4cV3bN2mQ1wE0rTy7u6',
  OTP_DELIVERY_PROVIDER: 'twilio',
  TWILIO_API_BASE_URL: 'https://sms.invalid',
  TWILIO_ACCOUNT_SID: 'sid',
  TWILIO_AUTH_TOKEN: 'key',
  TWILIO_SENDER_ID: 'sender',
  TWILIO_OTP_MESSAGE_TEMPLATE: 'Code {code}',
  AUTH_DEV_BYPASS: 'false',
  AUTH_DEV_FIXED_OTP: '',
  CORS_ALLOWED_ORIGINS: 'https://app.invalid',
  LOG_PRETTY: 'false',
};

const parse = (overrides: Record<string, string> = {}) =>
  envSchema.parse({ ...SAFE_PRODUCTION, ...overrides });
const production =
  (overrides: Record<string, string> = {}) =>
  () =>
    assertProductionSafety(parse(overrides));

describe('production safety gate', () => {
  it('accepts a correctly configured production environment', () => {
    expect(production()).not.toThrow();
  });

  it.each([
    ['the dev auth bypass', { AUTH_DEV_BYPASS: 'true' }, /AUTH_DEV_BYPASS/],
    ['a fixed OTP', { AUTH_DEV_FIXED_OTP: '123456' }, /AUTH_DEV_FIXED_OTP/],
    [
      'the console OTP provider',
      { OTP_DELIVERY_PROVIDER: 'console' },
      /OTP_DELIVERY_PROVIDER=console/,
    ],
    ['the fake OTP provider', { OTP_DELIVERY_PROVIDER: 'fake' }, /OTP_DELIVERY_PROVIDER=fake/],
    [
      'an unverified database TLS chain',
      { DATABASE_SSL_REJECT_UNAUTHORIZED: 'false' },
      /DATABASE_SSL_REJECT_UNAUTHORIZED/,
    ],
    [
      'a placeholder JWT secret',
      { JWT_SECRET: 'test-only-jwt-secret-value-at-least-32-chars' },
      /JWT_SECRET/,
    ],
    [
      'a shared JWT and OTP secret',
      { OTP_HASH_SECRET: SAFE_PRODUCTION['JWT_SECRET'] ?? '' },
      /must differ/,
    ],
    ['a wildcard CORS origin', { CORS_ALLOWED_ORIGINS: 'https://app.invalid,*' }, /CORS/],
    ['a non-TLS database', { DATABASE_SSL: 'false' }, /DATABASE_SSL/],
    ['pretty logs', { LOG_PRETTY: 'true' }, /LOG_PRETTY/],
  ])('refuses %s', (_label, overrides, message) => {
    expect(production(overrides)).toThrow(message);
  });

  it.each(['postgres', 'supabase_admin', 'service_role'])(
    'refuses connecting as the RLS-bypassing %s role',
    (role) => {
      expect(
        production({
          DATABASE_URL: `postgresql://${role}.projref:pw@pooler.example.invalid:6543/postgres`,
        }),
      ).toThrow(/bypasses row-level security/);
    },
  );

  it('refuses a connection role that differs from DATABASE_APP_ROLE_NAME', () => {
    expect(production({ DATABASE_APP_ROLE_NAME: 'other_role' })).toThrow(
      /but DATABASE_APP_ROLE_NAME/,
    );
  });

  it('reports every violation at once', () => {
    expect(
      production({
        AUTH_DEV_BYPASS: 'true',
        OTP_DELIVERY_PROVIDER: 'console',
        DATABASE_SSL: 'false',
      }),
    ).toThrow(/3 unsafe setting/);
  });

  it('leaves development alone', () => {
    expect(() => assertProductionSafety(envSchema.parse(testEnv))).not.toThrow();
  });
});

describe('schema', () => {
  it('requires every tunable, treating blank as missing', () => {
    expect(envSchema.safeParse({ ...testEnv, PORT: '' }).success).toBe(false);
    const { OTP_TTL_SECONDS: _omitted, ...withoutTtl } = testEnv;
    expect(envSchema.safeParse(withoutTtl).success).toBe(false);
  });

  it('parses "false" as false', () => {
    expect(
      envSchema.parse({ ...testEnv, AUTH_DEV_BYPASS: 'false', AUTH_DEV_FIXED_OTP: '' })
        .AUTH_DEV_BYPASS,
    ).toBe(false);
  });

  it('parses list values', () => {
    const parsed = envSchema.parse({
      ...testEnv,
      GST_ALLOWED_RATES: '5, 18,5',
      CORS_ALLOWED_ORIGINS: 'a, b ,a,',
    });
    expect(parsed.GST_ALLOWED_RATES).toEqual([5, 18]);
    expect(parsed.CORS_ALLOWED_ORIGINS).toEqual(['a', 'b']);
  });

  it('treats unset plan limits as unlimited', () => {
    expect(
      envSchema.parse({ ...testEnv, PLAN_FREE_MAX_ITEMS: '' }).PLAN_FREE_MAX_ITEMS,
    ).toBeUndefined();
  });
});

describe('coherence', () => {
  it.each([
    ['a fixed OTP without the bypass', { AUTH_DEV_BYPASS: 'false' }, /requires AUTH_DEV_BYPASS/],
    ['a fixed OTP of the wrong length', { AUTH_DEV_FIXED_OTP: '12' }, /OTP_LENGTH/],
    ['a default page size above the max', { PAGE_SIZE_DEFAULT: '500' }, /PAGE_SIZE_DEFAULT/],
    [
      'a database CA without TLS',
      { DATABASE_SSL: 'false', DATABASE_SSL_CA: 'pem' },
      /DATABASE_SSL_CA has no effect/,
    ],
    [
      'an OTP provider missing one of its keys',
      {
        OTP_DELIVERY_PROVIDER: 'twilio',
        TWILIO_API_BASE_URL: 'https://sms.invalid',
        TWILIO_ACCOUNT_SID: 'sid',
        TWILIO_AUTH_TOKEN: 'key',
        TWILIO_OTP_MESSAGE_TEMPLATE: 'Code {code}',
      },
      /TWILIO_SENDER_ID is required for OTP_DELIVERY_PROVIDER=twilio/,
    ],
    [
      'msg91 without a template',
      {
        OTP_DELIVERY_PROVIDER: 'msg91',
        MSG91_API_BASE_URL: 'https://msg91.invalid',
        MSG91_AUTH_KEY: 'key',
      },
      /MSG91_TEMPLATE_ID is required/,
    ],
    [
      'a headers timeout not above keep-alive',
      { HTTP_HEADERS_TIMEOUT_MS: '5000' },
      /HTTP_HEADERS_TIMEOUT_MS/,
    ],
  ])('rejects %s', (_label, overrides, message) => {
    expect(() => assertCoherence(envSchema.parse({ ...testEnv, ...overrides }))).toThrow(message);
  });
});
