import { withReadTransaction, withTransaction } from '../../db/tx.js';
import { requireAuthContext } from '../../lib/context.js';
import { ErrorCode, NotFoundError, UnprocessableError } from '../../lib/errors.js';
import { buildPage, parsePage } from '../../lib/pagination.js';
import { assertOutletAccess } from '../../middleware/authorize.js';
import { recordAudit } from '../audit/audit.js';
import { outletsRepository } from '../outlets/outlets.repository.js';
import { tenantsRepository } from '../tenants/tenants.repository.js';
import { stockRepository } from './stock.repository.js';
import type { CreateAdjustmentBody, LedgerQuery, ListBalancesQuery } from './stock.schemas.js';

export async function listBalances(query: ListBalancesQuery) {
  assertOutletAccess(query.outletId);
  const page = parsePage(query);
  const rows = await withReadTransaction((tx) =>
    stockRepository.listBalances(
      tx,
      { outletId: query.outletId, itemId: query.itemId, belowReorder: query.belowReorder ?? false },
      page.limit,
      page.cursor,
    ),
  );
  return buildPage(rows, page.limit, (row) => ({ k: row.itemName, id: row.itemId }));
}

export async function listLedger(query: LedgerQuery) {
  assertOutletAccess(query.outletId);
  const page = parsePage(query);
  const rows = await withReadTransaction((tx) =>
    stockRepository.listLedger(tx, query.outletId, query.itemId, page.limit, page.cursor),
  );
  return buildPage(rows, page.limit, (row) => ({ k: row.occurredAt.toISOString(), id: row.id }));
}

/**
 * Unlike a synced sale, an adjustment is made online by a manager, so the
 * tenant's negative-stock rule can be enforced rather than merely warned about.
 */
export function createAdjustment(body: CreateAdjustmentBody) {
  const auth = requireAuthContext();
  assertOutletAccess(body.outletId);

  return withTransaction(async (tx) => {
    const existing = await stockRepository.findEntry(tx, body.id);
    if (existing) {
      return {
        entry: existing,
        balance: await stockRepository.balanceFor(tx, existing.outletId, existing.itemId),
      };
    }

    if (!(await outletsRepository.findOutlet(tx, body.outletId))) throw new NotFoundError('Outlet');
    const item = await stockRepository.lockItem(tx, body.itemId);
    if (!item) throw new NotFoundError('Item');
    if (!item.trackStock) throw new UnprocessableError('This item does not track stock.');

    const settings = await tenantsRepository.getSettings(tx);
    const current = await stockRepository.balanceFor(tx, body.outletId, body.itemId);
    if (!settings.allowNegativeStock && current + body.quantityDelta < 0) {
      throw new UnprocessableError(
        'This adjustment would take stock below zero.',
        ErrorCode.INSUFFICIENT_STOCK,
        {
          details: { current, quantityDelta: body.quantityDelta },
        },
      );
    }
    // Stock promised to open orders is not free to write off either, unless the shop
    // has said it may go negative. Counting more in is always fine.
    if (!settings.allowNegativeStock && body.quantityDelta < 0) {
      const { reserved } = await stockRepository.levelFor(tx, body.outletId, body.itemId);
      if (current + body.quantityDelta < reserved) {
        throw new UnprocessableError(
          'This adjustment would take stock below what open sales orders have reserved.',
          ErrorCode.INSUFFICIENT_STOCK,
          { details: { current, reserved, quantityDelta: body.quantityDelta } },
        );
      }
    }

    await stockRepository.insertEntries(tx, [
      {
        id: body.id,
        outletId: body.outletId,
        itemId: body.itemId,
        entryType: body.reasonCode === 'opening' ? 'opening' : 'adjustment',
        quantityDelta: body.quantityDelta,
        reasonCode: body.reasonCode,
        referenceType: null,
        referenceId: null,
        occurredAt: body.occurredAt,
        note: body.note ?? null,
        createdBy: auth.userId,
      },
    ]);
    await recordAudit(tx, {
      action: 'stock.adjusted',
      entityType: 'item',
      entityId: body.itemId,
      metadata: {
        outletId: body.outletId,
        quantityDelta: body.quantityDelta,
        reasonCode: body.reasonCode,
      },
    });

    const entry = await stockRepository.findEntry(tx, body.id);
    return { entry, balance: await stockRepository.balanceFor(tx, body.outletId, body.itemId) };
  });
}
