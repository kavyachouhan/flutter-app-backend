import type pg from 'pg';
import { env } from '../config/env.js';
import { databaseSslConfig } from './ssl.js';

/** Owner-role connection used by `migrate` and `db:bootstrap`; never by the API. */
export function migrationClientConfig(): pg.ClientConfig {
  if (!env.DATABASE_MIGRATION_URL) {
    throw new Error('DATABASE_MIGRATION_URL is required to run migrations or bootstrap.');
  }
  return {
    connectionString: env.DATABASE_MIGRATION_URL,
    ssl: databaseSslConfig(),
  };
}
