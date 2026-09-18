/**
 * TLS settings shared by the API pool and the migration client, so the two
 * can never drift (one verifying the chain, the other not).
 *
 * Supavisor presents a chain Node does not trust by default. Development may
 * skip verification (still encrypted); production must verify against the CA
 * supplied in DATABASE_SSL_CA — env.ts refuses to boot otherwise.
 */
import type { ConnectionOptions } from 'node:tls';
import { env } from '../config/env.js';

/**
 * A PEM injected through an environment variable usually arrives with the
 * newlines escaped as the two characters "\n"; restore them so OpenSSL parses it.
 */
function normalisePem(pem: string): string {
  return pem.includes('\\n') ? pem.replaceAll('\\n', '\n') : pem;
}

export function databaseSslConfig(): ConnectionOptions | false {
  if (!env.DATABASE_SSL) return false;
  const options: ConnectionOptions = {
    rejectUnauthorized: env.DATABASE_SSL_REJECT_UNAUTHORIZED,
  };
  if (env.DATABASE_SSL_CA) options.ca = normalisePem(env.DATABASE_SSL_CA);
  return options;
}
