/**
 * The only module allowed to read `process.env` (enforced by lint).
 *
 * Every tunable is required: there are no in-code defaults, so a value can
 * only come from the environment and a missing one stops the process at boot
 * instead of silently falling back to a number nobody chose.
 *
 * Files are loaded by Node itself (`--env-file`, see package.json scripts);
 * production injects variables and loads no file.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';

// An unset variable in a .env file arrives as '', and `z.coerce.number()`
// turns '' into 0 — which would satisfy "non-negative" and hide the omission.
const blankToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const required = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(blankToUndefined, schema);
const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(blankToUndefined, schema.optional());

// `Boolean('false') === true`, so booleans accept an explicit vocabulary only.
const bool = z.enum(['true', 'false']).transform((value) => value === 'true');
const int = z.coerce.number().int();
const positiveInt = int.positive();
const nonNegativeInt = int.nonnegative();
const port = int.min(1).max(65_535);

const csv = z.string().transform((value) => [
  ...new Set(
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  ),
]);

const csvNumbers = csv.pipe(z.array(z.coerce.number().finite().nonnegative()).nonempty());

const postgresUrl = z
  .string()
  .url()
  .refine((value) => /^postgres(ql)?:\/\//.test(value), 'must be a postgres:// connection string');

const envSchema = z.object({
  // --- Runtime --------------------------------------------------------------
  APP_ENV: required(z.enum(['development', 'production'])),
  NODE_ENV: required(z.enum(['development', 'test', 'production'])),
  SERVICE_NAME: required(z.string().min(1)),
  HOST: required(z.string().min(1)),
  PORT: required(port),
  PUBLIC_BASE_URL: required(z.string().url()),

  // --- Database (Supabase) --------------------------------------------------
  DATABASE_URL: required(postgresUrl),
  DATABASE_MIGRATION_URL: optional(postgresUrl),
  DATABASE_APP_ROLE_NAME: required(z.string().regex(/^[a-z_][a-z0-9_]*$/)),
  DATABASE_APP_ROLE_PASSWORD: optional(z.string().min(1)),
  DATABASE_SSL: required(bool),
  DATABASE_SSL_REJECT_UNAUTHORIZED: required(bool),
  // PEM of the CA that signs the pooler's certificate. Production must verify
  // the chain, and Node does not trust Supavisor's by default.
  DATABASE_SSL_CA: optional(z.string().min(1)),
  DATABASE_POOL_MAX: required(positiveInt),
  DATABASE_POOL_IDLE_TIMEOUT_MS: required(positiveInt),
  DATABASE_CONNECTION_TIMEOUT_MS: required(positiveInt),
  DATABASE_STATEMENT_TIMEOUT_MS: required(positiveInt),
  DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: required(positiveInt),
  DATABASE_TRANSACTION_MAX_RETRIES: required(nonNegativeInt),
  DATABASE_RETRY_BASE_DELAY_MS: required(positiveInt),

  // --- Redis ----------------------------------------------------------------
  REDIS_URL: required(z.string().min(1)),
  REDIS_KEY_PREFIX: required(z.string().min(1)),
  REDIS_CONNECT_TIMEOUT_MS: required(positiveInt),
  REDIS_COMMAND_TIMEOUT_MS: required(positiveInt),
  REDIS_MAX_RETRIES_PER_REQUEST: required(nonNegativeInt),
  REDIS_RECONNECT_STEP_MS: required(positiveInt),
  REDIS_RECONNECT_MAX_DELAY_MS: required(positiveInt),

  // --- Tokens ---------------------------------------------------------------
  // RFC 7518 §3.2: an HS256 key must be at least as long as the hash output.
  JWT_SECRET: required(z.string().min(32)),
  JWT_ISSUER: required(z.string().min(1)),
  JWT_AUDIENCE: required(z.string().min(1)),
  ACCESS_TOKEN_TTL_SECONDS: required(positiveInt),
  IDENTITY_TOKEN_TTL_SECONDS: required(positiveInt),
  REFRESH_TOKEN_TTL_DAYS: required(positiveInt),
  REFRESH_TOKEN_BYTES: required(positiveInt),
  REFRESH_TOKEN_REUSE_GRACE_SECONDS: required(nonNegativeInt),

  // --- OTP / SMS ------------------------------------------------------------
  OTP_HASH_SECRET: required(z.string().min(32)),
  OTP_LENGTH: required(positiveInt),
  OTP_TTL_SECONDS: required(positiveInt),
  OTP_MAX_ATTEMPTS: required(positiveInt),
  OTP_RESEND_COOLDOWN_SECONDS: required(positiveInt),
  PHONE_DEFAULT_COUNTRY_CODE: required(z.string().regex(/^[1-9]\d{0,2}$/)),
  PHONE_NATIONAL_NUMBER_LENGTH: required(positiveInt),

  // --- OTP delivery ---------------------------------------------------------
  // The vendor is expected to change; a provider is one file under
  // src/modules/auth/delivery/providers plus its own keys below. `console`
  // and `fake` never deliver and are refused in production.
  OTP_DELIVERY_PROVIDER: required(z.enum(['console', 'fake', 'twilio', 'msg91'])),
  OTP_DELIVERY_TIMEOUT_MS: required(positiveInt),

  TWILIO_API_BASE_URL: optional(z.string().url()),
  TWILIO_ACCOUNT_SID: optional(z.string().min(1)),
  TWILIO_AUTH_TOKEN: optional(z.string().min(1)),
  TWILIO_SENDER_ID: optional(z.string().min(1)),
  TWILIO_OTP_MESSAGE_TEMPLATE: optional(z.string().includes('{code}')),

  MSG91_API_BASE_URL: optional(z.string().url()),
  MSG91_AUTH_KEY: optional(z.string().min(1)),
  MSG91_TEMPLATE_ID: optional(z.string().min(1)),

  // Development-only; refused under APP_ENV=production.
  AUTH_DEV_BYPASS: required(bool),
  AUTH_DEV_FIXED_OTP: optional(z.string().regex(/^\d+$/)),

  // --- HTTP -----------------------------------------------------------------
  CORS_ALLOWED_ORIGINS: required(csv),
  CORS_MAX_AGE_SECONDS: required(nonNegativeInt),
  BODY_LIMIT: required(z.string().min(1)),
  TRUST_PROXY_HOPS: required(nonNegativeInt),
  COMPRESSION_THRESHOLD_BYTES: required(nonNegativeInt),
  HSTS_MAX_AGE_SECONDS: required(nonNegativeInt),
  HTTP_KEEP_ALIVE_TIMEOUT_MS: required(positiveInt),
  HTTP_HEADERS_TIMEOUT_MS: required(positiveInt),
  SHUTDOWN_TIMEOUT_MS: required(positiveInt),

  // --- Rate limiting --------------------------------------------------------
  RATE_LIMIT_API_POINTS: required(positiveInt),
  RATE_LIMIT_API_WINDOW_SECONDS: required(positiveInt),
  RATE_LIMIT_OTP_REQUEST_POINTS: required(positiveInt),
  RATE_LIMIT_OTP_REQUEST_WINDOW_SECONDS: required(positiveInt),
  RATE_LIMIT_OTP_VERIFY_POINTS: required(positiveInt),
  RATE_LIMIT_OTP_VERIFY_WINDOW_SECONDS: required(positiveInt),
  RATE_LIMIT_REFRESH_POINTS: required(positiveInt),
  RATE_LIMIT_REFRESH_WINDOW_SECONDS: required(positiveInt),
  // Per device, on /sync/* and number-block leases.
  RATE_LIMIT_SYNC_POINTS: required(positiveInt),
  RATE_LIMIT_SYNC_WINDOW_SECONDS: required(positiveInt),

  // --- Sync -----------------------------------------------------------------
  // Rows per pull page (the client keeps paging while hasMore is true).
  SYNC_PULL_MAX_CHANGES: required(positiveInt),
  // Operations per push batch; larger batches are rejected outright.
  SYNC_PUSH_MAX_OPERATIONS: required(positiveInt),
  // A pull tops up a device's block for a series when fewer numbers remain.
  SYNC_LEASE_TOPUP_THRESHOLD: required(positiveInt),
  // Days before a financial year ends at which next year's series are created
  // and pre-leased, so an offline device survives the rollover.
  SYNC_FY_ROLLOVER_LEAD_DAYS: required(positiveInt),

  // --- Pagination -----------------------------------------------------------
  PAGE_SIZE_DEFAULT: required(positiveInt),
  PAGE_SIZE_MAX: required(positiveInt),

  // --- GST / numbering ------------------------------------------------------
  // Rates and the document-number length are set by law and have changed
  // before, so they are configuration rather than constants.
  GST_ALLOWED_RATES: required(csvNumbers),
  DOCUMENT_NUMBER_MAX_LENGTH: required(positiveInt),
  DOCUMENT_SEQUENCE_MIN_HEADROOM: required(positiveInt),
  NUMBER_BLOCK_SIZE_DEFAULT: required(positiveInt),
  NUMBER_BLOCK_SIZE_MAX: required(positiveInt),
  NUMBER_BLOCK_TTL_HOURS: required(positiveInt),

  // --- Tenant onboarding defaults -------------------------------------------
  TENANT_DEFAULT_LOCALE: required(z.string().min(1)),
  TENANT_DEFAULT_TIMEZONE: required(z.string().min(1)),
  TENANT_DEFAULT_CURRENCY_CODE: required(z.string().length(3)),
  TENANT_DEFAULT_CURRENCY_SYMBOL: required(z.string().min(1)),
  TENANT_DEFAULT_FY_START_MONTH: required(int.min(1).max(12)),
  TENANT_DEFAULT_ALLOW_NEGATIVE_STOCK: required(bool),
  TENANT_DEFAULT_PRICES_INCLUDE_TAX: required(bool),

  // --- Free plan limits (unset = unlimited) ---------------------------------
  PLAN_FREE_MAX_USERS: optional(positiveInt),
  PLAN_FREE_MAX_OUTLETS: optional(positiveInt),
  PLAN_FREE_MAX_COUNTERS: optional(positiveInt),
  PLAN_FREE_MAX_ITEMS: optional(positiveInt),
  // Feature keys granted on the free plan; unset grants none. Gating is
  // configuration, not code, so support can unlock one feature for one
  // customer without a deploy.
  PLAN_FREE_FEATURES: optional(csv),

  // --- OpenAPI --------------------------------------------------------------
  // Serves GET /v1/openapi.json and the Swagger UI at /v1/docs, unauthenticated.
  OPENAPI_ENABLED: required(bool),
  OPENAPI_TITLE: required(z.string().min(1)),
  // Base URL clients should call, as printed in the document's `servers`.
  OPENAPI_SERVER_URL: required(z.string().url()),

  // --- Observability --------------------------------------------------------
  LOG_LEVEL: required(z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])),
  LOG_PRETTY: required(bool),
  METRICS_ENABLED: required(bool),
  METRICS_PREFIX: required(z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/)),
  METRICS_LATENCY_BUCKETS_SECONDS: required(csvNumbers),
});

type RawEnv = z.infer<typeof envSchema>;

/**
 * Keys each OTP delivery provider needs. Checked in every environment, so
 * choosing a provider without configuring it fails at boot rather than on
 * the first sign-in attempt.
 */
const OTP_PROVIDER_REQUIRED_KEYS = {
  console: [],
  fake: [],
  twilio: [
    'TWILIO_API_BASE_URL',
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_SENDER_ID',
    'TWILIO_OTP_MESSAGE_TEMPLATE',
  ],
  msg91: ['MSG91_API_BASE_URL', 'MSG91_AUTH_KEY', 'MSG91_TEMPLATE_ID'],
} as const satisfies Record<RawEnv['OTP_DELIVERY_PROVIDER'], readonly (keyof RawEnv)[]>;

/** Providers that only pretend to deliver. */
const NON_DELIVERING_OTP_PROVIDERS: readonly RawEnv['OTP_DELIVERY_PROVIDER'][] = [
  'console',
  'fake',
];

// Fragments that only appear in sample or test secrets.
const PLACEHOLDER_SECRET_FRAGMENTS = [
  'dev-only',
  'test-only',
  'change-me',
  'changeme',
  'placeholder',
  'insecure',
  'example',
];

// Supabase roles that bypass RLS or own the schema. Connecting the API as any
// of them silently disables every tenant-isolation policy.
const SUPABASE_PRIVILEGED_ROLES = ['postgres', 'supabase_admin', 'service_role'];

function fail(title: string, violations: string[]): never {
  throw new Error(
    `Refusing to start: ${title}\n\n${violations.map((v, i) => `  ${i + 1}. ${v}`).join('\n\n')}\n`,
  );
}

/** The login role in a connection string, with Supavisor's `.<project-ref>` suffix removed. */
function connectionRole(url: string): string {
  return decodeURIComponent(new URL(url).username).split('.')[0] ?? '';
}

function assertProductionSafety(parsed: RawEnv): void {
  if (parsed.APP_ENV !== 'production') return;
  const violations: string[] = [];

  if (parsed.AUTH_DEV_BYPASS) {
    violations.push('AUTH_DEV_BYPASS mints tokens with no credential check; it must be false.');
  }
  if (parsed.AUTH_DEV_FIXED_OTP !== undefined) {
    violations.push('AUTH_DEV_FIXED_OTP is an OTP accepted for every phone; it must be unset.');
  }
  if (NON_DELIVERING_OTP_PROVIDERS.includes(parsed.OTP_DELIVERY_PROVIDER)) {
    violations.push(
      `OTP_DELIVERY_PROVIDER=${parsed.OTP_DELIVERY_PROVIDER} never delivers an OTP, so nobody could sign in.`,
    );
  }

  for (const key of ['JWT_SECRET', 'OTP_HASH_SECRET'] as const) {
    const value = parsed[key].toLowerCase();
    if (PLACEHOLDER_SECRET_FRAGMENTS.some((fragment) => value.includes(fragment))) {
      violations.push(`${key} is a placeholder. Generate one: openssl rand -base64 48`);
    }
  }
  if (parsed.JWT_SECRET === parsed.OTP_HASH_SECRET) {
    violations.push('JWT_SECRET and OTP_HASH_SECRET must differ.');
  }

  if (parsed.CORS_ALLOWED_ORIGINS.includes('*')) {
    violations.push('CORS_ALLOWED_ORIGINS must be an exact allowlist, not "*".');
  }
  if (!parsed.DATABASE_SSL) {
    violations.push('DATABASE_SSL must be true.');
  }
  if (!parsed.DATABASE_SSL_REJECT_UNAUTHORIZED) {
    violations.push(
      'DATABASE_SSL_REJECT_UNAUTHORIZED must be true; supply the pooler CA in DATABASE_SSL_CA.',
    );
  }

  const role = connectionRole(parsed.DATABASE_URL);
  if (SUPABASE_PRIVILEGED_ROLES.includes(role)) {
    violations.push(
      `DATABASE_URL connects as "${role}", which bypasses row-level security. ` +
        `Connect as ${parsed.DATABASE_APP_ROLE_NAME} (created by db:bootstrap).`,
    );
  } else if (role !== parsed.DATABASE_APP_ROLE_NAME) {
    violations.push(
      `DATABASE_URL connects as "${role}" but DATABASE_APP_ROLE_NAME is ` +
        `"${parsed.DATABASE_APP_ROLE_NAME}".`,
    );
  }

  if (parsed.LOG_PRETTY) {
    violations.push('LOG_PRETTY must be false so logs stay machine-parseable.');
  }

  if (violations.length > 0) {
    fail(`${violations.length} unsafe setting(s) for APP_ENV=production.`, violations);
  }
}

function assertCoherence(parsed: RawEnv): void {
  const violations: string[] = [];

  if (parsed.AUTH_DEV_FIXED_OTP !== undefined) {
    if (!parsed.AUTH_DEV_BYPASS) {
      violations.push('AUTH_DEV_FIXED_OTP requires AUTH_DEV_BYPASS=true.');
    }
    if (parsed.AUTH_DEV_FIXED_OTP.length !== parsed.OTP_LENGTH) {
      violations.push('AUTH_DEV_FIXED_OTP must be OTP_LENGTH digits long.');
    }
  }
  if (parsed.DATABASE_SSL_CA !== undefined && !parsed.DATABASE_SSL) {
    violations.push('DATABASE_SSL_CA has no effect while DATABASE_SSL=false.');
  }
  for (const key of OTP_PROVIDER_REQUIRED_KEYS[parsed.OTP_DELIVERY_PROVIDER]) {
    if (!parsed[key]) {
      violations.push(
        `${key} is required for OTP_DELIVERY_PROVIDER=${parsed.OTP_DELIVERY_PROVIDER}.`,
      );
    }
  }
  if (parsed.PAGE_SIZE_DEFAULT > parsed.PAGE_SIZE_MAX) {
    violations.push('PAGE_SIZE_DEFAULT cannot exceed PAGE_SIZE_MAX.');
  }
  if (parsed.NUMBER_BLOCK_SIZE_DEFAULT > parsed.NUMBER_BLOCK_SIZE_MAX) {
    violations.push('NUMBER_BLOCK_SIZE_DEFAULT cannot exceed NUMBER_BLOCK_SIZE_MAX.');
  }
  // Node closes a keep-alive socket that is still waiting on headers otherwise,
  // producing intermittent 502s behind a load balancer.
  if (parsed.HTTP_HEADERS_TIMEOUT_MS <= parsed.HTTP_KEEP_ALIVE_TIMEOUT_MS) {
    violations.push('HTTP_HEADERS_TIMEOUT_MS must be greater than HTTP_KEEP_ALIVE_TIMEOUT_MS.');
  }

  if (violations.length > 0) fail('incoherent configuration.', violations);
}

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function buildEnv() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    fail(
      'invalid environment configuration. See .env.example.',
      result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }

  const parsed = result.data;
  assertProductionSafety(parsed);
  assertCoherence(parsed);

  return Object.freeze({
    ...parsed,
    GST_ALLOWED_RATES: new Set<number>(parsed.GST_ALLOWED_RATES),
    isProduction: parsed.APP_ENV === 'production',
    isDevelopment: parsed.APP_ENV === 'development',
    version: readPackageVersion(),
  });
}

export const env = buildEnv();
export type Env = typeof env;

export const __testing = { envSchema, assertProductionSafety, assertCoherence };
