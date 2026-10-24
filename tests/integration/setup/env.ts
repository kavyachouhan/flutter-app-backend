/**
 * Environment for the integration suite.
 *
 * Unit tests run entirely on tests/fixtures/env.ts, whose database URLs point
 * nowhere. Integration tests need a real database, so that fixture is reused
 * for everything else and only the connection settings are replaced — keeping
 * one source of truth for the ~97 variables src/config/env.ts requires.
 *
 * Opting in is deliberate. TEST_DATABASE_URL and TEST_DATABASE_MIGRATION_URL
 * must be set explicitly. The suite no longer truncates anything, but it still
 * writes test tenants and rows, so point it at a dedicated test database.
 */
import { testEnv } from '../../fixtures/env.js';

/** Local runs read .env.development; CI supplies the variables directly. */
function loadLocalEnvFile(): void {
  if (process.env['TEST_DATABASE_URL']) return;
  try {
    process.loadEnvFile('.env.development');
  } catch {
    // No file: CI, or a developer who exported the variables by hand.
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `${name} is required to run integration tests.\n` +
        'Add it to .env.development (or export it) pointing at a DEDICATED test\n' +
        'database. The suite writes test tenants and rows, so never point it at a\n' +
        'database whose contents you want to keep.',
    );
  }
  return value;
}

export interface IntegrationEnv {
  databaseUrl: string;
  migrationUrl: string;
  appRoleName: string;
  appRolePassword: string;
}

/**
 * Builds the full environment and applies it to process.env. Must run before
 * anything imports src/config/env.ts, which validates and freezes at import.
 */
export function applyIntegrationEnv(): IntegrationEnv {
  loadLocalEnvFile();

  const databaseUrl = required('TEST_DATABASE_URL');
  const migrationUrl = required('TEST_DATABASE_MIGRATION_URL');
  const appRoleName = process.env['TEST_DATABASE_APP_ROLE_NAME'] ?? 'khata_api';
  const appRolePassword = process.env['TEST_DATABASE_APP_ROLE_PASSWORD'] ?? '';

  const composed: Record<string, string> = {
    ...testEnv,
    DATABASE_URL: databaseUrl,
    DATABASE_MIGRATION_URL: migrationUrl,
    DATABASE_APP_ROLE_NAME: appRoleName,
    // Supavisor presents a chain Node does not trust; see .env.development.
    DATABASE_SSL: 'true',
    DATABASE_SSL_REJECT_UNAUTHORIZED: 'false',
    // Real network round trips, unlike the unit fixture's 1ms budgets.
    DATABASE_CONNECTION_TIMEOUT_MS: '15000',
    DATABASE_STATEMENT_TIMEOUT_MS: '15000',
    DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: '15000',
    DATABASE_POOL_MAX: '5',
  };
  if (appRolePassword) composed['DATABASE_APP_ROLE_PASSWORD'] = appRolePassword;

  // Redis stays unreachable on purpose: rate limiting fails open and dev-login
  // needs no OTP, so the suite requires no Redis. Set TEST_REDIS_URL to change.
  const redisUrl = process.env['TEST_REDIS_URL'];
  if (redisUrl) composed['REDIS_URL'] = redisUrl;

  Object.assign(process.env, composed);

  if (process.env['APP_ENV'] === 'production') {
    throw new Error('Refusing to run integration tests with APP_ENV=production.');
  }

  return { databaseUrl, migrationUrl, appRoleName, appRolePassword };
}

// Applied on import so this file works directly as a vitest setupFile.
export const integrationEnv = applyIntegrationEnv();
