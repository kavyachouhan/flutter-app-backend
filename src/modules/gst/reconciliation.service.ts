/**
 * GSTR-2B reconciliation: the shop's purchase register against what its
 * suppliers actually filed.
 *
 * Shaped on the catalogue importer, which already solved the same problems:
 * the client registers an upload and PUTs the bytes straight to storage, then
 * drives ingest and reconcile; each phase takes `FOR UPDATE` on the job row so
 * two tabs cannot both claim it; and network I/O happens outside the
 * transaction, so a pooled connection is never held across a round trip to
 * storage.
 *
 * The matching itself is pure (`src/domain/gst/reconcile.ts`) and so is the
 * parsing (`parse-2b.ts`). What is left here is loading, bounding and
 * recording — which is the part that must not be clever.
 */
import { env } from '../../config/env.js';
import { withReadTransaction, withTransaction, type Tx } from '../../db/tx.js';
import { parseGstr2b } from '../../domain/gst/parse-2b.js';
import {
  creditAtRisk,
  reconcile,
  summarise,
  type ReconcileRules,
} from '../../domain/gst/reconcile.js';
import { requireAuthContext } from '../../lib/context.js';
import {
  ConflictError,
  ErrorCode,
  NotFoundError,
  UnprocessableError,
  ValidationError,
} from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { buildPage, parsePage } from '../../lib/pagination.js';
import { download, signUpload } from '../../lib/storage.js';
import { recordAudit } from '../audit/audit.js';
import { businessEvents } from '../../observability/metrics.js';
import { assertFeature } from '../entitlements/entitlements.js';
import { filingGstins } from './gst.service.js';
import { itcRepository } from './itc.repository.js';
import {
  reconciliationRepository,
  type Gstr2bImportRow,
} from './reconciliation.repository.js';
import type {
  AcceptMatchBody,
  CreateGstr2bImportBody,
  ListMatchesQuery,
} from './gst.schemas.js';

/**
 * Matching tolerances, read from configuration and handed to the pure
 * reconciler — the same arrangement the tax engine has with `allowedGstRates`.
 * These are judgement calls about other people's data entry rather than
 * arithmetic, and a reconciliation that cries wolf is worse than none because
 * the shopkeeper stops reading it.
 */
const RECONCILE_RULES: ReconcileRules = {
  taxTolerancePaise: env.GSTR2B_TAX_TOLERANCE_PAISE,
  dateToleranceDays: env.GSTR2B_DATE_TOLERANCE_DAYS,
};

function progressOf(job: Gstr2bImportRow) {
  return {
    id: job.id,
    gstin: job.gstin,
    periodYear: job.periodYear,
    periodMonth: job.periodMonth,
    format: job.format,
    status: job.status,
    invoiceCount: job.invoiceCount,
    exactCount: job.exactCount,
    probableCount: job.probableCount,
    missingInBooks: job.missingInBooks,
    missingIn2b: job.missingIn2b,
    mismatchCount: job.mismatchCount,
    errorSummary: job.errorSummary,
    ingestedAt: job.ingestedAt,
    reconciledAt: job.reconciledAt,
    done:
      job.status === 'reconciled' || job.status === 'failed' || job.status === 'cancelled',
  };
}

async function loadJob(tx: Tx, id: string, forUpdate = false): Promise<Gstr2bImportRow> {
  const job = await reconciliationRepository.findImport(tx, id, forUpdate);
  if (!job) throw new NotFoundError('GSTR-2B import');
  return job;
}

function wrongState(job: Gstr2bImportRow, expected: readonly string[]): ConflictError {
  return new ConflictError(
    `This import is ${job.status}; expected ${expected.join(' or ')}.`,
    ErrorCode.CONFLICT,
    { details: { status: job.status, expected } },
  );
}

/** The window our own bills are compared over: the period, widened a month. */
function comparisonWindow(job: Gstr2bImportRow): { from: string; to: string } {
  const startAbsolute =
    job.periodYear * 12 + (job.periodMonth - 1) - env.GSTR2B_COMPARISON_MONTHS;
  const endAbsolute = job.periodYear * 12 + (job.periodMonth - 1) + env.GSTR2B_COMPARISON_MONTHS;
  const fromYear = Math.floor(startAbsolute / 12);
  const fromMonth = (startAbsolute % 12) + 1;
  const toYear = Math.floor(endAbsolute / 12);
  const toMonth = (endAbsolute % 12) + 1;

  const nextMonth = toMonth === 12 ? 1 : toMonth + 1;
  const nextYear = toMonth === 12 ? toYear + 1 : toYear;
  const lastDay = new Date(Date.UTC(nextYear, nextMonth - 1, 1) - 86_400_000)
    .toISOString()
    .slice(0, 10);

  return {
    from: `${fromYear}-${String(fromMonth).padStart(2, '0')}-01`,
    to: lastDay,
  };
}

/**
 * Registers an import and returns a signed URL for the bytes.
 *
 * The signing is a network call, so it happens outside any transaction: the
 * importer learned that holding a pooled connection across a round trip to
 * storage is how a pool exhausts under load.
 */
export async function createImport(body: CreateGstr2bImportBody) {
  const auth = requireAuthContext();

  const gstin = await withReadTransaction(async (tx) => {
    await assertFeature(tx, 'gst_workings');
    const available = await filingGstins(tx);
    if (body.gstin && !available.includes(body.gstin)) {
      throw new UnprocessableError(
        'That GSTIN does not belong to this business.',
        ErrorCode.UNPROCESSABLE,
        { details: { available } },
      );
    }
    const resolved = body.gstin ?? available[0];
    if (!resolved) {
      throw new UnprocessableError(
        'This business is not GST registered, so it has no 2B statement to reconcile.',
        ErrorCode.UNPROCESSABLE,
      );
    }
    return resolved;
  });

  const upload = await signUpload('import', body.contentType, body.sizeBytes);

  return withTransaction(async (tx) => {
    const existing = await reconciliationRepository.findImport(tx, body.id);
    if (existing) return { ...progressOf(existing), ...upload };

    await reconciliationRepository.insertImport(tx, {
      id: body.id,
      gstin,
      periodYear: body.periodYear,
      periodMonth: body.periodMonth,
      objectKey: upload.objectKey,
      originalFilename: body.originalFilename ?? null,
      format: body.format,
      createdBy: auth.userId,
    });
    return { ...progressOf(await loadJob(tx, body.id)), ...upload };
  });
}

/**
 * Reads the uploaded statement and stores its rows.
 *
 * `ingesting` and `failed` are both re-runnable: a parse that died halfway
 * leaves nothing useful, and the shop's only recourse is to try again — the
 * same reasoning the catalogue importer applies.
 */
export async function ingestImport(id: string) {
  const objectKey = await withTransaction(async (tx) => {
    const job = await loadJob(tx, id, true);
    if (!['pending', 'ingesting', 'failed'].includes(job.status)) {
      throw wrongState(job, ['pending', 'ingesting', 'failed']);
    }
    await reconciliationRepository.setImportStatus(tx, id, 'ingesting');
    return job.objectKey;
  });

  // Outside the transaction: a download is a network call.
  const buffer = await download(objectKey);

  let parsed;
  try {
    parsed = parseGstr2b(JSON.parse(buffer.toString('utf8')));
  } catch (cause) {
    await withTransaction((tx) =>
      reconciliationRepository.failImport(tx, id, {
        reason: 'The file is not readable GSTR-2B JSON.',
        detail: cause instanceof Error ? cause.message : String(cause),
      }),
    );
    throw new ValidationError('The uploaded file is not readable GSTR-2B JSON.', {
      details: { importId: id },
    });
  }

  if (parsed.invoices.length > env.IMPORT_MAX_ROWS) {
    await withTransaction((tx) =>
      reconciliationRepository.failImport(tx, id, {
        reason: `The statement has ${parsed.invoices.length} rows; the limit is ${env.IMPORT_MAX_ROWS}.`,
      }),
    );
    throw new ValidationError('That statement is too large to reconcile in one go.');
  }

  return withTransaction(
    async (tx) => {
      await reconciliationRepository.clearInvoices(tx, id);
      await reconciliationRepository.insertInvoices(
        tx,
        id,
        parsed.invoices.map((invoice, index) => ({
          id: newId(),
          rowNo: index + 1,
          ...invoice,
        })),
      );
      await reconciliationRepository.setInvoiceCount(tx, id, parsed.invoices.length);

      // Unreadable rows are recorded rather than dropped: a row we could not
      // identify is not the same as a supplier who did not file, and only one
      // of those is worth chasing.
      if (parsed.errors.length > 0) {
        await reconciliationRepository.failImport(tx, id, {
          reason: 'Some rows could not be read; the rest were ingested.',
          rows: parsed.errors.slice(0, 50),
          total: parsed.errors.length,
        });
        await reconciliationRepository.setImportStatus(tx, id, 'ingested');
      }

      await recordAudit(tx, {
        action: 'gstr2b.ingested',
        entityType: 'gstr2b_import',
        entityId: id,
        metadata: {
          invoices: parsed.invoices.length,
          unreadableRows: parsed.errors.length,
          statementPeriod: parsed.statementPeriod,
        },
      });
      return progressOf(await loadJob(tx, id));
    },
    { retries: 0 },
  );
}

/**
 * Matches the statement against the purchase register.
 *
 * Done in one pass rather than in chunks, unlike the catalogue importer. A
 * month of 2B for a shop is hundreds of rows, not tens of thousands, and the
 * matching is inherently whole-set: pass two asks "is there any unmatched bill
 * from this supplier with about this amount", which a chunk cannot answer
 * without seeing the rest. `IMPORT_MAX_ROWS` bounds the input, and the row
 * lock keeps two runs from racing.
 */
export function reconcileImport(id: string) {
  return withTransaction(
    async (tx) => {
      await assertFeature(tx, 'gst_workings');
      const job = await loadJob(tx, id, true);
      if (!['ingested', 'reconciling', 'reconciled'].includes(job.status)) {
        throw wrongState(job, ['ingested', 'reconciled']);
      }
      await reconciliationRepository.setImportStatus(tx, id, 'reconciling');

      const window = comparisonWindow(job);
      const portal = await reconciliationRepository.portalInvoices(tx, id);
      const books = await reconciliationRepository.bookInvoices(tx, window.from, window.to);

      const results = reconcile(portal, books, RECONCILE_RULES);
      await reconciliationRepository.replaceMatches(
        tx,
        id,
        results.map((result) => ({
          id: newId(),
          matchType: result.matchType,
          gstr2bInvoiceId: result.portalInvoiceId ?? null,
          purchaseBillId: result.bookInvoiceId ?? null,
          differences: result.differences ?? null,
          taxDifference: result.taxDifference,
        })),
      );
      await reconciliationRepository.recordCounts(tx, id, summarise(results), true);

      // An exact match is evidence the supplier filed it, so the credit can be
      // claimed. A probable one is not: it needs a human, which is what the
      // accept endpoint is for.
      const period = `${job.periodYear}-${String(job.periodMonth).padStart(2, '0')}`;
      for (const result of results) {
        if (result.matchType !== 'exact' || !result.bookInvoiceId || !result.portalInvoiceId) {
          continue;
        }
        await itcRepository.markMatched(tx, result.bookInvoiceId, result.portalInvoiceId, period);
      }

      const atRisk = creditAtRisk(results);
      await recordAudit(tx, {
        action: 'gstr2b.reconciled',
        entityType: 'gstr2b_import',
        entityId: id,
        metadata: { ...summarise(results), creditAtRisk: atRisk, period },
      });
      return { progress: progressOf(await loadJob(tx, id)), creditAtRisk: atRisk };
    },
    { retries: 0 },
  ).then((result) => {
    businessEvents.inc({ event: 'gstr2b.reconciled' });
    return result;
  });
}

export function getImport(id: string) {
  return withReadTransaction(async (tx) => {
    const job = await loadJob(tx, id);
    return {
      ...progressOf(job),
      creditAtRisk: await reconciliationRepository.creditAtRisk(tx, id),
    };
  });
}

export async function listImports(query: { limit?: number; cursor?: string }) {
  const page = parsePage(query);
  const rows = await withReadTransaction((tx) =>
    reconciliationRepository.listImports(tx, page.limit, page.cursor),
  );
  const built = buildPage(rows, page.limit, (row) => ({
    k: row.createdAt.toISOString(),
    id: row.id,
  }));
  return { ...built, data: built.data.map(progressOf) };
}

export async function listMatches(id: string, query: ListMatchesQuery) {
  const page = parsePage(query);
  const rows = await withReadTransaction(async (tx) => {
    await loadJob(tx, id);
    return reconciliationRepository.listMatches(tx, id, query.matchType, page.limit, page.cursor);
  });
  return buildPage(rows, page.limit, (row) => ({ k: row.id, id: row.id }));
}

/**
 * Confirms a probable match.
 *
 * Only ever a human decision, and recorded as one: a probable match is two
 * documents that look alike but are numbered differently, and accepting one
 * wrongly claims credit against somebody else's invoice. Once accepted, a
 * later reconciliation leaves it alone.
 */
export function acceptMatch(importId: string, matchId: string, body: AcceptMatchBody) {
  const auth = requireAuthContext();

  return withTransaction(async (tx) => {
    await assertFeature(tx, 'gst_workings');
    const job = await loadJob(tx, importId);
    const match = await reconciliationRepository.findMatch(tx, matchId);
    if (!match) throw new NotFoundError('Match');
    if (match.acceptedAt) return match;
    if (match.matchType !== 'probable' && match.matchType !== 'mismatch') {
      throw new UnprocessableError(
        'Only a probable match or a mismatch needs confirming.',
        ErrorCode.UNPROCESSABLE,
        { details: { matchType: match.matchType } },
      );
    }

    await reconciliationRepository.acceptMatch(tx, matchId, auth.userId, body.note ?? null);
    if (match.purchaseBillId && match.gstr2bInvoiceId) {
      await itcRepository.markMatched(
        tx,
        match.purchaseBillId,
        match.gstr2bInvoiceId,
        `${job.periodYear}-${String(job.periodMonth).padStart(2, '0')}`,
      );
    }
    await recordAudit(tx, {
      action: 'gstr2b.match_accepted',
      entityType: 'gstr2b_match',
      entityId: matchId,
      metadata: {
        importId,
        matchType: match.matchType,
        purchaseBillId: match.purchaseBillId,
        taxDifference: match.taxDifference,
      },
    });
    return reconciliationRepository.findMatch(tx, matchId);
  });
}
