import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Rules a new migration must follow, found out the hard way.
 *
 * Migration 0020 created a table and forgot the closing `grant_runtime_privileges()`, so the
 * API role could not touch it and every request failed until 0021 repaired it. Nothing in the
 * unit suite could notice, because it never reaches Postgres. This reads the SQL instead.
 *
 * Applied migrations are checksum-locked and cannot be edited, so the rules start where the
 * mistake was last made: migrations from 0023 on.
 */
const DIR = fileURLToPath(new URL('./migrations/', import.meta.url));
const FIRST_CHECKED = 23;

const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .filter((f) => Number(/^(\d+)_/.exec(f)?.[1]) >= FIRST_CHECKED)
  .sort();

describe('migrations from 0023 on', () => {
  it('has some to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const sql = readFileSync(`${DIR}${file}`, 'utf8');

    it(`${file} sets the search path first`, () => {
      expect(sql).toMatch(/SET LOCAL search_path = public, extensions;/);
    });

    it(`${file} ends by granting the runtime role its privileges`, () => {
      const statements = sql
        .split('\n')
        .filter((line) => !line.trim().startsWith('--') && line.trim().length > 0)
        .join('\n')
        .trim();
      expect(statements.endsWith('SELECT app.grant_runtime_privileges();')).toBe(true);
    });

    it(`${file} sets up every tenant table it creates`, () => {
      const created = [...sql.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?([a-z_]+)\s*\(/gi)].map(
        (m) => m[1],
      );
      for (const table of created) {
        expect(
          sql.includes(`app.setup_tenant_table('${table}')`),
          `${table} needs app.setup_tenant_table`,
        ).toBe(true);
      }
    });

    it(`${file} never edits an earlier migration's objects destructively without saying so`, () => {
      // A DROP TABLE or TRUNCATE in a forward-only migration loses data; it must be a decision.
      expect(sql).not.toMatch(/\bDROP TABLE\b|\bTRUNCATE\b/i);
    });
  }
});
