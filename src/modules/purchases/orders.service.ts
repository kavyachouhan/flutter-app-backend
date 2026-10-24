/**
 * Purchase orders.
 *
 * An order is an intention, not a transaction: it moves no stock, creates no
 * payable and has no tax. Its whole job is to be converted into bills, which
 * is why the only state it really keeps is how much of each line has
 * actually arrived.
 */
import { withReadTransaction, withTransaction, type Tx } from '../../db/tx.js';
import { requireAuthContext } from '../../lib/context.js';
import { ErrorCode, NotFoundError, UnprocessableError } from '../../lib/errors.js';
import { buildPage, parsePage } from '../../lib/pagination.js';
import { accessibleOutletIds, assertOutletAccess } from '../../middleware/authorize.js';
import { recordAudit } from '../audit/audit.js';
import { assertFeature } from '../entitlements/entitlements.js';
import { invoicesRepository } from '../invoices/invoices.repository.js';
import { outletsRepository } from '../outlets/outlets.repository.js';
import { suppliersRepository } from '../suppliers/suppliers.repository.js';
import { resolveTermsForDocument } from '../terms/terms.service.js';
import { tenantsRepository } from '../tenants/tenants.repository.js';
import { allocateNumber } from './numbering.js';
import { ordersRepository, type PurchaseOrderRow } from './orders.repository.js';
import type { CreatePurchaseOrderBody, ListPurchaseOrdersQuery } from './purchases.schemas.js';

async function loadOrder(tx: Tx, id: string) {
  const order = await ordersRepository.find(tx, id);
  if (!order) throw new NotFoundError('Purchase order');
  const lines = await ordersRepository.findLines(tx, id);
  return {
    ...order,
    lines: lines.map((line) => ({
      ...line,
      quantityPending: Math.max(0, line.quantityOrdered - line.quantityReceived),
    })),
  };
}

export function createPurchaseOrder(body: CreatePurchaseOrderBody) {
  const auth = requireAuthContext();
  assertOutletAccess(body.outletId);

  return withTransaction(async (tx) => {
    await assertFeature(tx, 'purchases');
    if (await ordersRepository.exists(tx, body.id)) return loadOrder(tx, body.id);

    const settings = await tenantsRepository.getSettings(tx);
    if (!(await outletsRepository.findOutlet(tx, body.outletId))) throw new NotFoundError('Outlet');
    if (!(await suppliersRepository.find(tx, body.supplierId))) throw new NotFoundError('Supplier');

    const itemIds = [...new Set(body.lines.map((l) => l.itemId))];
    const items = new Map(
      (await invoicesRepository.findItems(tx, itemIds)).map((item) => [item.id, item]),
    );
    const unknown = itemIds.filter((id) => !items.has(id));
    if (unknown.length > 0) throw new NotFoundError('Item', { details: { itemIds: unknown } });

    const number = await allocateNumber(tx, {
      outletId: body.outletId,
      documentType: 'purchase_order',
      documentDate: body.documentDate,
      fyStartMonth: settings.fyStartMonth,
    });

    // Indicative only — the bill decides the real figure. Rounded through
    // the quantity scale so it is comparable with a bill's totals.
    const estimatedTotal = body.lines.reduce(
      (sum, l) => sum + Math.round((l.expectedUnitCost * l.quantityOrdered) / 1000),
      0,
    );

    const terms = await resolveTermsForDocument(tx, body.termsId, 'purchase_order');

    await ordersRepository.insert(tx, {
      id: body.id,
      outletId: body.outletId,
      supplierId: body.supplierId,
      seriesId: number.seriesId,
      sequenceNo: number.sequenceNo,
      documentNumber: number.documentNumber,
      documentDate: body.documentDate,
      fyStartYear: number.fyStartYear,
      expectedDate: body.expectedDate ?? null,
      estimatedTotal,
      notes: body.notes ?? null,
      termsId: terms?.termsId ?? null,
      termsSnapshot: terms?.snapshot ?? null,
      createdBy: auth.userId,
    });

    await ordersRepository.insertLines(
      tx,
      body.id,
      body.lines.map((line, index) => ({
        id: line.id,
        lineNo: index + 1,
        itemId: line.itemId,
        itemName: line.itemName ?? items.get(line.itemId)?.name ?? '',
        unit: line.unit ?? items.get(line.itemId)?.unit ?? null,
        quantityOrdered: line.quantityOrdered,
        expectedUnitCost: line.expectedUnitCost,
      })),
    );

    await recordAudit(tx, {
      action: 'purchase_order.created',
      entityType: 'purchase_order',
      entityId: body.id,
      metadata: { documentNumber: number.documentNumber, supplierId: body.supplierId },
    });

    return loadOrder(tx, body.id);
  });
}

export function getPurchaseOrder(id: string) {
  return withReadTransaction(async (tx) => {
    const order = await loadOrder(tx, id);
    assertOutletAccess(order.outletId);
    return order;
  });
}

export async function listPurchaseOrders(query: ListPurchaseOrdersQuery) {
  if (query.outletId) assertOutletAccess(query.outletId);
  const page = parsePage(query);
  const rows = await withReadTransaction((tx) =>
    ordersRepository.list(
      tx,
      {
        supplierId: query.supplierId,
        outletId: query.outletId,
        status: query.status,
        openOnly: query.openOnly ?? false,
      },
      accessibleOutletIds(),
      page.limit,
      page.cursor,
    ),
  );
  return buildPage(rows, page.limit, (row: PurchaseOrderRow) => ({
    k: row.documentDate,
    id: row.id,
  }));
}

/**
 * Cancels an order.
 *
 * Refused once anything has been received against it: those goods and their
 * bill are real, and an order marked cancelled while its lines show receipts
 * would misdescribe what happened. Such an order is simply left partial.
 */
export function cancelPurchaseOrder(id: string, reason: string) {
  return withTransaction(async (tx) => {
    const order = await ordersRepository.find(tx, id, true);
    if (!order) throw new NotFoundError('Purchase order');
    assertOutletAccess(order.outletId);
    if (order.status === 'cancelled') return loadOrder(tx, id);

    const lines = await ordersRepository.findLines(tx, id);
    const received = lines.reduce((sum, l) => sum + l.quantityReceived, 0);
    if (received > 0) {
      throw new UnprocessableError(
        'Goods have already been received against this order, so it cannot be cancelled.',
        ErrorCode.PURCHASE_ORDER_CLOSED,
        { details: { receivedQuantity: received } },
      );
    }

    await ordersRepository.cancel(tx, id, reason);
    await recordAudit(tx, {
      action: 'purchase_order.cancelled',
      entityType: 'purchase_order',
      entityId: id,
      metadata: { reason, documentNumber: order.documentNumber },
    });
    return loadOrder(tx, id);
  });
}

/**
 * Checks a proposed receipt against what is still on order.
 *
 * Called by the bill service with the order's lines already locked, so the
 * figures cannot move between the check and the write.
 */
export async function assertReceiptFits(
  tx: Tx,
  orderId: string,
  receipts: readonly { lineId: string; quantity: number }[],
): Promise<void> {
  const order = await ordersRepository.find(tx, orderId, true);
  if (!order) throw new NotFoundError('Purchase order');
  if (order.status === 'cancelled') {
    throw new UnprocessableError(
      'That purchase order is cancelled.',
      ErrorCode.PURCHASE_ORDER_CLOSED,
    );
  }

  const lines = new Map(
    (await ordersRepository.lockLinesForReceipt(tx, orderId)).map((l) => [l.id, l]),
  );

  for (const receipt of receipts) {
    const line = lines.get(receipt.lineId);
    if (!line) {
      throw new UnprocessableError(
        'That order line does not belong to this purchase order.',
        ErrorCode.UNPROCESSABLE,
      );
    }
    const pending = line.quantityOrdered - line.quantityReceived;
    if (receipt.quantity > pending) {
      throw new UnprocessableError(
        'The quantity received is more than what remains on the order.',
        ErrorCode.RECEIPT_EXCEEDS_ORDER,
        { details: { lineId: receipt.lineId, pending, received: receipt.quantity } },
      );
    }
  }
}
