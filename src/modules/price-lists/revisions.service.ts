/**
 * Bulk price revision: raise a category 7%, reprice a wholesale list from
 * cost, round everything to the rupee.
 *
 * Modelled on the importer, deliberately and for the same reasons. The client
 * drives analyse and then apply, repeatedly, until the status stops changing.
 * Two properties hold it together:
 *
 *   **Serialised chunks.** Each call takes `FOR UPDATE` on the revision row,
 *   so a double tap or two open tabs cannot both claim the same slice.
 *
 *   **Idempotent rows.** `price_revision_rows.applied_at` is per row, so a
 *   resumed apply writes each price exactly once even if a chunk's
 *   transaction committed just before the client gave up waiting.
 *
 * The analyse phase exists because a price change is not reversible by
 * reading the result: once `sale_price` has moved, what it was is gone. So
 * every row is previewed with its old and new price before anything is
 * written, and the preview is what the shopkeeper approves.
 *
 * A chunked apply also keeps each transaction short. One UPDATE over five
 * thousand items would hold the per-tenant `server_seq` counter for the whole
 * write, and every one of those rows republishes to every device regardless —
 * which is correct, the tills need the new prices, but it should not arrive as
 * one lock-held burst.
 */
import { env } from '../../config/env.js';
import { withReadTransaction, withTransaction, type Tx } from '../../db/tx.js';
import { requireAuthContext } from '../../lib/context.js';
import { ConflictError, ErrorCode, NotFoundError } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { roundHalfAwayFromZero } from '../../lib/money.js';
import { buildPage, parsePage } from '../../lib/pagination.js';
import { recordAudit } from '../audit/audit.js';
import { businessEvents } from '../../observability/metrics.js';
import { assertFeature } from '../entitlements/entitlements.js';
import { priceListsRepository } from './price-lists.repository.js';
import {
  revisionsRepository,
  type PriceRevisionRow,
  type RevisionCandidate,
} from './revisions.repository.js';
import type {
  CreatePriceRevisionBody,
  ListPriceRevisionsQuery,
  ListRevisionRowsQuery,
} from './price-lists.schemas.js';

const ANALYSE_CHUNK = env.PRICE_REVISION_ANALYSE_CHUNK_ROWS;
const APPLY_CHUNK = env.PRICE_REVISION_APPLY_CHUNK_ROWS;

function progressOf(revision: PriceRevisionRow) {
  return {
    id: revision.id,
    target: revision.target,
    priceListId: revision.priceListId,
    operation: revision.operation,
    operationValue: Number(revision.operationValue),
    status: revision.status,
    totalRows: revision.totalRows,
    analysedUpToRow: revision.analysedUpToRow,
    appliedUpToRow: revision.appliedUpToRow,
    changeCount: revision.changeCount,
    skipCount: revision.skipCount,
    errorCount: revision.errorCount,
    errorSummary: revision.errorSummary,
    effectiveFrom: revision.effectiveFrom,
    analysedAt: revision.analysedAt,
    appliedAt: revision.appliedAt,
    /** True when the client can stop calling. */
    done:
      revision.status === 'applied' ||
      revision.status === 'failed' ||
      revision.status === 'cancelled',
  };
}

function wrongState(revision: PriceRevisionRow, expected: readonly string[]): ConflictError {
  return new ConflictError(
    `This revision is ${revision.status}; expected ${expected.join(' or ')}.`,
    ErrorCode.CONFLICT,
    { details: { status: revision.status, expected } },
  );
}

async function loadRevision(tx: Tx, id: string, forUpdate = false): Promise<PriceRevisionRow> {
  const revision = await revisionsRepository.find(tx, id, forUpdate);
  if (!revision) throw new NotFoundError('Price revision');
  return revision;
}

export function createPriceRevision(body: CreatePriceRevisionBody) {
  const auth = requireAuthContext();

  return withTransaction(async (tx) => {
    await assertFeature(tx, 'bulk_edit');
    await assertFeature(tx, 'price_lists');

    const existing = await revisionsRepository.find(tx, body.id);
    if (existing) return progressOf(existing);

    if (body.priceListId) {
      const list = await priceListsRepository.find(tx, body.priceListId);
      if (!list) throw new NotFoundError('Price list');
    }

    await revisionsRepository.insert(tx, {
      id: body.id,
      target: body.target,
      priceListId: body.priceListId ?? null,
      categoryId: body.categoryId ?? null,
      supplierId: body.supplierId ?? null,
      operation: body.operation,
      operationValue: body.operationValue,
      roundToPaise: body.roundToPaise ?? null,
      effectiveFrom: body.effectiveFrom ?? null,
      createdBy: auth.userId,
    });

    await recordAudit(tx, {
      action: 'price_revision.created',
      entityType: 'price_revision',
      entityId: body.id,
      metadata: {
        target: body.target,
        operation: body.operation,
        operationValue: body.operationValue,
        categoryId: body.categoryId ?? null,
        supplierId: body.supplierId ?? null,
      },
    });
    return progressOf(await loadRevision(tx, body.id));
  });
}

/**
 * Prices one chunk and stores the preview.
 *
 * Re-analysing from the start is allowed and clears the previous preview,
 * which is how a shopkeeper changes the percentage after seeing what it does —
 * but only rows not yet applied are cleared, so a part-applied revision can
 * never have its own history rewritten underneath it.
 */
export function analysePriceRevision(id: string) {
  return withTransaction(
    async (tx) => {
      const revision = await loadRevision(tx, id, true);
      if (!['pending', 'analysing', 'analysed'].includes(revision.status)) {
        throw wrongState(revision, ['pending', 'analysing', 'analysed']);
      }

      if (revision.status === 'pending') {
        await revisionsRepository.setStatus(tx, id, 'analysing');
        await revisionsRepository.resetAnalysis(tx, id);
      }

      const total = await revisionsRepository.countCandidates(tx, revision);
      const from = revision.analysedUpToRow;
      const candidates = await revisionsRepository.candidates(
        tx,
        revision,
        null,
        from,
        ANALYSE_CHUNK,
      );

      const floor = revision.target === 'price_list' ? await listFloor(tx, revision) : undefined;
      let changeCount = 0;
      let skipCount = 0;
      let errorCount = 0;

      const rows = candidates.map((candidate, index) => {
        const priced = priceFor(revision, candidate, floor);
        if (priced.action === 'change') changeCount += 1;
        else if (priced.action === 'error') errorCount += 1;
        else skipCount += 1;
        return {
          id: newId(),
          rowNo: from + index + 1,
          itemId: candidate.itemId,
          minQuantity: candidate.minQuantity,
          action: priced.action,
          oldPrice: candidate.currentPrice,
          newPrice: priced.newPrice,
          reason: priced.reason,
        };
      });

      await revisionsRepository.insertRows(tx, id, rows);

      const analysedUpTo = from + candidates.length;
      await revisionsRepository.recordProgress(tx, id, {
        analysedUpToRow: analysedUpTo,
        totalRows: total,
        changeCount,
        skipCount,
        errorCount,
        fingerprint: await revisionsRepository.fingerprint(tx, revision),
      });

      if (analysedUpTo >= total) await revisionsRepository.setStatus(tx, id, 'analysed');
      return progressOf(await loadRevision(tx, id));
    },
    // Chunks are serialised by the row lock, so a retry would re-enter a
    // transaction whose cursor has already moved.
    { retries: 0 },
  );
}

/** The floor the list refuses to price below, when it has one. */
async function listFloor(tx: Tx, revision: PriceRevisionRow): Promise<number | undefined> {
  if (!revision.priceListId) return undefined;
  const list = await priceListsRepository.find(tx, revision.priceListId);
  return list?.minPriceFloor ?? undefined;
}

interface PricedRow {
  action: 'change' | 'skip' | 'error';
  newPrice: number | null;
  reason: string | null;
}

/**
 * The new price for one candidate, or why there isn't one.
 *
 * Deliberately not in the pure pricing domain: this is a back-office batch
 * operation that no till runs, so there is nothing for the Dart port to
 * mirror, and keeping it here leaves `resolve.ts` to the one thing both sides
 * must agree on.
 */
function priceFor(
  revision: PriceRevisionRow,
  candidate: RevisionCandidate,
  floor: number | undefined,
): PricedRow {
  const value = Number(revision.operationValue);
  let next: number;

  switch (revision.operation) {
    case 'percent_increase':
      next = candidate.currentPrice + roundHalfAwayFromZero((candidate.currentPrice * value) / 100);
      break;
    case 'percent_decrease':
      next = candidate.currentPrice - roundHalfAwayFromZero((candidate.currentPrice * value) / 100);
      break;
    case 'amount_increase':
      next = candidate.currentPrice + Math.trunc(value);
      break;
    case 'amount_decrease':
      next = candidate.currentPrice - Math.trunc(value);
      break;
    case 'set_from_cost':
      // An item never purchased through the system has no average cost, and
      // marking up zero would price it at zero. Skipped and reported, never
      // silently set.
      if (candidate.averageCost === null || candidate.averageCost <= 0) {
        return { action: 'error', newPrice: null, reason: 'no average cost for this item' };
      }
      next = candidate.averageCost + roundHalfAwayFromZero((candidate.averageCost * value) / 100);
      break;
  }

  if (next < 0) {
    return { action: 'error', newPrice: null, reason: 'the new price would be negative' };
  }
  if (revision.roundToPaise) {
    next = roundHalfAwayFromZero(next / revision.roundToPaise) * revision.roundToPaise;
  }
  if (floor !== undefined && next < floor) {
    return {
      action: 'error',
      newPrice: next,
      reason: `below the list floor of ${floor} paise`,
    };
  }
  if (next === candidate.currentPrice) {
    return { action: 'skip', newPrice: next, reason: 'unchanged' };
  }
  return { action: 'change', newPrice: next, reason: null };
}

/**
 * Writes one chunk of the previewed prices.
 *
 * Refuses when the catalogue has moved since the preview: a revision analysed
 * this morning must not quietly reprice items added since, or apply a
 * percentage to a price somebody has already changed by hand.
 */
export function applyPriceRevision(id: string) {
  return withTransaction(
    async (tx) => {
      const revision = await loadRevision(tx, id, true);
      if (!['analysed', 'applying'].includes(revision.status)) {
        throw wrongState(revision, ['analysed', 'applying']);
      }

      const fingerprint = await revisionsRepository.fingerprint(tx, revision);
      if (revision.catalogueFingerprint !== fingerprint) {
        throw new ConflictError(
          'The catalogue has changed since this revision was previewed. Re-run the preview.',
          ErrorCode.CONFLICT,
          { details: { previewed: revision.catalogueFingerprint, current: fingerprint } },
        );
      }

      const chunk = await revisionsRepository.pendingApply(tx, id, APPLY_CHUNK);
      if (chunk.length > 0) {
        if (revision.target === 'price_list' && revision.priceListId) {
          await revisionsRepository.applyListPrices(tx, revision.priceListId, chunk);
        } else {
          await revisionsRepository.applyItemPrices(tx, chunk);
        }
        await revisionsRepository.markRowsApplied(
          tx,
          chunk.map((row) => row.id),
        );
      }

      const lastRow = chunk[chunk.length - 1]?.rowNo ?? revision.appliedUpToRow;
      const finished = chunk.length < APPLY_CHUNK;
      await revisionsRepository.setAppliedCursor(tx, id, lastRow, finished);

      // The trail records the price change itself, not merely that a job ran:
      // this is the same question `item.price_changed` answers for a single
      // edit, and the price-change-history report reads both.
      if (chunk.length > 0) {
        await recordAudit(tx, {
          action: 'price_revision.applied',
          entityType: 'price_revision',
          entityId: id,
          metadata: {
            rows: chunk.length,
            throughRow: lastRow,
            finished,
            target: revision.target,
            priceListId: revision.priceListId,
          },
        });
      }

      return { progress: progressOf(await loadRevision(tx, id)), written: chunk.length };
    },
    { retries: 0 },
  ).then((result) => {
    if (result.written > 0) businessEvents.inc({ event: 'price_revision.applied' });
    return result.progress;
  });
}

export function cancelPriceRevision(id: string) {
  return withTransaction(async (tx) => {
    const revision = await loadRevision(tx, id, true);
    // Half-applied prices cannot be rolled back by cancelling: the old prices
    // are only in the preview rows, and restoring them is a new revision, not
    // the absence of this one.
    if (revision.appliedUpToRow > 0) {
      throw new ConflictError(
        'This revision has already written prices and cannot be cancelled. Run a reversing revision instead.',
        ErrorCode.CONFLICT,
        { details: { appliedUpToRow: revision.appliedUpToRow } },
      );
    }
    await revisionsRepository.setStatus(tx, id, 'cancelled');
    await recordAudit(tx, {
      action: 'price_revision.cancelled',
      entityType: 'price_revision',
      entityId: id,
    });
  });
}

export function getPriceRevision(id: string) {
  return withReadTransaction(async (tx) => progressOf(await loadRevision(tx, id)));
}

export async function listPriceRevisions(query: ListPriceRevisionsQuery) {
  const page = parsePage(query);
  const rows = await withReadTransaction((tx) =>
    revisionsRepository.list(tx, query.status, page.limit, page.cursor),
  );
  const built = buildPage(rows, page.limit, (row) => ({
    k: row.createdAt.toISOString(),
    id: row.id,
  }));
  return { ...built, data: built.data.map(progressOf) };
}

/** The preview: what each row will become, and why some will not change. */
export async function listPriceRevisionRows(id: string, query: ListRevisionRowsQuery) {
  const page = parsePage(query);
  const rows = await withReadTransaction(async (tx) => {
    await loadRevision(tx, id);
    return revisionsRepository.listRows(tx, id, query.action, page.limit, page.cursor);
  });
  return buildPage(rows, page.limit, (row) => ({ k: row.rowNo, id: row.id }));
}
