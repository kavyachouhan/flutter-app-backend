import { describe, expect, it } from 'vitest';
import {
  findDestructive,
  stripNoise,
  tenantTableProblems,
  unapprovedDestructive,
} from './migration-lint.js';

describe('migration lint helpers', () => {
  it('sees nothing destructive in a purely additive migration', () => {
    const sql = `
      SET LOCAL search_path = public, extensions;
      CREATE TABLE widgets (id UUID PRIMARY KEY);
      ALTER TABLE items ADD COLUMN note TEXT;
      CREATE INDEX widgets_id_idx ON widgets (id);
      CREATE OR REPLACE FUNCTION app.f() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;
    `;
    expect(findDestructive(sql)).toEqual([]);
  });

  it.each([
    ['DROP TABLE a;', 'DROP_TABLE'],
    ['TRUNCATE a;', 'TRUNCATE'],
    ['ALTER TABLE a DROP COLUMN b;', 'DROP_COLUMN'],
    ['DROP INDEX a_idx;', 'DROP_INDEX'],
    ['ALTER TABLE a DROP CONSTRAINT c;', 'DROP_CONSTRAINT'],
    ['DROP FUNCTION f();', 'DROP_FUNCTION'],
    ['DROP TRIGGER t ON a;', 'DROP_TRIGGER'],
    ['DROP POLICY p ON a;', 'DROP_POLICY'],
    ['DROP SCHEMA s;', 'DROP_SCHEMA'],
    ['DROP VIEW v;', 'DROP_VIEW'],
    ['DELETE FROM a WHERE id = 1;', 'DELETE_FROM'],
    ['UPDATE a SET b = 1;', 'UPDATE_WITHOUT_WHERE'],
    ['ALTER TABLE a ALTER COLUMN b TYPE BIGINT;', 'ALTER_COLUMN_TYPE'],
    ['ALTER TABLE a ALTER COLUMN b SET DATA TYPE BIGINT;', 'ALTER_COLUMN_TYPE'],
    ['ALTER TABLE a RENAME COLUMN b TO c;', 'RENAME'],
    ['ALTER TABLE a DISABLE ROW LEVEL SECURITY;', 'DISABLE_RLS'],
    ['ALTER TABLE a NO FORCE ROW LEVEL SECURITY;', 'DISABLE_RLS'],
  ])('flags %s', (sql, kind) => {
    expect(findDestructive(sql)).toContain(kind);
  });

  it('allows an UPDATE that has a WHERE', () => {
    expect(findDestructive('UPDATE a SET b = 1 WHERE c = 2;')).toEqual([]);
  });

  it('ignores keywords in comments, strings and function bodies', () => {
    const sql = `
      -- this used to DROP TABLE old_things, and DELETE FROM them
      /* TRUNCATE is mentioned here too */
      CREATE TABLE ok (id UUID);
      INSERT INTO ok VALUES ('DROP COLUMN is only text');
      CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $body$
        BEGIN DELETE FROM somewhere; UPDATE x SET y = 1; END
      $body$;
    `;
    expect(findDestructive(sql)).toEqual([]);
    expect(stripNoise(sql)).not.toMatch(/DROP TABLE/);
  });

  it('accepts a destructive statement only when its own kind is approved', () => {
    const sql = `
      -- destructive-ok: DROP_CONSTRAINT — replaced by the wider check on the next line
      ALTER TABLE a DROP CONSTRAINT c;
      ALTER TABLE a DROP COLUMN b;
    `;
    expect(unapprovedDestructive(sql)).toEqual(['DROP_COLUMN']);
  });

  it('requires setup_tenant_table, or an opt-out with hand-written RLS', () => {
    expect(tenantTableProblems(`CREATE TABLE t (id UUID);`)).toHaveLength(1);
    expect(
      tenantTableProblems(`CREATE TABLE t (id UUID); SELECT app.setup_tenant_table('t');`),
    ).toEqual([]);

    const optOutNoRls = `-- no-tenant-setup: t — bookkeeping, not synced\nCREATE TABLE t (id UUID);`;
    expect(tenantTableProblems(optOutNoRls).length).toBeGreaterThanOrEqual(3);

    const optOutWithRls = `
      -- no-tenant-setup: t — bookkeeping, not synced
      CREATE TABLE t (id UUID);
      ALTER TABLE t ENABLE ROW LEVEL SECURITY;
      ALTER TABLE t FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON t USING (true);
    `;
    expect(tenantTableProblems(optOutWithRls)).toEqual([]);
  });
});
