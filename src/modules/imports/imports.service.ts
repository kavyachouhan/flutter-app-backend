/**
 * Bulk import of items, customers and suppliers, as three resumable phases.
 *
 *   ingest   the spreadsheet is safety-checked, read once, and every row stored raw
 *   analyse  rows are validated, matched and diffed, a chunk per call
 *   apply    matched rows are written, a chunk per transaction
 *
 * What differs between items and parties — columns, matching, writing — lives
 * in ./kinds.ts. This file is only the pipeline.
 *
 * **Column matching.** Ingest guesses which of the file's columns is which
 * field (by name and synonym) unless the shop already confirmed the matching
 * for a file with exactly these headers, in which case that is used and the
 * matching screen can be skipped. Confirming the matching (an analyse call
 * carrying `columnMap`) saves it for next time. A file whose matching leaves a
 * required field unmatched is still ingested — the shop fixes it on the
 * matching screen — but cannot be analysed until it is.
 *
 * The client drives the loop, calling analyse and then apply repeatedly until
 * the status stops changing. Two properties hold that together:
 *
 * - **Serialised chunks.** Each call takes `FOR UPDATE` on the job row, so a
 *   double-tap or two open tabs cannot both claim the same slice.
 * - **Idempotent rows.** `import_job_rows.applied_at` is per row, so a
 *   resumed apply writes each row exactly once.
 */
import { createHash, randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { withReadTransaction, withTransaction, type Tx } from '../../db/tx.js';
import { normaliseHeader } from '../../domain/import/columns.js';
import { requireAuthContext } from '../../lib/context.js';
import {
  ConflictError,
  ErrorCode,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
  ValidationError,
} from '../../lib/errors.js';
import { buildPage, parsePage } from '../../lib/pagination.js';
import { createLogger } from '../../lib/logger.js';
import { download, remove as removeObject, signUpload } from '../../lib/storage.js';
import { assertOutletAccess } from '../../middleware/authorize.js';
import { businessEvents } from '../../observability/metrics.js';
import { recordAudit } from '../audit/audit.js';
import { hasPermission } from '../auth/permissions.js';
import { assertFeature } from '../entitlements/entitlements.js';
import { importsRepository, type ImportJobRow, type MappingSource } from './imports.repository.js';
import type {
  AnalyseBody,
  CreateImportBody,
  ListImportsQuery,
  ListRowsQuery,
} from './imports.schemas.js';
import { handlerFor, type KindHandler, type ParsedChunkRow } from './kinds.js';
import { readSpreadsheet } from './spreadsheet.js';

const log = createLogger('imports');

const SPREADSHEET_BATCH = 500;
/** Rows shown under each column on the matching screen. */
const SAMPLE_ROWS = 3;

/** What a client needs to decide whether to keep calling, and to draw the matching screen. */
function progressOf(job: ImportJobRow) {
  const handler = handlerFor(job.kind);
  const columnMap = job.columnMap ?? {};
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    originalFilename: job.originalFilename,
    totalRows: job.totalRows,
    ingestedRows: job.ingestedRows,
    analysedUpToRow: job.analysedUpToRow,
    appliedUpToRow: job.appliedUpToRow,
    createCount: job.createCount,
    updateCount: job.updateCount,
    skipCount: job.skipCount,
    errorCount: job.errorCount,
    columnMap,
    /** The file's own header row. */
    headers: job.headers ?? [],
    /** auto: guessed. saved: the shop confirmed this layout before. confirmed: confirmed for this file. */
    mappingSource: job.mappingSource,
    /** Required fields the matching does not cover yet. Analyse refuses until this is empty. */
    missingRequired: handler.columns.missingRequired(columnMap),
    /** Every field this kind can import, for the matching screen. */
    fields: handler.columns.columns.map((column) => ({
      key: column.key,
      label: column.header,
      required: column.required,
      type: column.type,
      createOnly: column.createOnly === true,
    })),
    errorSummary: job.errorSummary,
    createdAt: job.createdAt,
    /** True while the client should call the current phase again. */
    done: job.status === 'applied' || job.status === 'analysed',
  };
}

/** progressOf, plus the first few rows so the matching screen can show examples. */
async function describe(tx: Tx, job: ImportJobRow) {
  const samples = await importsRepository.sampleRows(tx, job.id, SAMPLE_ROWS);
  return {
    ...progressOf(job),
    sampleRows: samples.map((row) => (Array.isArray(row.cells) ? (row.cells as unknown[]) : [])),
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

/** imports:write is checked by the route; a kind that creates parties needs their permission too. */
function assertKindAllowed(handler: KindHandler): void {
  if (handler.permission === null) return;
  const { role } = requireAuthContext();
  if (!hasPermission(role, handler.permission)) {
    throw new ForbiddenError(undefined, ErrorCode.INSUFFICIENT_ROLE, {
      details: { required: handler.permission },
    });
  }
}

async function assertKindFeatures(tx: Tx, handler: KindHandler): Promise<void> {
  await assertFeature(tx, 'bulk_edit');
  for (const feature of handler.features) await assertFeature(tx, feature);
}

/** One key per (kind, header row): the same software's export always has the same one. */
export function layoutKeyFor(kind: string, headers: readonly string[]): string {
  return createHash('sha256')
    .update(`${kind}\n${headers.map(normaliseHeader).join('\u001f')}`)
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createImport(body: CreateImportBody) {
  const auth = requireAuthContext();
  const handler = handlerFor(body.kind);
  assertKindAllowed(handler);
  if (body.outletId) assertOutletAccess(body.outletId);

  await withReadTransaction((tx) => assertKindFeatures(tx, handler));

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
      outletId: body.outletId ?? null,
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
 * pooled connection for no reason.
 */
export async function ingestImport(id: string) {
  const job = await withTransaction(async (tx) => {
    const current = await loadJob(tx, id, true);
    // `ingesting` and `failed` are both re-runnable: the first is a job whose
    // process died between the two transactions below, the second a transient
    // download failure. Neither should strand an upload the shop already made.
    if (!['pending', 'ingesting', 'failed'].includes(current.status)) {
      wrongState(current, 'ingest');
    }
    await importsRepository.updateJob(tx, id, { status: 'ingesting', errorSummary: null });
    return current;
  });
  const handler = handlerFor(job.kind);

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
    // A file refused as unsafe is not kept a moment longer than needed.
    if (error instanceof UnprocessableError && error.code === ErrorCode.IMPORT_UNSAFE) {
      await removeObject(job.objectKey).catch(() => undefined);
    }
    throw error;
  }

  const layoutKey = layoutKeyFor(job.kind, sheet.headers);
  const guessed = handler.columns.matchHeaders(sheet.headers);

  return withTransaction(async (tx) => {
    const current = await loadJob(tx, id, true);
    // A retry that lost the race to a first ingest finds the rows already there.
    if (current.status === 'ingested') return describe(tx, current);

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

    // A matching the shop confirmed for this exact layout beats a guess.
    const saved = await importsRepository.findSavedMapping(tx, current.kind, layoutKey);
    const savedMap = saved ? usableSavedMap(handler, sheet.headers, saved.columnMap) : null;
    const columnMap = savedMap ?? guessed.map;
    const mappingSource: MappingSource = savedMap ? 'saved' : 'auto';

    await importsRepository.updateJob(tx, id, {
      status: 'ingested',
      columnMap,
      headers: sheet.headers,
      layoutKey,
      mappingSource,
      ingestedRows: sheet.rows.length,
      totalRows: sheet.rows.length,
      catalogueFingerprint: await importsRepository.fingerprint(tx, current.kind),
      ingestedAt: new Date().toISOString(),
    });

    await recordAudit(tx, {
      action: 'import.ingested',
      entityType: 'import_job',
      entityId: id,
      metadata: {
        kind: current.kind,
        rows: sheet.rows.length,
        unmatchedColumns: guessed.unmatched,
        mappingSource,
      },
    });

    return describe(tx, await loadJob(tx, id));
  });
}

/**
 * A saved matching, if it still fits. Same layout means same headers, but a
 * field may have been renamed or removed since it was saved; those entries
 * are dropped rather than trusted.
 */
function usableSavedMap(
  handler: KindHandler,
  headers: readonly string[],
  map: Record<string, number>,
): Record<string, number> | null {
  const usable: Record<string, number> = {};
  for (const [key, index] of Object.entries(map)) {
    if (
      handler.columns.byKey.has(key) &&
      Number.isInteger(index) &&
      index >= 0 &&
      index < headers.length
    ) {
      usable[key] = index;
    }
  }
  return handler.columns.missingRequired(usable).length === 0 ? usable : null;
}

/** Checks a matching sent from the matching screen against the file it is for. */
function validatedColumnMap(
  handler: KindHandler,
  headers: readonly string[],
  map: Record<string, number>,
): Record<string, number> {
  const clean: Record<string, number> = {};
  const usedBy = new Map<number, string>();
  for (const [key, index] of Object.entries(map)) {
    const column = handler.columns.byKey.get(key);
    if (!column) {
      throw new ValidationError(`"${key}" is not a field a ${handler.noun} import has.`, {
        details: { field: key },
      });
    }
    if (index >= headers.length) {
      throw new ValidationError(`Column ${index + 1} is not in this file.`, {
        details: { field: key },
      });
    }
    const other = usedBy.get(index);
    if (other !== undefined) {
      throw new ValidationError(
        `The column "${headers[index]}" is matched to both ${handler.columns.byKey.get(other)?.header} and ${column.header}.`,
        { details: { fields: [other, key] } },
      );
    }
    usedBy.set(index, key);
    clean[key] = index;
  }
  return clean;
}

function assertRequiredMapped(handler: KindHandler, map: Record<string, number>): void {
  const missing = handler.columns.missingRequired(map);
  if (missing.length === 0) return;
  const labels = missing.map((key) => handler.columns.byKey.get(key)?.header ?? key);
  throw new UnprocessableError(
    `Choose which column holds the ${labels.join(' and ')} before importing.`,
    ErrorCode.IMPORT_COLUMN_UNMAPPED,
    { details: { missingRequired: missing } },
  );
}

// ---------------------------------------------------------------------------
// Analyse
// ---------------------------------------------------------------------------

/**
 * Validates, matches and diffs the next chunk.
 *
 * Candidates for the whole chunk are fetched in one query by the kind; a
 * lookup per row would be thousands of round trips on a large file.
 */
export async function analyseImport(id: string, body: AnalyseBody) {
  const auth = requireAuthContext();
  return withTransaction(async (tx) => {
    const job = await loadJob(tx, id, true);
    if (!['ingested', 'analysing', 'analysed'].includes(job.status)) wrongState(job, 'analyse');
    const handler = handlerFor(job.kind);
    assertKindAllowed(handler);

    // A new mapping invalidates every judgement already made.
    let cursor = job.analysedUpToRow;
    let columnMap = job.columnMap ?? {};
    if (body.columnMap) {
      if (job.appliedUpToRow > 0) wrongState(job, 'changing the column matching');
      columnMap = validatedColumnMap(handler, job.headers ?? [], body.columnMap);
      assertRequiredMapped(handler, columnMap);
      cursor = 0;
      await importsRepository.updateJob(tx, id, {
        columnMap,
        mappingSource: 'confirmed',
        analysedUpToRow: 0,
        // The rows are judged afresh, against the records as they are now —
        // so that is the state apply must find unchanged. Without this a job
        // refused as stale (another import or an edit moved the records) could
        // never be saved: re-checking it kept the fingerprint from ingest.
        catalogueFingerprint: await importsRepository.fingerprint(tx, job.kind),
      });
      await importsRepository.resetAnalysis(tx, id);
      if (body.remember && job.layoutKey && job.headers) {
        await importsRepository.saveMapping(
          tx,
          job.kind,
          job.layoutKey,
          job.headers,
          columnMap,
          auth.userId,
        );
      }
    } else if (job.status === 'analysed') {
      return progressOf(job);
    } else {
      assertRequiredMapped(handler, columnMap);
    }

    const rows = await importsRepository.nextPendingRows(
      tx,
      id,
      cursor,
      env.IMPORT_ANALYSE_CHUNK_ROWS,
    );
    if (rows.length > 0) {
      const parsed: ParsedChunkRow[] = rows.map((row) => {
        const result = handler.parse(
          Array.isArray(row.raw) ? (row.raw as string[]) : [],
          columnMap,
        );
        return {
          rowNo: row.rowNo,
          values: { ...result.values },
          errors: { ...result.errors },
          notes: [...result.notes],
        };
      });
      const analysed = await handler.analyse(tx, parsed, { jobId: id, outletId: job.outletId });
      await importsRepository.applyAnalysis(tx, id, analysed);
      cursor = rows[rows.length - 1]?.rowNo ?? cursor;
    }

    const counts = await importsRepository.countByAction(tx, id);
    const finished = (counts['pending'] ?? 0) === 0;

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

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Writes the next chunk, in one transaction.
 *
 * Per chunk rather than per job: a 50,000-row apply in a single transaction
 * would hold locks for its whole duration and sit against the statement
 * timeout. The cost is that a client who walks away leaves the import partly
 * written — visible in `appliedUpToRow`, resumable, and safe to resume
 * because each row is written at most once.
 */
export async function applyImport(id: string) {
  const auth = requireAuthContext();
  const result = await withTransaction(async (tx) => {
    const job = await loadJob(tx, id, true);
    if (job.status === 'applied') return { progress: progressOf(job), applied: 0 };
    if (!['analysed', 'applying'].includes(job.status)) wrongState(job, 'apply');
    const handler = handlerFor(job.kind);
    assertKindAllowed(handler);

    // The diff was computed against records that may have moved since.
    const fingerprint = await importsRepository.fingerprint(tx, job.kind);
    if (job.catalogueFingerprint !== null && job.catalogueFingerprint !== fingerprint) {
      await importsRepository.updateJob(tx, id, { status: 'analysed' });
      throw new ConflictError(
        `Your ${handler.kind} changed since this import was reviewed. Review it again, then import.`,
        ErrorCode.IMPORT_STALE,
      );
    }

    await assertKindFeatures(tx, handler);
    const rows = await importsRepository.nextApplicableRows(tx, id, env.IMPORT_APPLY_CHUNK_ROWS);

    if (rows.length === 0) {
      await importsRepository.updateJob(tx, id, {
        status: 'applied',
        appliedUpToRow: job.ingestedRows,
        appliedAt: new Date().toISOString(),
      });
      return { progress: progressOf(await loadJob(tx, id)), applied: 0 };
    }

    const prepared = await handler.prepareWrite(tx);
    const written: number[] = [];
    let failed = 0;
    for (const row of rows) {
      // Each row in its own savepoint. The review should have caught every
      // problem, but a rule it missed (a constraint, a race with someone
      // editing the same record) must cost that one row, with a reason the
      // shop can read, not the whole chunk and a "something went wrong".
      await tx.query('SAVEPOINT import_row');
      try {
        await handler.write(tx, row, { outletId: job.outletId, userId: auth.userId }, prepared);
        await tx.query('RELEASE SAVEPOINT import_row');
        written.push(row.rowNo);
      } catch (error) {
        await tx.query('ROLLBACK TO SAVEPOINT import_row');
        failed += 1;
        log.warn({ jobId: id, rowNo: row.rowNo, err: error }, 'Import row could not be written');
        await importsRepository.markRowFailed(tx, id, row.rowNo, rowFailureMessage(error, handler));
      }
    }
    await importsRepository.markRowsApplied(tx, id, written);
    if (failed > 0) {
      const counts = await importsRepository.countByAction(tx, id);
      await importsRepository.updateJob(tx, id, {
        createCount: counts['create'] ?? 0,
        updateCount: counts['update'] ?? 0,
        errorCount: counts['error'] ?? 0,
      });
    }

    const remaining = await importsRepository.countRemainingApplicable(tx, id);
    const lastRowNo = rows[rows.length - 1]?.rowNo ?? job.appliedUpToRow;
    const finished = remaining === 0;

    await importsRepository.updateJob(tx, id, {
      status: finished ? 'applied' : 'applying',
      appliedUpToRow: finished ? job.ingestedRows : lastRowNo,
      // The fingerprint moved because *we* moved it; re-baseline so the next
      // chunk does not mistake our own writes for someone else's.
      catalogueFingerprint: await importsRepository.fingerprint(tx, job.kind),
      ...(finished ? { appliedAt: new Date().toISOString() } : {}),
    });

    await recordAudit(tx, {
      action: 'import.applied',
      entityType: 'import_job',
      entityId: id,
      metadata: { kind: job.kind, rows: rows.length, throughRow: lastRowNo, finished },
    });

    return { progress: progressOf(await loadJob(tx, id)), applied: rows.length };
  });

  if (result.applied > 0) businessEvents.inc({ event: 'import.applied' });
  return result.progress;
}

/** A write failure, in words: which rule the row broke, never a stack trace. */
function rowFailureMessage(error: unknown, handler: KindHandler): string {
  const cause = (error as { cause?: unknown }).cause ?? error;
  const pg = cause as { code?: string; constraint?: string };
  if (pg.code === '23505') {
    return `Another ${handler.noun} already has this ${pg.constraint?.includes('barcode') ? 'barcode' : pg.constraint?.includes('phone') ? 'phone number' : 'code'}`;
  }
  if (pg.code === '23514') {
    return `This row breaks a rule for ${handler.kind} (${pg.constraint ?? 'a check'}), so it was not saved`;
  }
  return 'This row could not be saved';
}

// ---------------------------------------------------------------------------
// Read and cancel
// ---------------------------------------------------------------------------

export function getImport(id: string) {
  return withReadTransaction(async (tx) => describe(tx, await loadJob(tx, id)));
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
 * A job that has written rows cannot be cancelled — part of it is already in,
 * and "cancel" would imply an undo this does not perform.
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
