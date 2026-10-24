/**
 * Runs once for the whole integration suite, before any test file.
 *
 * Verifies the schema is present and that the app role cannot bypass RLS.
 * It deliberately does NOT clear the database: existing rows are preserved.
 * Each test file creates its own tenant, so files do not depend on an empty
 * database.
 */
import { assertSchemaReady, closeOwnerClient } from './database.js';

export async function setup(): Promise<void> {
  await assertSchemaReady();
  await closeOwnerClient();
}
