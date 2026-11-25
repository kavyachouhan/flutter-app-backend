/**
 * Publishes GST rule versions and loads the HSN/SAC master. See `data/gst-rules/README.md`.
 *
 *   npm run gst:rules -- check            validate the files; touches nothing
 *   npm run gst:rules -- publish          publish every version whose content changed
 *   npm run gst:rules -- publish --draft  store them as drafts, for review (never selected)
 *   npm run gst:rules -- hsn              load data/CBIC/HSN_SAC.xlsx into hsn_master
 *
 * Targets DATABASE_MIGRATION_URL, like `migrate`. Changed content becomes a new revision of its
 * date; a published revision is never altered, and documents keep the revision they used.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import ExcelJS from 'exceljs';
import pg from 'pg';
import {
  composeRuleSet,
  normaliseHsnMaster,
  unverifiedRates,
  versionDates,
  type HsnRow,
} from '../../domain/gst/rule-set-compose.js';
import { migrationClientConfig } from '../migration-client.js';
import { checkRuleFiles, loadRuleFiles, SOURCES_DIR } from './rule-files.js';

const HSN_WORKBOOK = path.join(SOURCES_DIR, 'HSN_SAC.xlsx');

function fail(lines: readonly string[]): never {
  for (const line of lines) console.error(line);
  process.exit(1);
}

async function withClient<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client(migrationClientConfig());
  await client.connect();
  try {
    await client.query('BEGIN');
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

function check(): void {
  const problems = checkRuleFiles();
  if (problems.length > 0) fail(['Rule files have problems:', ...problems.map((p) => `  ${p}`)]);
  const files = loadRuleFiles();
  console.log(`OK: ${files.notifications.length} notification files.`);
  for (const date of versionDates(files.notifications)) {
    const unverified = unverifiedRates(composeRuleSet(files.base, files.notifications, date), date);
    console.log(`  ${date}: ${unverified.length === 0 ? 'publishable' : `${unverified.length} rate entries still secondary_only`}`);
  }
  for (const n of files.notifications.filter((f) => f.treatment === 'deferred')) {
    console.log(`  deferred ${n.notification}: ${n.reason}`);
  }
}

async function publish(asDraft: boolean): Promise<void> {
  const problems = checkRuleFiles();
  if (problems.length > 0) fail(['Rule files have problems:', ...problems.map((p) => `  ${p}`)]);
  const files = loadRuleFiles();
  const dates = versionDates(files.notifications);

  if (!asDraft) {
    const blocked = dates.flatMap((date) =>
      unverifiedRates(composeRuleSet(files.base, files.notifications, date), date).map((u) => `  ${date}: ${u}`),
    );
    if (blocked.length > 0) {
      fail([
        'Refusing to publish: these rates rest only on secondary sources (freeze §6.4).',
        'Add the primary notification and mark it verified, or use --draft to review.',
        ...blocked,
      ]);
    }
  }

  await withClient(async (client) => {
    for (const date of dates) {
      const content = composeRuleSet(files.base, files.notifications, date);
      const json = JSON.stringify(content);
      const latest = await client.query<{ version: string; revision: number; same: boolean; status: string }>(
        `SELECT version, revision, status, content = $2::jsonb AS same FROM gst_rule_sets
          WHERE effective_from = $1 AND version <> 'legacy' ORDER BY revision DESC LIMIT 1`,
        [date, json],
      );
      const current = latest.rows[0];
      if (current?.same && (asDraft || current.status === 'published')) {
        console.log(`${current.version}: unchanged`);
        continue;
      }
      if (current?.status === 'draft') {
        // A draft was never served, so it is replaced rather than given a revision.
        await client.query('DELETE FROM gst_rule_sets WHERE version = $1', [current.version]);
      }
      const replacesDraft = current?.status === 'draft';
      const revision = current ? (replacesDraft ? current.revision : current.revision + 1) : 1;
      const supersedes = current && !replacesDraft ? current.version : null;
      const version = `${date}.${revision}`;
      await client.query(
        `INSERT INTO gst_rule_sets (version, effective_from, revision, supersedes, status, content, content_sha256,
                                    published_at, published_by)
         SELECT $1, $2::date, $3, $4, $5, c, encode(sha256(convert_to(c::text, 'UTF8')), 'hex'),
                CASE WHEN $5 = 'published' THEN now() END, CASE WHEN $5 = 'published' THEN current_user END
           FROM (SELECT $6::jsonb AS c) x`,
        [version, date, revision, supersedes, asDraft ? 'draft' : 'published', json],
      );
      console.log(`${version}: ${asDraft ? 'stored as draft' : 'published'}`);
    }
  });
}

async function readHsnWorkbook(): Promise<{ code: string; description: string; kind: HsnRow['kind'] }[]> {
  const book = new ExcelJS.Workbook();
  await book.xlsx.readFile(HSN_WORKBOOK);
  const rows: { code: string; description: string; kind: HsnRow['kind'] }[] = [];
  for (const [sheet, kind] of [
    ['HSN_MSTR', 'goods'],
    ['SAC_MSTR', 'service'],
  ] as const) {
    const ws = book.getWorksheet(sheet);
    if (!ws) fail([`${HSN_WORKBOOK} has no sheet ${sheet}`]);
    ws.eachRow((row, number) => {
      if (number === 1) return;
      // `.text` flattens rich-text cells, which the workbook has at least one of.
      rows.push({ code: row.getCell(1).text, description: row.getCell(2).text, kind });
    });
  }
  return rows;
}

async function loadHsn(): Promise<void> {
  const { rows, corrections, errors } = normaliseHsnMaster(await readHsnWorkbook());
  if (errors.length > 0) fail(['The HSN workbook has problems:', ...errors.map((e) => `  ${e}`)]);
  const version = createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 12);
  await withClient(async (client) => {
    // destructive by design: the master is reference data, replaced whole from its source.
    await client.query('DELETE FROM hsn_master WHERE source_version <> $1', [version]);
    for (let i = 0; i < rows.length; i += 2000) {
      const batch = rows.slice(i, i + 2000);
      await client.query(
        `INSERT INTO hsn_master (code, kind, description, parent_code, source_version)
         SELECT code, kind, description, parent_code, $1
           FROM jsonb_to_recordset($2::jsonb) AS t(code text, kind text, description text, parent_code text)
         ON CONFLICT (code) DO NOTHING`,
        [version, JSON.stringify(batch.map((r) => ({ code: r.code, kind: r.kind, description: r.description, parent_code: r.parentCode })))],
      );
    }
  });
  console.log(`hsn_master: ${rows.length} codes, version ${version}. Rows changed or left out, for review: ${corrections.length}`);
  for (const c of corrections) console.log(`  "${c.raw}" -> ${c.code} (${c.fix})`);
}

const [command, ...flags] = process.argv.slice(2);
if (command === 'check') check();
else if (command === 'publish') await publish(flags.includes('--draft'));
else if (command === 'hsn') await loadHsn();
else fail(['Usage: check | publish [--draft] | hsn']);
