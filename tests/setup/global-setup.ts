/**
 * Runs once for the whole suite, before any test file.
 *
 * Its job is to guarantee the integration tests have a real Postgres with the
 * current schema. It does NOT mock anything: RLS policies, triggers and the
 * immutability constraints are a large part of what these tests verify, and
 * none of that exists in a mock.
 *
 * If Postgres is unreachable, the unit tests still run — they are pure — and
 * the integration tests skip with a clear message rather than failing with a
 * connection error that looks like a code bug.
 */
import { Client } from 'pg';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://khata:khata@localhost:5433/khata_test';

/** Set for the test files to read, so they can skip rather than error. */
export const DATABASE_AVAILABLE_FLAG = 'KHATA_TEST_DATABASE_AVAILABLE';

async function isReachable(): Promise<boolean> {
  const client = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function setup(): Promise<void> {
  const reachable = await isReachable();
  process.env[DATABASE_AVAILABLE_FLAG] = reachable ? 'true' : 'false';

  if (!reachable) {
    // eslint-disable-next-line no-console
    console.warn(
      `\n  Postgres is not reachable at ${DATABASE_URL}.\n` +
        `  Unit tests will run; integration tests will be skipped.\n` +
        `  Start it with:  docker compose up -d\n`,
    );
  }
}

export function teardown(): void {
  // Nothing global to tear down: each integration test file owns its own
  // connections and closes them in an afterAll hook.
}
