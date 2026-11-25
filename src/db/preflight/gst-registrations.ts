/**
 * GST registration preflight (A0b, freeze §9 "Step 0"). Read-only: it runs in a
 * READ ONLY transaction and writes a JSON + Markdown report. Migration 0037 refuses to
 * run while any blocking category below is non-empty; nothing here guesses a mapping.
 *
 *   npx tsx --env-file=.env.development src/db/preflight/gst-registrations.ts [--out <dir>]
 *
 * Targets DATABASE_MIGRATION_URL (owner role), like `migrate`. To check TEST, override it
 * on the command line, exactly as for applying migrations to TEST.
 *
 * How each existing document's registration is resolved (never from a counterparty):
 *  - outlet registration = the outlet's GSTIN, else the tenant's (today's override rule);
 *  - outward documents use the outlet's registration; the stored seller GSTIN is a
 *    cross-check, accepted when it is another registration of the same tenant;
 *  - inward documents use the outlet's registration — the tenant's own, receiving side.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { gstinProblem } from '../../domain/gst/gstin.js';
import { migrationClientConfig } from '../migration-client.js';

/** Registration effective date when nothing better is recorded: the GST start date. */
export const DEFAULT_REGISTRATION_START = '2017-07-01';

export interface PreflightCategory {
  readonly id: string;
  readonly title: string;
  readonly blocking: boolean;
  readonly rows: readonly Record<string, unknown>[];
}

export interface DerivedRegistration {
  readonly tenantId: string;
  readonly gstin: string;
  readonly stateCode: string;
  readonly outletIds: readonly string[];
  readonly effectiveFrom: string;
  readonly composition: boolean;
}

export interface DocumentResolution {
  readonly table: string;
  readonly id: string;
  readonly tenantId: string;
  readonly documentNumber: string;
  readonly documentDate: string;
  readonly resolution: 'resolved' | 'non_gst' | 'legacy_unresolved';
  readonly registrationGstin: string | null;
  readonly reason: string;
}

export interface PreflightReport {
  readonly generatedAt: string;
  readonly blockingCount: number;
  readonly categories: readonly PreflightCategory[];
  readonly derivedRegistrations: readonly DerivedRegistration[];
  readonly resolutionCounts: Readonly<Record<string, number>>;
  /** Documents that would be stored as `legacy_unresolved` (quarantined). */
  readonly quarantine: readonly DocumentResolution[];
}

/** Every outlet with the GSTIN it resolves to today and the tenant's registered flags. */
const OUTLET_REG = `
  SELECT o.id AS outlet_id, o.tenant_id, o.gstin AS outlet_gstin, t.gstin AS tenant_gstin,
         COALESCE(o.gstin, t.gstin) AS gstin,
         COALESCE(o.state_code, t.state_code) AS state_code,
         CASE WHEN o.gstin IS NULL AND t.gstin IS NOT NULL
              THEN COALESCE(t.registration_effective_from, DATE '${DEFAULT_REGISTRATION_START}')
              ELSE DATE '${DEFAULT_REGISTRATION_START}' END AS effective_from,
         t.is_gst_registered, t.is_composition, o.deleted_at
    FROM outlets o JOIN tenants t ON t.id = o.tenant_id`;

/** Every GSTIN the tenant holds (its own and its outlets'). */
const TENANT_GSTINS = `
  SELECT id AS tenant_id, gstin FROM tenants WHERE gstin IS NOT NULL
  UNION
  SELECT tenant_id, gstin FROM outlets WHERE gstin IS NOT NULL`;

const DOCUMENT_TABLES = [
  { table: 'invoices', side: 'outward' },
  { table: 'credit_notes', side: 'outward' },
  { table: 'purchase_bills', side: 'inward' },
  { table: 'debit_notes', side: 'inward' },
] as const;

async function rows<T extends Record<string, unknown>>(client: pg.ClientBase, sql: string): Promise<T[]> {
  return (await client.query<T>(sql)).rows;
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
}

/** Resolves one document table; the CASE mirrors freeze §9 exactly. */
function resolutionSql(table: string, side: 'outward' | 'inward'): string {
  const registrationInForce = 'r.gstin IS NOT NULL AND d.document_date >= r.effective_from';
  const outward = `
    CASE
      WHEN d.supplier_gstin IS NOT NULL AND d.supplier_gstin = r.gstin THEN 'resolved'
      WHEN d.supplier_gstin IS NOT NULL AND EXISTS (
             SELECT 1 FROM (${TENANT_GSTINS}) g WHERE g.tenant_id = d.tenant_id AND g.gstin = d.supplier_gstin)
        THEN 'resolved_by_snapshot'
      WHEN d.supplier_gstin IS NOT NULL THEN 'unresolved:seller GSTIN is not one of the tenant''s registrations'
      WHEN d.tax_mode = 'non_gst' AND NOT (${registrationInForce}) THEN 'non_gst'
      WHEN d.tax_mode = 'non_gst' THEN 'unresolved:non-GST document from an outlet registered on that date'
      ELSE 'unresolved:GST document without a seller GSTIN'
    END`;
  const inward = `
    CASE
      WHEN ${registrationInForce} THEN 'resolved'
      WHEN d.tax_mode = 'non_gst' THEN 'non_gst'
      WHEN r.gstin IS NOT NULL THEN 'unresolved:receiving registration not in force on the document date'
      ELSE 'unresolved:GST document from an outlet with no registration'
    END`;
  return `
    SELECT '${table}' AS "table", d.id, d.tenant_id, d.document_number, d.document_date,
           d.supplier_gstin, r.gstin AS outlet_gstin, ${side === 'outward' ? outward : inward} AS outcome
      FROM ${table} d JOIN (${OUTLET_REG}) r ON r.outlet_id = d.outlet_id`;
}

export async function collectPreflight(client: pg.ClientBase): Promise<PreflightReport> {
  const categories: PreflightCategory[] = [];
  const add = (id: string, title: string, blocking: boolean, found: readonly Record<string, unknown>[]): void => {
    categories.push({ id, title, blocking, rows: found });
  };

  add(
    'gstin_on_several_tenants',
    'Same GSTIN on more than one tenant',
    true,
    await rows(
      client,
      `SELECT gstin, array_agg(DISTINCT tenant_id ORDER BY tenant_id) AS tenant_ids
         FROM (${TENANT_GSTINS}) g GROUP BY gstin HAVING count(DISTINCT tenant_id) > 1 ORDER BY gstin`,
    ),
  );

  add(
    'gstin_state_mismatch',
    "Outlet GSTIN prefix differs from the outlet's state (or the tenant's, when the outlet has none)",
    true,
    await rows(
      client,
      `SELECT outlet_id, tenant_id, gstin, state_code FROM (${OUTLET_REG}) r
        WHERE gstin IS NOT NULL AND deleted_at IS NULL AND left(gstin, 2) IS DISTINCT FROM state_code
        ORDER BY tenant_id, outlet_id`,
    ),
  );

  const registrationGstins = await rows<{ source: string; id: string; gstin: string }>(
    client,
    `SELECT 'tenant' AS source, id, gstin FROM tenants WHERE gstin IS NOT NULL
     UNION ALL SELECT 'outlet', id, gstin FROM outlets WHERE gstin IS NOT NULL AND deleted_at IS NULL`,
  );
  add(
    'invalid_registration_gstin',
    'Tenant or outlet GSTIN fails format, state code or mod-36 checksum',
    true,
    registrationGstins
      .map((r) => ({ ...r, problem: gstinProblem(r.gstin) }))
      .filter((r) => r.problem !== null),
  );

  const partyGstins = await rows<{ source: string; id: string; tenant_id: string; gstin: string }>(
    client,
    `SELECT 'customer' AS source, id, tenant_id, gstin FROM customers WHERE gstin IS NOT NULL AND deleted_at IS NULL
     UNION ALL
     SELECT 'supplier', id, tenant_id, gstin FROM suppliers WHERE gstin IS NOT NULL AND deleted_at IS NULL`,
  );
  add(
    'invalid_party_gstin',
    'Customer or supplier GSTIN fails validation (CHECK added NOT VALID; re-validated at next edit)',
    false,
    partyGstins.map((r) => ({ ...r, problem: gstinProblem(r.gstin) })).filter((r) => r.problem !== null),
  );

  add(
    'registered_flag_mismatch',
    'Tenant marked unregistered but holds a GSTIN (tenant or outlet)',
    true,
    await rows(
      client,
      `SELECT t.id AS tenant_id, t.gstin AS tenant_gstin,
              array_agg(o.gstin) FILTER (WHERE o.gstin IS NOT NULL) AS outlet_gstins
         FROM tenants t LEFT JOIN outlets o ON o.tenant_id = t.id AND o.deleted_at IS NULL
        WHERE NOT t.is_gst_registered
        GROUP BY t.id, t.gstin
       HAVING t.gstin IS NOT NULL OR bool_or(o.gstin IS NOT NULL)
        ORDER BY t.id`,
    ),
  );

  add(
    'composition_with_several_gstins',
    'Composition tenant whose outlets resolve to different GSTINs',
    true,
    await rows(
      client,
      `SELECT tenant_id, array_agg(DISTINCT gstin) AS gstins FROM (${OUTLET_REG}) r
        WHERE is_composition AND deleted_at IS NULL AND gstin IS NOT NULL
        GROUP BY tenant_id HAVING count(DISTINCT gstin) > 1 ORDER BY tenant_id`,
    ),
  );

  add(
    'outlet_without_registration',
    'Outlet with documents that resolves to no registration in a tenant that has registrations',
    true,
    await rows(
      client,
      `SELECT r.outlet_id, r.tenant_id FROM (${OUTLET_REG}) r
        WHERE r.gstin IS NULL
          AND EXISTS (SELECT 1 FROM (${TENANT_GSTINS}) g WHERE g.tenant_id = r.tenant_id)
          AND (EXISTS (SELECT 1 FROM invoices d WHERE d.outlet_id = r.outlet_id)
            OR EXISTS (SELECT 1 FROM credit_notes d WHERE d.outlet_id = r.outlet_id)
            OR EXISTS (SELECT 1 FROM purchase_bills d WHERE d.outlet_id = r.outlet_id)
            OR EXISTS (SELECT 1 FROM debit_notes d WHERE d.outlet_id = r.outlet_id))
        ORDER BY r.tenant_id, r.outlet_id`,
    ),
  );

  // Document resolution: every document gets an outcome; unresolved ones are quarantined.
  const resolutions: DocumentResolution[] = [];
  const snapshotMismatches: Record<string, unknown>[] = [];
  const resolutionCounts: Record<string, number> = {};
  for (const { table, side } of DOCUMENT_TABLES) {
    const found = await rows<{
      table: string;
      id: string;
      tenant_id: string;
      document_number: string;
      document_date: unknown;
      supplier_gstin: string | null;
      outlet_gstin: string | null;
      outcome: string;
    }>(client, resolutionSql(table, side));
    for (const d of found) {
      const unresolved = d.outcome.startsWith('unresolved:');
      const resolution: DocumentResolution['resolution'] = unresolved
        ? 'legacy_unresolved'
        : d.outcome === 'non_gst'
          ? 'non_gst'
          : 'resolved';
      const key = `${table}:${resolution}`;
      resolutionCounts[key] = (resolutionCounts[key] ?? 0) + 1;
      if (d.outcome === 'resolved_by_snapshot') {
        snapshotMismatches.push({ table, id: d.id, sellerGstin: d.supplier_gstin, outletGstin: d.outlet_gstin });
      }
      resolutions.push({
        table,
        id: d.id,
        tenantId: d.tenant_id,
        documentNumber: d.document_number,
        documentDate: iso(d.document_date),
        resolution,
        registrationGstin:
          resolution !== 'resolved' ? null : side === 'outward' ? (d.supplier_gstin ?? d.outlet_gstin) : d.outlet_gstin,
        reason: unresolved ? d.outcome.slice('unresolved:'.length) : d.outcome,
      });
    }
  }
  add(
    'outward_snapshot_differs_from_outlet',
    "Outward document's seller GSTIN differs from its outlet's registration but is another registration of the tenant (resolved to the snapshot)",
    false,
    snapshotMismatches,
  );

  add(
    'inward_supplier_is_self',
    "Inward document whose supplier GSTIN is one of the tenant's own registrations",
    false,
    await rows(
      client,
      `SELECT '${'purchase_bills'}' AS "table", d.id, d.tenant_id, d.supplier_gstin FROM purchase_bills d
        WHERE EXISTS (SELECT 1 FROM (${TENANT_GSTINS}) g WHERE g.tenant_id = d.tenant_id AND g.gstin = d.supplier_gstin)
       UNION ALL
       SELECT 'debit_notes', d.id, d.tenant_id, d.supplier_gstin FROM debit_notes d
        WHERE EXISTS (SELECT 1 FROM (${TENANT_GSTINS}) g WHERE g.tenant_id = d.tenant_id AND g.gstin = d.supplier_gstin)`,
    ),
  );

  add(
    'duplicate_number_in_registration_fy',
    'Outward document number used twice within one seller GSTIN and FY (legacy rows are not entered into the number registry)',
    false,
    await rows(
      client,
      `SELECT supplier_gstin, fy_start_year, document_number, array_agg("table" || ':' || id) AS documents
         FROM (SELECT 'invoices' AS "table", id, supplier_gstin, fy_start_year, document_number FROM invoices
               UNION ALL
               SELECT 'credit_notes', id, supplier_gstin, fy_start_year, document_number FROM credit_notes) d
        WHERE supplier_gstin IS NOT NULL
        GROUP BY supplier_gstin, fy_start_year, document_number HAVING count(*) > 1
        ORDER BY supplier_gstin, fy_start_year, document_number`,
    ),
  );

  const quarantine = resolutions.filter((r) => r.resolution === 'legacy_unresolved');
  add(
    'quarantine',
    'Documents that would be stored as legacy_unresolved (blocks return preparation until resolved)',
    false,
    quarantine.map((q) => ({ ...q })),
  );

  const derived = await rows<{
    tenant_id: string;
    gstin: string;
    state_code: string;
    outlet_ids: string[];
    effective_from: unknown;
    composition: boolean;
  }>(
    client,
    `SELECT tenant_id, gstin, min(state_code) AS state_code, array_agg(outlet_id ORDER BY outlet_id) AS outlet_ids,
            min(effective_from) AS effective_from, bool_or(is_composition) AS composition
       FROM (${OUTLET_REG}) r WHERE gstin IS NOT NULL AND deleted_at IS NULL
      GROUP BY tenant_id, gstin ORDER BY tenant_id, gstin`,
  );

  return {
    generatedAt: new Date().toISOString(),
    blockingCount: categories.filter((c) => c.blocking).reduce((n, c) => n + c.rows.length, 0),
    categories,
    derivedRegistrations: derived.map((d) => ({
      tenantId: d.tenant_id,
      gstin: d.gstin,
      stateCode: d.state_code,
      outletIds: d.outlet_ids,
      effectiveFrom: iso(d.effective_from),
      composition: d.composition,
    })),
    resolutionCounts,
    quarantine,
  };
}

export function renderMarkdown(report: PreflightReport): string {
  const lines = [
    '# GST registration preflight',
    '',
    `Generated ${report.generatedAt}. Blocking rows: **${report.blockingCount}** — migration 0037 refuses to run while this is non-zero.`,
    '',
    '| Category | Blocking | Rows |',
    '|---|---|---|',
    ...report.categories.map((c) => `| ${c.title} | ${c.blocking ? 'yes' : 'no'} | ${c.rows.length} |`),
    '',
    '## Document resolution',
    '',
    '| Table:resolution | Count |',
    '|---|---|',
    ...Object.entries(report.resolutionCounts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `| ${k} | ${v} |`),
    '',
    `## Derived registrations (${report.derivedRegistrations.length})`,
    '',
    '| Tenant | GSTIN | State | Outlets | Effective from | Composition |',
    '|---|---|---|---|---|---|',
    ...report.derivedRegistrations.map(
      (r) =>
        `| ${r.tenantId} | ${r.gstin} | ${r.stateCode} | ${r.outletIds.length} | ${r.effectiveFrom} | ${r.composition ? 'yes' : 'no'} |`,
    ),
    '',
  ];
  for (const c of report.categories) {
    if (c.rows.length === 0) continue;
    lines.push(`## ${c.title}`, '', '```json', JSON.stringify(c.rows.slice(0, 200), null, 2), '```', '');
    if (c.rows.length > 200) lines.push(`…and ${c.rows.length - 200} more (see the JSON report).`, '');
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const outIndex = process.argv.indexOf('--out');
  const outDir = path.resolve(outIndex > 0 ? process.argv[outIndex + 1]! : 'preflight-reports');
  // DATE columns as plain 'YYYY-MM-DD' strings: pg would otherwise build a local-midnight
  // Date, which shifts a day when printed in UTC.
  const types = new pg.TypeOverrides();
  types.setTypeParser(pg.types.builtins.DATE, (value: string) => value);
  const client = new pg.Client({ ...migrationClientConfig(), types });
  await client.connect();
  try {
    const role = await client.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
      'SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user',
    );
    if (!role.rows[0]?.rolbypassrls && !role.rows[0]?.rolsuper) {
      throw new Error('The preflight needs a role that bypasses RLS (the migration owner); it would see no rows.');
    }
    await client.query('BEGIN READ ONLY');
    const report = await collectPreflight(client);
    await client.query('ROLLBACK');
    mkdirSync(outDir, { recursive: true });
    const stamp = report.generatedAt.replace(/[:.]/g, '-');
    const base = path.join(outDir, `gst-registrations-${stamp}`);
    writeFileSync(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    writeFileSync(`${base}.md`, renderMarkdown(report), 'utf8');
    console.log(`Blocking rows: ${report.blockingCount}. Quarantined documents: ${report.quarantine.length}.`);
    console.log(`Report: ${base}.md`);
    process.exitCode = report.blockingCount > 0 ? 2 : 0;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
