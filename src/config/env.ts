/**
 * Boot-time configuration.
 *
 * This is the ONLY module in the codebase permitted to read `process.env`
 * (enforced by a lint rule). Everything downstream imports the frozen, typed
 * `env` object, so a missing or malformed variable is a startup crash with a
 * readable message rather than an `undefined` that surfaces three weeks later
 * as a wrong tax total.
 *
 * The second half of this file is the production safety gate: a set of
 * assertions that refuse to let the process start if a development-only
 * convenience (the auth bypass, the console SMS provider, a placeholder
 * secret) is still enabled under `APP_ENV=production`. A leaked dev bypass is
 * total account takeover, so it fails closed, loudly, at boot.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { config as loadDotenv } from 'dotenv';

// ---------------------------------------------------------------------------
// .env loading
// ---------------------------------------------------------------------------

/**
 * Development loads `.env.development` (falling back to `.env`). Production
 * loads nothing: secrets are injected by the platform, and a stray .env file
 * on a production host is a finding, not a convenience.
 */
function loadEnvFile(): void {
  const appEnv = process.env['APP_ENV'] ?? 'development';
  if (appEnv === 'production') return;

  // `override: false` means a variable already set in the real environment
  // (CI, a shell export) wins over the file. That is what lets CI and the
  // integration tests point at a different database without editing files.
  loadDotenv({ path: `.env.${appEnv}`, override: false });
  loadDotenv({ path: '.env', override: false });
}

loadEnvFile();

// ---------------------------------------------------------------------------
// Reusable coercions
//
// Everything arrives from the environment as a string, so booleans and
// numbers need explicit, strict parsing — `Boolean('false')` is `true`, and
// that particular footgun has shipped security bugs in real products.
// ---------------------------------------------------------------------------

const boolFromString = (defaultValue: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'])
    .optional()
    .transform((value) => {
      if (value === undefined) return defaultValue;
      return value === 'true' || value === '1' || value === 'yes';
    });

const intFromString = (defaultValue: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(defaultValue);

/** Comma-separated list → trimmed, de-duplicated, empty entries dropped. */
const csvList = z
  .string()
  .default('')
  .transform((value) => [
    ...new Set(
      value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ]);

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const envSchema = z.object({
  // --- Environment ---------------------------------------------------------
  APP_ENV: z.enum(['development', 'production']).default('development'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: intFromString(3000, 1, 65535),
  HOST: z.string().min(1).default('0.0.0.0'),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),

  // --- Database ------------------------------------------------------------
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine((v) => v.startsWith('postgres://') || v.startsWith('postgresql://'), {
      message: 'DATABASE_URL must be a postgres:// or postgresql:// connection string',
    }),
  DATABASE_SSL: boolFromString(false),
  DATABASE_POOL_MAX: intFromString(10, 1, 100),
  DATABASE_STATEMENT_TIMEOUT_MS: intFromString(15_000, 100, 120_000),

  // --- Redis ---------------------------------------------------------------
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

  // --- Auth ----------------------------------------------------------------
  // 32 bytes is the floor for HS256 to carry its nominal security margin.
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_ISSUER: z.string().min(1).default('khata-api'),
  JWT_AUDIENCE: z.string().min(1).default('khata-clients'),
  ACCESS_TOKEN_TTL_SECONDS: intFromString(900, 60, 86_400),
  REFRESH_TOKEN_TTL_DAYS: intFromString(60, 1, 365),

  // --- OTP / SMS -----------------------------------------------------------
  SMS_PROVIDER: z.enum(['console', 'msg91', 'twilio']).default('console'),
  SMS_API_KEY: z.string().optional(),
  SMS_SENDER_ID: z.string().optional(),
  OTP_LENGTH: intFromString(6, 4, 8),
  OTP_TTL_SECONDS: intFromString(300, 60, 1800),
  OTP_MAX_ATTEMPTS: intFromString(5, 1, 10),

  // --- Development-only auth shortcuts -------------------------------------
  // Both are hard-refused under APP_ENV=production by the gate below.
  AUTH_DEV_BYPASS: boolFromString(false),
  AUTH_DEV_FIXED_OTP: z
    .string()
    .regex(/^\d{4,8}$/, 'AUTH_DEV_FIXED_OTP must be 4-8 digits')
    .optional(),

  // --- HTTP ----------------------------------------------------------------
  CORS_ALLOWED_ORIGINS: csvList,
  BODY_LIMIT: z.string().default('1mb'),
  TRUST_PROXY_HOPS: intFromString(0, 0, 10),

  // --- Rate limiting -------------------------------------------------------
  RATE_LIMIT_API_PER_MINUTE: intFromString(600, 1, 100_000),
  RATE_LIMIT_AUTH_PER_HOUR: intFromString(20, 1, 10_000),
  RATE_LIMIT_SYNC_PER_MINUTE: intFromString(120, 1, 100_000),

  // --- Observability -------------------------------------------------------
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  LOG_PRETTY: boolFromString(false),
  DOCS_ENABLED: boolFromString(false),
  METRICS_ENABLED: boolFromString(true),
});

type RawEnv = z.infer<typeof envSchema>;

// ---------------------------------------------------------------------------
// Production safety gate
// ---------------------------------------------------------------------------

/**
 * Secrets that ship in `.env.example` and every tutorial. If one of these
 * reaches production it means real secrets were never wired up.
 */
const PLACEHOLDER_SECRET_FRAGMENTS = [
  'dev-only',
  'change-me',
  'changeme',
  'insecure',
  'placeholder',
  'your-secret',
  'ci-only',
];

/**
 * Guard #1 of the three described in the plan.
 *
 * Collects *every* violation before throwing, so an operator fixing a
 * production config sees the full list in one go instead of discovering them
 * one restart at a time.
 */
function assertProductionSafety(parsed: RawEnv): void {
  if (parsed.APP_ENV !== 'production') return;

  const violations: string[] = [];

  if (parsed.AUTH_DEV_BYPASS) {
    violations.push(
      'AUTH_DEV_BYPASS is enabled. This exposes POST /v1/auth/dev-login, which mints tokens ' +
        'for any account with no credential check. It must be unset in production.',
    );
  }

  if (parsed.AUTH_DEV_FIXED_OTP !== undefined) {
    violations.push(
      'AUTH_DEV_FIXED_OTP is set. A fixed OTP accepted for every phone number is a complete ' +
        'authentication bypass. It must be unset in production.',
    );
  }

  if (parsed.SMS_PROVIDER === 'console') {
    violations.push(
      'SMS_PROVIDER=console only logs OTPs instead of delivering them, so no real user could ' +
        'ever sign in. Configure msg91 or twilio.',
    );
  }

  if (parsed.SMS_PROVIDER !== 'console' && !parsed.SMS_API_KEY) {
    violations.push(`SMS_API_KEY is required when SMS_PROVIDER=${parsed.SMS_PROVIDER}.`);
  }

  const secret = parsed.JWT_SECRET.toLowerCase();
  if (PLACEHOLDER_SECRET_FRAGMENTS.some((fragment) => secret.includes(fragment))) {
    violations.push(
      'JWT_SECRET still contains a placeholder value. Generate a real one: openssl rand -base64 48',
    );
  }

  if (parsed.CORS_ALLOWED_ORIGINS.includes('*')) {
    violations.push(
      'CORS_ALLOWED_ORIGINS contains "*". Credentialed cross-origin requests require an exact ' +
        'origin allowlist.',
    );
  }

  if (!parsed.DATABASE_SSL) {
    violations.push('DATABASE_SSL must be true in production.');
  }

  // Supabase's default `postgres` role carries BYPASSRLS, which would silently
  // disable every tenant-isolation policy in the database while everything
  // still appeared to work. This is the single most expensive mistake
  // available in this architecture, so it is checked explicitly.
  if (/:\/\/postgres[.:]/.test(parsed.DATABASE_URL)) {
    violations.push(
      'DATABASE_URL connects as the `postgres` role, which has BYPASSRLS and would disable ' +
        'every row-level tenant isolation policy. Connect as the dedicated `app_user` role.',
    );
  }

  if (parsed.LOG_PRETTY) {
    violations.push('LOG_PRETTY must be false in production so logs stay machine-parseable.');
  }

  if (violations.length > 0) {
    throw new Error(
      `Refusing to start: ${violations.length} unsafe setting(s) for APP_ENV=production.\n\n` +
        violations.map((v, i) => `  ${i + 1}. ${v}`).join('\n\n') +
        '\n',
    );
  }
}

/** Settings that are inconsistent in any environment. */
function assertCoherence(parsed: RawEnv): void {
  const violations: string[] = [];

  if (parsed.AUTH_DEV_FIXED_OTP !== undefined && !parsed.AUTH_DEV_BYPASS) {
    violations.push(
      'AUTH_DEV_FIXED_OTP is set but AUTH_DEV_BYPASS is false. Development auth shortcuts are ' +
        'controlled by a single switch; enable AUTH_DEV_BYPASS or unset the fixed OTP.',
    );
  }

  if (
    parsed.AUTH_DEV_FIXED_OTP !== undefined &&
    parsed.AUTH_DEV_FIXED_OTP.length !== parsed.OTP_LENGTH
  ) {
    violations.push(
      `AUTH_DEV_FIXED_OTP has ${parsed.AUTH_DEV_FIXED_OTP.length} digits but OTP_LENGTH is ` +
        `${parsed.OTP_LENGTH}. The fixed code would never match a real one.`,
    );
  }

  if (violations.length > 0) {
    throw new Error(
      `Refusing to start: incoherent configuration.\n\n` +
        violations.map((v, i) => `  ${i + 1}. ${v}`).join('\n\n') +
        '\n',
    );
  }
}

// ---------------------------------------------------------------------------
// Parse, validate, freeze
// ---------------------------------------------------------------------------

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
}

function buildEnv(): Readonly<RawEnv> & {
  readonly isProduction: boolean;
  readonly isDevelopment: boolean;
  readonly isTest: boolean;
  readonly version: string;
} {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    throw new Error(
      `Refusing to start: invalid environment configuration.\n\n${formatZodIssues(result.error)}\n\n` +
        `See .env.example for the full list of supported variables.\n`,
    );
  }

  const parsed = result.data;
  assertProductionSafety(parsed);
  assertCoherence(parsed);

  return Object.freeze({
    ...parsed,
    isProduction: parsed.APP_ENV === 'production',
    isDevelopment: parsed.APP_ENV === 'development',
    isTest: parsed.NODE_ENV === 'test',
    version: readPackageVersion(),
  });
}

/** Surfaced on /healthz and in every log line, so a deploy is identifiable. */
function readPackageVersion(): string {
  try {
    const url = new URL('../../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(url, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const env = buildEnv();

export type Env = typeof env;

/**
 * Exported for the CI test that asserts a production config plus a dev bypass
 * fails to boot. Tests call this with a synthetic object rather than mutating
 * the real `process.env`.
 */
export const __testing = { envSchema, assertProductionSafety, assertCoherence };
