/**
 * Runs once for the whole integration suite, before any test file.
 *
 * Verifies the schema is present and that the app role cannot bypass RLS, then
 * clears the database so a run never inherits rows from the last one.
 */
import { assertSchemaReady, closeOwnerClient, truncateAll } from './database.js';

export async function setup(): Promise<void> {
  await assertSchemaReady();
  await truncateAll();
  await closeOwnerClient();
}
