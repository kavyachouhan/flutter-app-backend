/**
 * Delivery challans.
 *
 * A challan records goods leaving the shop before a sale is billed — job
 * work, goods sent on approval, a branch transfer run as a challan. Unlike a
 * purchase order (an intention that moves nothing), a challan moves real
 * stock the moment it is created: the goods are physically gone. It creates
 * no GST invoice value and no customer receivable, because no sale has
 * happened yet — that is what converting it to an invoice will later do
 * (not built here).
 *
 * Stock reuses the 'sale' / 'sale_void' entry types invoices already use,
 * tagged with referenceType 'delivery_challan' instead of 'invoice'. No new
 * stock entry type, no new CHECK constraint.
 */
import { randomUUID } from 'node:crypto';
import { withReadTransaction, withTransaction, type Tx } from '../../db/tx.js';
import { assertAttachments, checkAttachments, removeDroppedAttachments } from '../../lib/attachments.js';
import { requireAuthContext } from '../../lib/context.js';
import {
  NotFoundError,
  UnprocessableError,
  ValidationError,
  WarningCode,
} from '../../lib/errors.js';
import { buildPage, parsePage } from '../../lib/pagination.js';
import { accessibleOutletIds, assertOutletAccess } from '../../middleware/authorize.js';
import { recordAudit } from '../audit/audit.js';
import { customersRepository } from '../customers/customers.repository.js';
import { invoicesRepository } from '../invoices/invoices.repository.js';
import { outletsRepository } from '../outlets/outlets.repository.js';
import { allocateNumber } from '../purchases/numbering.js';
import { stockRepository } from '../stock/stock.repository.js';
import { tenantsRepository } from '../tenants/tenants.repository.js';
import {
  deliveryChallansRepository,
  type DeliveryChallanRow,
} from './delivery-challans.repository.js';
import type {
  CreateDeliveryChallanBody,
  ListDeliveryChallansQuery,
  UpdateDeliveryChallanBody,
} from './delivery-challans.schemas.js';

async function loadChallan(tx: Tx, id: string) {
  const challan = await deliveryChallansRepository.find(tx, id);
  if (!challan) throw new NotFoundError('Delivery challan');
  const lines = await deliveryChallansRepository.findLines(tx, id);
  return { ...challan, lines };
}

export async function createDeliveryChallan(body: CreateDeliveryChallanBody) {
  const auth = requireAuthContext();
  assertOutletAccess(body.outletId);
  // Looks at the real files in storage, so before the transaction opens.
  await checkAttachments(body.attachments);

  return withTransaction(async (tx) => {
    // Same id twice (a retried request after a dropped reply) returns what
    // was already written instead of erroring or writing it twice.
    if (await deliveryChallansRepository.exists(tx, body.id)) return loadChallan(tx, body.id);

    const settings = await tenantsRepository.getSettings(tx);
    if (!(await outletsRepository.findOutlet(tx, body.outletId))) throw new NotFoundError('Outlet');
    if (body.customerId && !(await customersRepository.find(tx, body.customerId))) {
      throw new NotFoundError('Customer');
    }

    const itemIds = [...new Set(body.lines.map((l) => l.itemId))];
    const items = new Map(
      (await invoicesRepository.findItems(tx, itemIds)).map((item) => [item.id, item]),
    );
    const unknown = itemIds.filter((id) => !items.has(id));
    if (unknown.length > 0) throw new NotFoundError('Item', { details: { itemIds: unknown } });

    const number = await allocateNumber(tx, {
      outletId: body.outletId,
      documentType: 'delivery_challan',
      documentDate: body.documentDate,
      fyStartMonth: settings.fyStartMonth,
    });

    await deliveryChallansRepository.insert(tx, {
      id: body.id,
      outletId: body.outletId,
      customerId: body.customerId ?? null,
      seriesId: number.seriesId,
      sequenceNo: number.sequenceNo,
      documentNumber: number.documentNumber,
      documentDate: body.documentDate,
      fyStartYear: number.fyStartYear,
      notes: body.notes ?? null,
      attachments: body.attachments ?? [],
      createdBy: auth.userId,
    });

    await deliveryChallansRepository.insertLines(
      tx,
      body.id,
      body.lines.map((line, index) => ({
        id: line.id,
        lineNo: index + 1,
        itemId: line.itemId,
        itemName: line.itemName ?? items.get(line.itemId)?.name ?? '',
        unit: line.unit ?? items.get(line.itemId)?.unit ?? null,
        quantity: line.quantity,
      })),
    );

    const warnings: { code: string; details: unknown }[] = [];
    const stockLines = body.lines.flatMap((l) => {
      const item = items.get(l.itemId);
      return item?.trackStock ? [{ itemId: item.id, quantity: l.quantity }] : [];
    });
    if (stockLines.length > 0) {
      await stockRepository.insertEntries(
        tx,
        stockLines.map((s) => ({
          id: null,
          outletId: body.outletId,
          itemId: s.itemId,
          entryType: 'sale',
          quantityDelta: -s.quantity,
          reasonCode: null,
          referenceType: 'delivery_challan',
          referenceId: body.id,
          occurredAt: body.documentDate,
          note: null,
          createdBy: auth.userId,
        })),
      );
      for (const balance of await stockRepository.findNegativeBalances(
        tx,
        body.outletId,
        stockLines.map((s) => s.itemId),
      )) {
        warnings.push({ code: WarningCode.NEGATIVE_STOCK, details: balance });
      }
    }

    await recordAudit(tx, {
      action: 'delivery_challan.created',
      entityType: 'delivery_challan',
      entityId: body.id,
      metadata: { documentNumber: number.documentNumber, customerId: body.customerId },
    });

    const challan = await loadChallan(tx, body.id);
    return { ...challan, warnings };
  });
}

/**
 * Edits an open challan in place: wrong quantity, wrong item, a forgotten
 * line, a line that should not be there, the wrong customer — all fixable
 * without cancel-and-reissue, because a challan carries none of an
 * invoice's GST/legal weight. Refused once any part of it has been
 * invoiced, the same moment cancel is refused, because an invoice
 * downstream is now counting on that exact quantity.
 *
 * Stock is corrected by the *difference* between the old and new quantity
 * per item — not by reversing everything and reapplying it — so a later
 * cancel (which reverses every 'sale' entry ever written for this
 * reference) still gives back the exact right amount even after several
 * edits.
 */
export async function updateDeliveryChallan(id: string, body: UpdateDeliveryChallanBody) {
  await checkAttachments(body.attachments);
  let previous: unknown;
  const result = await updateChallanInTransaction(id, body, (a) => {
    previous = a;
  });
  // After the commit: files the edit took off the challan are no longer referenced.
  await removeDroppedAttachments(previous, body.attachments);
  return result;
}

function updateChallanInTransaction(
  id: string,
  body: UpdateDeliveryChallanBody,
  onPrevious: (attachments: unknown) => void,
) {
  const auth = requireAuthContext();

  return withTransaction(async (tx) => {
    const challan = await deliveryChallansRepository.find(tx, id, true);
    if (!challan) throw new NotFoundError('Delivery challan');
    onPrevious(challan.attachments);
    assertAttachments(body.attachments);
    assertOutletAccess(challan.outletId);
    if (challan.status !== 'open') {
      throw new UnprocessableError(
        'This challan has already been invoiced or cancelled, so it can no longer be edited.',
      );
    }

    if (body.customerId && !(await customersRepository.find(tx, body.customerId))) {
      throw new NotFoundError('Customer');
    }

    const existingLines = await deliveryChallansRepository.findLines(tx, id);
    const oldQtyByItem = new Map<string, number>();
    for (const l of existingLines) {
      oldQtyByItem.set(l.itemId, (oldQtyByItem.get(l.itemId) ?? 0) + l.quantity);
    }
    const newQtyByItem = new Map<string, number>();
    for (const l of body.lines) {
      newQtyByItem.set(l.itemId, (newQtyByItem.get(l.itemId) ?? 0) + l.quantity);
    }

    // Both sides: an item dropped from the new lines still needs its own
    // trackStock flag looked up so the stock it already took can be given
    // back correctly, not just assumed.
    const itemIds = [...new Set([...oldQtyByItem.keys(), ...newQtyByItem.keys()])];
    const items = new Map(
      (await invoicesRepository.findItems(tx, itemIds)).map((item) => [item.id, item]),
    );
    const unknownOnNewLines = [...newQtyByItem.keys()].filter((id) => !items.has(id));
    if (unknownOnNewLines.length > 0) {
      throw new NotFoundError('Item', { details: { itemIds: unknownOnNewLines } });
    }

    const warnings: { code: string; details: unknown }[] = [];
    const deltaEntries: { itemId: string; quantityDelta: number }[] = [];
    for (const itemId of itemIds) {
      if (!items.get(itemId)?.trackStock) continue;
      const delta = (oldQtyByItem.get(itemId) ?? 0) - (newQtyByItem.get(itemId) ?? 0);
      if (delta !== 0) deltaEntries.push({ itemId, quantityDelta: delta });
    }

    if (deltaEntries.length > 0) {
      await stockRepository.insertEntries(
        tx,
        deltaEntries.map((d) => ({
          id: null,
          outletId: challan.outletId,
          itemId: d.itemId,
          entryType: 'sale',
          quantityDelta: d.quantityDelta,
          reasonCode: null,
          referenceType: 'delivery_challan',
          referenceId: id,
          occurredAt: new Date().toISOString(),
          note: null,
          createdBy: auth.userId,
        })),
      );
      for (const balance of await stockRepository.findNegativeBalances(
        tx,
        challan.outletId,
        deltaEntries.map((d) => d.itemId),
      )) {
        warnings.push({ code: WarningCode.NEGATIVE_STOCK, details: balance });
      }
    }

    await deliveryChallansRepository.updateHeader(tx, id, {
      customerId: body.customerId,
      notes: body.notes,
      attachments: body.attachments,
    });
    await deliveryChallansRepository.replaceLines(
      tx,
      id,
      body.lines.map((line, index) => ({
        id: line.id,
        lineNo: index + 1,
        itemId: line.itemId,
        itemName: line.itemName ?? items.get(line.itemId)?.name ?? '',
        unit: line.unit ?? items.get(line.itemId)?.unit ?? null,
        quantity: line.quantity,
      })),
    );

    await recordAudit(tx, {
      action: 'delivery_challan.updated',
      entityType: 'delivery_challan',
      entityId: id,
      metadata: { documentNumber: challan.documentNumber },
    });

    const updated = await loadChallan(tx, id);
    return { ...updated, warnings };
  });
}

/**
 * Checks a proposed invoice against the challan lines it claims to bill.
 *
 * Called by invoice creation with those lines already locked (via
 * [deliveryChallansRepository.lockLinesByIds]), so the figures cannot move
 * between the check and the write — the same contract
 * `purchases/orders.service.ts`'s `assertReceiptFits` has for a bill
 * against a purchase order.
 */
export async function assertChallanLinesFit(
  tx: Tx,
  requests: readonly { lineId: string; itemId: string | null; quantity: number }[],
): Promise<readonly string[]> {
  if (requests.length === 0) return [];

  const locked = new Map(
    (await deliveryChallansRepository.lockLinesByIds(
      tx,
      requests.map((r) => r.lineId),
    )).map((l) => [l.id, l]),
  );

  const challanIds = [...new Set([...locked.values()].map((l) => l.deliveryChallanId))];
  const challans = new Map(
    await Promise.all(
      challanIds.map(async (challanId) => {
        const challan = await deliveryChallansRepository.find(tx, challanId);
        return [challanId, challan] as const;
      }),
    ),
  );

  for (const request of requests) {
    const line = locked.get(request.lineId);
    if (!line) {
      throw new UnprocessableError(
        'That delivery-challan line does not exist.',
        undefined,
        { details: { lineId: request.lineId } },
      );
    }
    const challan = challans.get(line.deliveryChallanId);
    if (!challan || challan.status === 'cancelled') {
      throw new UnprocessableError(
        'That delivery challan is cancelled, so it cannot be invoiced.',
        undefined,
        { details: { deliveryChallanId: line.deliveryChallanId } },
      );
    }
    if (request.itemId && request.itemId !== line.itemId) {
      throw new ValidationError(
        'The item on this line does not match the delivery-challan line it claims to bill.',
        { details: { lineId: request.lineId } },
      );
    }
    const pending = line.quantity - line.quantityInvoiced;
    if (request.quantity > pending) {
      throw new UnprocessableError(
        'The quantity billed is more than what remains on the delivery challan.',
        undefined,
        { details: { lineId: request.lineId, pending, requested: request.quantity } },
      );
    }
  }

  return challanIds;
}

export function getDeliveryChallan(id: string) {
  return withReadTransaction(async (tx) => {
    const challan = await loadChallan(tx, id);
    assertOutletAccess(challan.outletId);
    return challan;
  });
}

export async function listDeliveryChallans(query: ListDeliveryChallansQuery) {
  if (query.outletId) assertOutletAccess(query.outletId);
  const page = parsePage(query);
  const rows = await withReadTransaction((tx) =>
    deliveryChallansRepository.list(
      tx,
      {
        customerId: query.customerId,
        outletId: query.outletId,
        status: query.status,
        openOnly: query.openOnly ?? false,
        closedOnly: query.closedOnly ?? false,
      },
      accessibleOutletIds(),
      page.limit,
      page.cursor,
    ),
  );
  return buildPage(rows, page.limit, (row: DeliveryChallanRow) => ({
    k: row.documentDate,
    id: row.id,
  }));
}

/**
 * Cancels a challan and gives the stock back.
 *
 * Refused once anything on it has been invoiced: those goods were billed for
 * real, and a challan marked cancelled while its lines show invoiced
 * quantities would misdescribe what happened.
 */
export function cancelDeliveryChallan(id: string, reason: string) {
  return withTransaction(async (tx) => {
    const challan = await deliveryChallansRepository.find(tx, id, true);
    if (!challan) throw new NotFoundError('Delivery challan');
    assertOutletAccess(challan.outletId);
    if (challan.status === 'cancelled') return loadChallan(tx, id);

    const lines = await deliveryChallansRepository.findLines(tx, id);
    const invoiced = lines.reduce((sum, l) => sum + l.quantityInvoiced, 0);
    if (invoiced > 0) {
      throw new UnprocessableError(
        'Some of this challan has already been invoiced, so it cannot be cancelled.',
        undefined,
        { details: { invoicedQuantity: invoiced } },
      );
    }

    await deliveryChallansRepository.cancel(tx, id, reason);
    await stockRepository.reverseEntries(tx, {
      referenceType: 'delivery_challan',
      referenceId: id,
      entryType: 'sale',
      reversalType: 'sale_void',
      userId: requireAuthContext().userId,
    });

    await recordAudit(tx, {
      action: 'delivery_challan.cancelled',
      entityType: 'delivery_challan',
      entityId: id,
      metadata: { reason, documentNumber: challan.documentNumber },
    });
    return loadChallan(tx, id);
  });
}
