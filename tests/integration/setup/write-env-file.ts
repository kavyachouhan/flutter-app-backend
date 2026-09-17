/**
 * Writes .env.development from the unit-test fixture plus the TEST_* secrets,
 * so CI can run `npm run migrate` and `npm run db:bootstrap` unchanged.
 *
 * Those scripts load .env.development via --env-file, and migrate.ts imports
 * src/config/env.ts, which requires every variable — so supplying three
 * database secrets is not enough on its own.
 *
 * Refuses to overwrite an existing file unless CI=true, because a developer's
 * .env.development holds credentials this cannot reproduce.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { testEnv } from '../../fixtures/env.js';

const TARGET = '.env.development';

if (existsSync(TARGET) && process.env['CI'] !== 'true') {
  console.error(`${TARGET} already exists. Refusing to overwrite it outside CI.`);
  process.exit(1);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required to generate ${TARGET}.`);
    process.exit(1);
  }
  return value;
}

const values: Record<string, string> = {
  ...testEnv,
  DATABASE_URL: required('TEST_DATABASE_URL'),
  DATABASE_MIGRATION_URL: required('TEST_DATABASE_MIGRATION_URL'),
  DATABASE_APP_ROLE_NAME: process.env['TEST_DATABASE_APP_ROLE_NAME'] ?? 'khata_api',
  DATABASE_APP_ROLE_PASSWORD: required('TEST_DATABASE_APP_ROLE_PASSWORD'),
  DATABASE_SSL: 'true',
  DATABASE_SSL_REJECT_UNAUTHORIZED: 'false',
  DATABASE_CONNECTION_TIMEOUT_MS: '15000',
  DATABASE_STATEMENT_TIMEOUT_MS: '15000',
  DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: '15000',
};

const body = Object.entries(values)
  .map(([key, value]) => `${key}=${value}`)
  .join('\n');

writeFileSync(TARGET, `${body}\n`, 'utf8');
console.log(`Wrote ${TARGET} with ${Object.keys(values).length} variables.`);
