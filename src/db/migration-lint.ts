/**
 * Static checks on a migration's SQL, kept apart from the vitest file so they can be tested
 * against small made-up migrations.
 *
 * Why: a migration runs once, forward-only, against real data. Anything that can remove or
 * rewrite existing rows, columns or objects must be a deliberate, visible decision, not
 * something that slips through review. The rules apply from migration 0035; earlier ones are
 * already applied and checksum-locked, and some legitimately widen a constraint.
 *
 * A destructive statement is allowed by naming it on its own comment line:
 *
 *     -- destructive-ok: DROP_CONSTRAINT — replaced by the wider check below
 */

/** First migration the strict rules apply to. */
export const FIRST_STRICT_MIGRATION = 35;

export type DestructiveKind =
  | 'DROP_TABLE'
  | 'TRUNCATE'
  | 'DROP_COLUMN'
  | 'DROP_INDEX'
  | 'DROP_CONSTRAINT'
  | 'DROP_FUNCTION'
  | 'DROP_TRIGGER'
  | 'DROP_POLICY'
  | 'DROP_SCHEMA'
  | 'DROP_VIEW'
  | 'DELETE_FROM'
  | 'UPDATE_WITHOUT_WHERE'
  | 'ALTER_COLUMN_TYPE'
  | 'RENAME'
  | 'DISABLE_RLS';

const PATTERNS: readonly (readonly [DestructiveKind, RegExp])[] = [
  ['DROP_TABLE', /\bDROP\s+TABLE\b/i],
  ['TRUNCATE', /\bTRUNCATE\b/i],
  ['DROP_COLUMN', /\bDROP\s+COLUMN\b/i],
  ['DROP_INDEX', /\bDROP\s+INDEX\b/i],
  ['DROP_CONSTRAINT', /\bDROP\s+CONSTRAINT\b/i],
  ['DROP_FUNCTION', /\bDROP\s+FUNCTION\b/i],
  ['DROP_TRIGGER', /\bDROP\s+TRIGGER\b/i],
  ['DROP_POLICY', /\bDROP\s+POLICY\b/i],
  ['DROP_SCHEMA', /\bDROP\s+SCHEMA\b/i],
  ['DROP_VIEW', /\bDROP\s+VIEW\b/i],
  ['DELETE_FROM', /\bDELETE\s+FROM\b/i],
  ['ALTER_COLUMN_TYPE', /\bALTER\s+COLUMN\s+\S+\s+(?:SET\s+DATA\s+)?TYPE\b/i],
  ['RENAME', /\bRENAME\b/i],
  ['DISABLE_RLS', /\b(?:DISABLE|NO\s+FORCE)\s+ROW\s+LEVEL\s+SECURITY\b/i],
];

/**
 * The SQL with everything that is not executed statement text blanked: function bodies, string
 * literals and comments. So a keyword in a comment, or in the body of a function the migration
 * only defines, is not mistaken for a statement the migration runs.
 */
export function stripNoise(sql: string): string {
  return sql
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

/** Every kind of destructive statement the migration runs. */
export function findDestructive(sql: string): DestructiveKind[] {
  const code = stripNoise(sql);
  const found = new Set<DestructiveKind>();
  for (const [kind, pattern] of PATTERNS) if (pattern.test(code)) found.add(kind);
  // An UPDATE with no WHERE rewrites every row of the table.
  for (const statement of code.split(';')) {
    if (/^\s*UPDATE\b/i.test(statement) && !/\bWHERE\b/i.test(statement)) {
      found.add('UPDATE_WITHOUT_WHERE');
    }
  }
  return [...found];
}

/** The kinds the migration has explicitly approved with a `-- destructive-ok:` comment. */
export function approvedKinds(sql: string): Set<string> {
  return new Set(
    [...sql.matchAll(/^\s*--\s*destructive-ok:\s*([A-Z_]+)/gim)].map((m) => m[1] as string),
  );
}

/** Destructive statements nobody signed off on. Empty means the migration is purely additive. */
export function unapprovedDestructive(sql: string): DestructiveKind[] {
  const approved = approvedKinds(sql);
  return findDestructive(sql).filter((kind) => !approved.has(kind));
}

/**
 * Problems with the tables a migration creates. Each needs `app.setup_tenant_table` (row-level
 * security, server_seq stamping), or an explicit
 *
 *     -- no-tenant-setup: <table> — <why it must not be in the change stream>
 *
 * together with hand-written RLS (ENABLE + FORCE + a policy), which is what `sync_batches` does.
 */
export function tenantTableProblems(sql: string): string[] {
  const problems: string[] = [];
  const code = stripNoise(sql);
  const created = [...code.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?([a-z_][a-z0-9_]*)\s*\(/gi)].map(
    (m) => m[1] as string,
  );
  const optedOut = new Set(
    [...sql.matchAll(/^\s*--\s*no-tenant-setup:\s*([a-z_][a-z0-9_]*)/gim)].map((m) => m[1] as string),
  );
  for (const table of created) {
    if (code.includes(`app.setup_tenant_table('${table}')`) || sql.includes(`app.setup_tenant_table('${table}')`)) {
      continue;
    }
    if (!optedOut.has(table)) {
      problems.push(`${table} needs app.setup_tenant_table, or a "-- no-tenant-setup: ${table}" opt-out`);
      continue;
    }
    if (!new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`, 'i').test(code)) {
      problems.push(`${table} opts out of setup_tenant_table but does not ENABLE ROW LEVEL SECURITY`);
    }
    if (!new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`, 'i').test(code)) {
      problems.push(`${table} opts out of setup_tenant_table but does not FORCE ROW LEVEL SECURITY`);
    }
    if (!new RegExp(`CREATE POLICY\\s+\\S+\\s+ON ${table}\\b`, 'i').test(code)) {
      problems.push(`${table} opts out of setup_tenant_table but has no RLS policy`);
    }
  }
  return problems;
}
