/**
 * Bulk catalogue import, as three resumable phases.
 *
 *   ingest   the spreadsheet is read once and every row stored raw
 *   analyse  rows are validated, matched and diffed, a chunk per call
 *   apply    matched rows are written, a chunk per transaction
 *
 * The client drives the loop, calling analyse and then apply repeatedly until
 * the status stops changing. That is a deliberate trade: no worker process to
 * run and monitor, at the cost of progress depending on a client that stays
 * awake. It is contained because every bit of state is in `import_jobs`, so
 * when a worker does arrive it can drive these same endpoints unchanged.
 *
 * Two properties hold the thing together:
 *
 * - **Serialised chunks.** Each call takes `FOR UPDATE` on the job row, so a
 *   double-tap or two open tabs cannot both claim the same slice.
 * - **Idempotent rows.** `import_job_rows.applied_at` is per row, so a
 *   resumed apply writes each row exactly once even if a chunk's transaction
 *   committed just before the client gave up waiting.
 */
import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { withReadTransaction, withTransaction, type Tx } from '../../db/tx.js';
import {
  COLUMN_BY_KEY,
  ITEM_COLUMNS,
  matchHeaders,
  parseItemRow,
} from '../../domain/import/item-columns.js';
import { requireAuthContext } from '../../lib/context.js';
import { ConflictError, ErrorCode, NotFoundError, UnprocessableError } from '../../lib/errors.js';
import { buildPage, parsePage } from '../../lib/pagination.js';
import { download, remove as removeObject, signUpload } from '../../lib/storage.js';
import { businessEvents } from '../../observability/metrics.js';
import { recordAudit } from '../audit/audit.js';
import { catalogueRepository } from '../catalogue/catalogue.repository.js';
import { assertFeature } from '../entitlements/entitlements.js';
import {
  importsRepository,
  type AnalysedRow,
  type ImportJobRow,
  type MatchCandidate,
} from './imports.repository.js';
import type {
  AnalyseBody,
  CreateImportBody,
  ListImportsQuery,
  ListRowsQuery,
} from './imports.schemas.js';
import { readSpreadsheet } from './spreadsheet.js';

const SPREADSHEET_BATCH = 500;

type ParsedValues = Record<string, string | number | boolean | null>;

/** What a client needs to decide whether to keep calling. */
function progressOf(job: ImportJobRow) {
  return {
    id: job.id,
    status: job.status,
    totalRows: job.totalRows,
    ingestedRows: job.ingestedRows,
    analysedUpToRow: job.analysedUpToRow,
    appliedUpToRow: job.appliedUpToRow,
    createCount: job.createCount,
    updateCount: job.updateCount,
    skipCount: job.skipCount,
    errorCount: job.errorCount,
    columnMap: job.columnMap,
    /** True while the client should call the current phase again. */
    done: job.status === 'applied' || job.status === 'analysed',
  };
}

function wrongState(job: ImportJobRow, expected: string): never {
  throw new ConflictError(
    `This import is ${job.status}; ${expected} is not the next step.`,
    ErrorCode.IMPORT_WRONG_STATE,
    { details: { status: job.status } },
  );
}

async function loadJob(tx: Tx, id: string, forUpdate = false): Promise<ImportJobRow> {
  const job = await importsRepository.findJob(tx, id, forUpdate);
  if (!job) throw new NotFoundError('Import');
  return job;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createImport(body: CreateImportBody) {
  const auth = requireAuthContext();

  await withReadTransaction((tx) => assertFeature(tx, 'bulk_edit'));

  // Signed outside any transaction: it is a network round trip to Supabase,
  // and holding a pooled connection open across it would be a connection
  // spent waiting rather than working.
  const upload = await signUpload('import', body.contentType, body.sizeBytes);

  const id = body.id ?? randomUUID();
  const createdJob = await withTransaction(async (tx) => {
    await importsRepository.insertJob(tx, {
      id,
      kind: body.kind,
      objectKey: upload.objectKey,
      originalFilename: body.originalFilename ?? null,
      createdBy: auth.userId,
    });
    return loadJob(tx, id);
  });

  return { ...progressOf(createdJob), ...upload };
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

/**
 * Reads the uploaded file once and stores every row raw.
 *
 * The download and parse happen before the transaction opens. Parsing a large
 * workbook can take seconds, and a transaction held across it would pin a
 * pooled connection and count against the statement timeout for no reason —
 * nothing it reads needs to be consistent with what it later writes.
 */
export async function ingestImport(id: string) {
  const job = await withTransaction(async (tx) => {
    const current = await loadJob(tx, id, true);
    // `ingesting` and `failed` are both re-runnable: the first is a job whose
    // process died between the two transactions below, the second a transient
    // download failure. Neither should strand an upload the shop already made,
    // and the row insert is made idempotent for exactly this reason.
    if (!['pending', 'ingesting', 'failed'].includes(current.status)) {
      wrongState(current, 'ingest');
    }
    await importsRepository.updateJob(tx, id, { status: 'ingesting', errorSummary: null });
    return current;
  });

  let sheet;
  try {
    const buffer = await download(job.objectKey);
    sheet = await readSpreadsheet(buffer, job.objectKey, env.IMPORT_MAX_ROWS);
  } catch (error) {
    await withTransaction((tx) =>
      importsRepository.updateJob(tx, id, {
        status: 'failed',
        errorSummary: { message: error instanceof Error ? error.message : 'Unreadable file.' },
      }),
    );
    throw error;
  }

  const match = matchHeaders(sheet.headers);
  if (match.missingRequired.length > 0) {
    const labels = match.missingRequired.map((key) => COLUMN_BY_KEY.get(key)?.header ?? key);
    await withTransaction((tx) =>
      importsRepository.updateJob(tx, id, {
        status: 'failed',
        errorSummary: { missingRequired: match.missingRequired, unmatched: match.unmatched },
      }),
    );
    throw new UnprocessableError(
      `The file needs a ${labels.join(' and ')} column.`,
      ErrorCode.IMPORT_COLUMN_UNMAPPED,
      { details: { missingRequired: match.missingRequired, unmatched: match.unmatched } },
    );
  }

  return withTransaction(async (tx) => {
    const current = await loadJob(tx, id, true);
    // A retry that lost the race to a first ingest finds the rows already
    // there; re-inserting them would violate the (job_id, row_no) unique.
    if (current.status === 'ingested') return progressOf(current);

    // Clears anything a previous attempt left behind, which is what makes
    // ingest safe to re-run after a crash between the two transactions.
    await importsRepository.deleteRows(tx, id);

    for (let offset = 0; offset < sheet.rows.length; offset += SPREADSHEET_BATCH) {
      await importsRepository.insertRows(
        tx,
        id,
        sheet.rows.slice(offset, offset + SPREADSHEET_BATCH).map((row) => ({
          rowNo: row.rowNo,
          raw: row.cells,
        })),
      );
    }

    await importsRepository.updateJob(tx, id, {
      status: 'ingested',
      columnMap: match.map,
      ingestedRows: sheet.rows.length,
      totalRows: sheet.rows.length,
      catalogueFingerprint: await importsRepository.catalogueFingerprint(tx),
      ingestedAt: new Date().toISOString(),
    });

    await recordAudit(tx, {
      action: 'import.ingested',
      entityType: 'import_job',
      entityId: id,
      metadata: { rows: sheet.rows.length, unmatchedColumns: match.unmatched },
    });

    return progressOf(await loadJob(tx, id));
  });
}

// ---------------------------------------------------------------------------
// Analyse
// ---------------------------------------------------------------------------

/**
 * Validates, matches and diffs the next chunk.
 *
 * Matching is `code`, then barcode, then case-insensitive name — the order a
 * shopkeeper would use themselves. Candidates for the whole chunk are fetched
 * in one query; three lookups per row would be fifteen thousand round trips
 * on a five-thousand-row file.
 */
export async function analyseImport(id: string, body: AnalyseBody) {
  return withTransaction(async (tx) => {
    const job = await loadJob(tx, id, true);
    if (!['ingested', 'analysing', 'analysed'].includes(job.status)) wrongState(job, 'analyse');

    // A new mapping invalidates every judgement already made.
    let cursor = job.analysedUpToRow;
    let columnMap = job.columnMap ?? {};
    if (body.columnMap) {
      columnMap = body.columnMap;
      cursor = 0;
      await importsRepository.updateJob(tx, id, { columnMap, analysedUpToRow: 0 });
      await resetAnalysis(tx, id);
    } else if (job.status === 'analysed') {
      return progressOf(job);
    }

    const rows = await importsRepository.nextPendingRows(
      tx,
      id,
      cursor,
      env.IMPORT_ANALYSE_CHUNK_ROWS,
    );

    if (rows.length > 0) {
      const parsed = rows.map((row) => ({
        rowNo: row.rowNo,
        ...parseItemRow(Array.isArray(row.raw) ? (row.raw as string[]) : [], columnMap),
      }));

      const candidates = await loadCandidates(tx, parsed);
      // Seeded from earlier chunks, not just this one: the uniqueness of a
      // claimed item is a property of the job.
      const claimed = new Set(await importsRepository.claimedTargetIds(tx, id));
      const analysed: AnalysedRow[] = parsed.map((row) =>
        judge(row.rowNo, row.values, row.errors, candidates, claimed),
      );
      await importsRepository.applyAnalysis(tx, id, analysed);
      cursor = rows[rows.length - 1]?.rowNo ?? cursor;
    }

    const counts = await importsRepository.countByAction(tx, id);
    const remaining = counts['pending'] ?? 0;
    const finished = remaining === 0;

    await importsRepository.updateJob(tx, id, {
      status: finished ? 'analysed' : 'analysing',
      analysedUpToRow: finished ? job.ingestedRows : cursor,
      createCount: counts['create'] ?? 0,
      updateCount: counts['update'] ?? 0,
      skipCount: counts['skip'] ?? 0,
      errorCount: counts['error'] ?? 0,
      ...(finished ? { analysedAt: new Date().toISOString() } : {}),
    });

    return progressOf(await loadJob(tx, id));
  });
}

async function resetAnalysis(tx: Tx, jobId: string): Promise<void> {
  await tx.query(
    `UPDATE import_job_rows
     SET action = 'pending', target_id = NULL, match_rule = NULL, parsed = NULL,
         diff = NULL, errors = NULL
     WHERE job_id = $1 AND applied_at IS NULL`,
    [jobId],
  );
}

interface ParsedChunkRow {
  rowNo: number;
  values: ParsedValues;
  errors: Record<string, string>;
}

async function loadCandidates(tx: Tx, rows: readonly ParsedChunkRow[]) {
  const codes = new Set<string>();
  const barcodes = new Set<string>();
  const names = new Set<string>();

  for (const row of rows) {
    const code = row.values['code'];
    const barcode = row.values['barcode'];
    const name = row.values['name'];
    if (typeof code === 'string' && code) codes.add(code);
    if (typeof barcode === 'string' && barcode) barcodes.add(barcode);
    if (typeof name === 'string' && name) names.add(name.toLowerCase());
  }

  const found = await importsRepository.findMatchCandidates(
    tx,
    [...codes],
    [...barcodes],
    [...names],
  );

  const byCode = new Map<string, MatchCandidate>();
  const byBarcode = new Map<string, MatchCandidate>();
  const byName = new Map<string, MatchCandidate>();
  for (const candidate of found) {
    if (candidate.code) byCode.set(candidate.code, candidate);
    for (const barcode of candidate.barcodes) byBarcode.set(barcode, candidate);
    // First wins, so a duplicate name in the catalogue resolves consistently
    // across chunks rather than depending on row order.
    const key = candidate.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, candidate);
  }
  return { byCode, byBarcode, byName };
}

type Candidates = Awaited<ReturnType<typeof loadCandidates>>;

/** Decides what a single row will do, and why. */
function judge(
  rowNo: number,
  values: ParsedValues,
  errors: Record<string, string>,
  candidates: Candidates,
  claimed: Set<string>,
): AnalysedRow {
  if (Object.keys(errors).length > 0) {
    return {
      rowNo,
      action: 'error',
      targetId: null,
      matchRule: null,
      parsed: values,
      diff: null,
      errors,
    };
  }

  const code = values['code'];
  const barcode = values['barcode'];
  const name = values['name'];

  let match: MatchCandidate | undefined;
  let rule: 'code' | 'barcode' | 'name' | null = null;
  if (typeof code === 'string' && code) {
    match = candidates.byCode.get(code);
    if (match) rule = 'code';
  }
  if (!match && typeof barcode === 'string' && barcode) {
    match = candidates.byBarcode.get(barcode);
    if (match) rule = 'barcode';
  }
  if (!match && typeof name === 'string' && name) {
    match = candidates.byName.get(name.toLowerCase());
    if (match) rule = 'name';
  }

  if (!match) {
    return {
      rowNo,
      action: 'create',
      targetId: null,
      matchRule: null,
      parsed: values,
      diff: null,
      errors: null,
    };
  }

  // Two rows claiming one existing item is a mistake in the file. Saying so
  // is better than applying both and leaving whichever landed last.
  if (claimed.has(match.id)) {
    return {
      rowNo,
      action: 'error',
      targetId: null,
      matchRule: null,
      parsed: values,
      diff: null,
      errors: { name: 'Another row in this file already updates the same item' },
    };
  }
  claimed.add(match.id);

  const diff = diffAgainst(match, values);
  if (Object.keys(diff).length === 0) {
    return {
      rowNo,
      action: 'skip',
      targetId: match.id,
      matchRule: rule,
      parsed: values,
      diff: null,
      errors: null,
    };
  }
  return {
    rowNo,
    action: 'update',
    targetId: match.id,
    matchRule: rule,
    parsed: values,
    diff,
    errors: null,
  };
}

/**
 * Only columns the file actually supplied are compared.
 *
 * A price list with no HSN column must not be read as "clear every HSN code".
 * This is the difference between an importer a shop trusts and one it uses
 * once.
 */
function diffAgainst(
  existing: MatchCandidate,
  values: ParsedValues,
): Record<string, { from: unknown; to: unknown }> {
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  const comparable = ITEM_COLUMNS.filter(
    (c) => c.key !== 'barcode' && c.key !== 'category' && c.key !== 'openingStock',
  );

  for (const column of comparable) {
    if (!(column.key in values)) continue;
    const next = values[column.key];
    if (next === null || next === undefined) continue;
    const current = (existing as unknown as Record<string, unknown>)[column.key] ?? null;
    if (!sameValue(current, next)) diff[column.key] = { from: current, to: next };
  }

  const barcode = values['barcode'];
  if (typeof barcode === 'string' && barcode && !existing.barcodes.includes(barcode)) {
    diff['barcode'] = { from: existing.barcodes, to: barcode };
  }
  return diff;
}

/**
 * Compares a stored value with a parsed one.
 *
 * Typed by the column rather than stringified, because `pg` returns NUMERIC
 * as a string: `tax_rate_percent` arrives as "18.000" while the spreadsheet
 * parses to the number 18. A textual comparison would report a change on
 * every row of every re-import and turn a clean file into 500 fake updates.
 */
function sameValue(current: unknown, next: string | number | boolean): boolean {
  if (typeof next === 'number') {
    const asNumber = typeof current === 'number' ? current : Number(current);
    return current !== null && current !== '' && Number.isFinite(asNumber) && asNumber === next;
  }
  if (typeof next === 'boolean') return current === next;
  return typeof current === 'string' && current === next;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Writes the next chunk, in one transaction.
 *
 * Per chunk rather than per job: a 50,000-row apply in a single transaction
 * would hold locks for its whole duration and sit against the statement
 * timeout. The cost is that a client who walks away leaves the catalogue
 * partly imported — visible in `appliedUpToRow`, resumable, and safe to
 * resume because each row is an idempotent upsert keyed on `targetId`.
 */
export async function applyImport(id: string) {
  const result = await withTransaction(async (tx) => {
    const job = await loadJob(tx, id, true);
    if (job.status === 'applied') return { progress: progressOf(job), applied: 0 };
    if (!['analysed', 'applying'].includes(job.status)) wrongState(job, 'apply');

    // The diff was computed against a catalogue that may have moved since.
    const fingerprint = await importsRepository.catalogueFingerprint(tx);
    if (job.catalogueFingerprint !== null && job.catalogueFingerprint !== fingerprint) {
      await importsRepository.updateJob(tx, id, { status: 'analysed' });
      throw new ConflictError(
        'The catalogue changed since this import was reviewed. Re-run the review and apply again.',
        ErrorCode.IMPORT_STALE,
      );
    }

    await assertFeature(tx, 'bulk_edit');
    const rows = await importsRepository.nextApplicableRows(tx, id, env.IMPORT_APPLY_CHUNK_ROWS);

    if (rows.length === 0) {
      await importsRepository.updateJob(tx, id, {
        status: 'applied',
        appliedUpToRow: job.ingestedRows,
        appliedAt: new Date().toISOString(),
      });
      return { progress: progressOf(await loadJob(tx, id)), applied: 0 };
    }

    const categories = await importsRepository.categoryIdsByName(tx);
    for (const row of rows) {
      await writeRow(tx, row.action, row.targetId, row.parsed ?? {}, categories);
    }

    await importsRepository.markRowsApplied(
      tx,
      id,
      rows.map((r) => r.rowNo),
    );

    const remaining = await importsRepository.countRemainingApplicable(tx, id);
    const lastRowNo = rows[rows.length - 1]?.rowNo ?? job.appliedUpToRow;
    const finished = remaining === 0;

    await importsRepository.updateJob(tx, id, {
      status: finished ? 'applied' : 'applying',
      appliedUpToRow: finished ? job.ingestedRows : lastRowNo,
      // The fingerprint moved because *we* moved it; re-baseline so the next
      // chunk does not mistake our own writes for someone else's.
      catalogueFingerprint: await importsRepository.catalogueFingerprint(tx),
      ...(finished ? { appliedAt: new Date().toISOString() } : {}),
    });

    await recordAudit(tx, {
      action: 'import.applied',
      entityType: 'import_job',
      entityId: id,
      metadata: { rows: rows.length, throughRow: lastRowNo, finished },
    });

    return { progress: progressOf(await loadJob(tx, id)), applied: rows.length };
  });

  if (result.applied > 0) businessEvents.inc({ event: 'import.applied' });
  return result.progress;
}

async function writeRow(
  tx: Tx,
  action: string,
  targetId: string | null,
  values: ParsedValues,
  categories: Map<string, string>,
): Promise<void> {
  const categoryId = await resolveCategory(tx, values['category'], categories);
  const barcode = typeof values['barcode'] === 'string' ? values['barcode'] : null;

  if (action === 'create') {
    const itemId = randomUUID();
    await catalogueRepository.insertItem(tx, {
      id: itemId,
      categoryId,
      itemType: (values['itemType'] as 'goods' | 'service' | null) ?? 'goods',
      name: String(values['name']),
      code: (values['code'] as string | null) ?? null,
      aliases: [],
      hsnCode: (values['hsnCode'] as string | null) ?? null,
      taxRatePercent: (values['taxRatePercent'] as number | null) ?? 0,
      cessRatePercent: (values['cessRatePercent'] as number | null) ?? 0,
      unit: (values['unit'] as string | null) ?? 'pcs',
      mrp: (values['mrp'] as number | null) ?? null,
      salePrice: (values['salePrice'] as number | null) ?? 0,
      // The spreadsheet has no column for it; an import never sets a
      // default discount.
      discountPercent: null,
      purchasePrice: (values['purchasePrice'] as number | null) ?? null,
      pricesIncludeTax: true,
      trackStock: (values['trackStock'] as boolean | null) ?? true,
      reorderLevel: (values['reorderLevel'] as number | null) ?? null,
      // The spreadsheet has no column for it; an imported item is taxable
      // until someone says otherwise, which is the safe default — an exempt
      // item wrongly marked taxable is visible on the first return, whereas
      // the reverse under-reports turnover.
      supplyCategory: 'taxable',
      isActive: true,
      // A spreadsheet carries no photo; one is added from the app afterwards.
      imageObjectKey: null,
    });
    if (barcode) await catalogueRepository.replaceBarcodes(tx, itemId, [barcode]);
    return;
  }

  if (!targetId) return;
  const patch: Record<string, unknown> = {};
  for (const column of ITEM_COLUMNS) {
    if (column.key === 'barcode' || column.key === 'category' || column.key === 'openingStock') {
      continue;
    }
    const value = values[column.key];
    // Undefined means the column was absent; null means the cell was blank.
    // Neither is an instruction to clear a stored value.
    if (value !== undefined && value !== null) patch[column.key] = value;
  }
  if (categoryId !== null) patch['categoryId'] = categoryId;
  await catalogueRepository.updateItem(tx, targetId, patch);

  if (barcode) {
    // Additive: a shop's own barcode and a manufacturer's often coexist, and
    // an import should not silently drop one that is already on a shelf.
    const existing = await tx.one<{ barcodes: string[] }>(
      `SELECT COALESCE(array_agg(barcode), '{}') AS barcodes FROM item_barcodes
       WHERE item_id = $1 AND deleted_at IS NULL`,
      [targetId],
    );
    const all = new Set([...(existing?.barcodes ?? []), barcode]);
    await catalogueRepository.replaceBarcodes(tx, targetId, [...all]);
  }
}

/** Categories named in the file are created on demand; a price list rarely lists them separately. */
async function resolveCategory(
  tx: Tx,
  value: unknown,
  categories: Map<string, string>,
): Promise<string | null> {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const key = value.trim().toLowerCase();
  const existing = categories.get(key);
  if (existing) return existing;

  const id = randomUUID();
  await catalogueRepository.insertCategory(tx, { id, name: value.trim(), parentId: null, icon: null });
  categories.set(key, id);
  return id;
}

// ---------------------------------------------------------------------------
// Read and cancel
// ---------------------------------------------------------------------------

export function getImport(id: string) {
  return withReadTransaction(async (tx) => progressOf(await loadJob(tx, id)));
}

export async function listImports(query: ListImportsQuery) {
  const page = parsePage(query);
  const rows = await withReadTransaction((tx) =>
    importsRepository.listJobs(tx, page.limit, page.cursor),
  );
  return buildPage(rows.map(progressOf), page.limit, (row) => ({ k: row.id, id: row.id }));
}

export async function listImportRows(id: string, query: ListRowsQuery) {
  const page = parsePage(query);
  const rows = await withReadTransaction(async (tx) => {
    await loadJob(tx, id);
    return importsRepository.listRows(tx, id, query.action, page.limit, page.cursor);
  });
  return buildPage(rows, page.limit, (row) => ({ k: row.rowNo, id: row.id }));
}

/**
 * Abandons a job and purges its upload.
 *
 * A job that has written rows cannot be cancelled — half a catalogue is
 * already in, and "cancel" would imply an undo this does not perform.
 */
export async function cancelImport(id: string): Promise<void> {
  const objectKey = await withTransaction(async (tx) => {
    const job = await loadJob(tx, id, true);
    if (job.status === 'applied') wrongState(job, 'cancel');
    if (job.appliedUpToRow > 0) {
      throw new ConflictError(
        'Part of this import has already been applied; finish it instead of cancelling.',
        ErrorCode.IMPORT_WRONG_STATE,
        { details: { appliedUpToRow: job.appliedUpToRow } },
      );
    }
    await importsRepository.deleteRows(tx, id);
    await importsRepository.updateJob(tx, id, { status: 'cancelled' });
    await recordAudit(tx, {
      action: 'import.cancelled',
      entityType: 'import_job',
      entityId: id,
      metadata: {},
    });
    return job.objectKey;
  });

  await removeObject(objectKey);
}
