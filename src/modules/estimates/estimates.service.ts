/**
 * Estimates / quotations.
 *
 * An estimate is an offer, not a sale: it moves no stock, takes no GST invoice number and
 * records no payment. It is editable while open. Converting it raises a sales order (done
 * here, in one transaction) or an invoice (raised by the till, which names the estimate on
 * the invoice); either way the estimate is then frozen and says what it became.
 */
import { randomUUID } from 'node:crypto';
import { withReadTransaction, withTransaction, type Tx } from '../../db/tx.js';
import type { TaxInvoiceResult } from '../../domain/tax/types.js';
import { requireAuthContext } from '../../lib/context.js';
import {
  ConflictError,
  ErrorCode,
  ForbiddenError,
  InternalError,
  NotFoundError,
  ValidationError,
} from '../../lib/errors.js';
import { buildPage, parsePage } from '../../lib/pagination.js';
import { assertKeyBelongsToTenant } from '../../lib/storage.js';
import { accessibleOutletIds, assertOutletAccess } from '../../middleware/authorize.js';
import { recordAudit } from '../audit/audit.js';
import { hasPermission } from '../auth/permissions.js';
import { customersRepository } from '../customers/customers.repository.js';
import { assertFeature } from '../entitlements/entitlements.js';
import { outletsRepository } from '../outlets/outlets.repository.js';
import { validateCustomFields } from '../print/custom-fields.js';
import { allocateNumber } from '../purchases/numbering.js';
import {
  assertItemsKnown,
  assertTotalsMatch,
  computeSaleTotals,
  loadSaleItems,
  taxModeFor,
} from '../sales-docs/prepare.js';
import { createSaleOrderInTx, manualTotals } from '../sales-orders/sales-orders.service.js';
import type { CreateSaleOrderBody } from '../sales-orders/sales-orders.schemas.js';
import { resolveTermsForDocument } from '../terms/terms.service.js';
import { tenantsRepository } from '../tenants/tenants.repository.js';
import {
  estimatesRepository,
  type EstimateHeaderUpdate,
  type EstimateLineWrite,
  type EstimateRow,
} from './estimates.repository.js';
import type {
  CancelEstimateBody,
  ConvertEstimateBody,
  CreateEstimateBody,
  ListEstimatesQuery,
  SummaryEstimatesQuery,
  UpdateEstimateBody,
} from './estimates.schemas.js';

/** Estimates ride on the sales-order plan feature: they are the first step of the same flow. */
const FEATURE = 'sales_orders';

async function loadEstimate(tx: Tx, id: string) {
  const estimate = await estimatesRepository.find(tx, id);
  if (!estimate) throw new NotFoundError('Estimate');
  const lines = await estimatesRepository.findLines(tx, id);
  const convertedToNumber =
    estimate.convertedToType && estimate.convertedToId
      ? await estimatesRepository.convertedDocumentNumber(
          tx,
          estimate.convertedToType,
          estimate.convertedToId,
        )
      : null;
  return {
    ...estimate,
    // Nothing is owed on an offer; it is still "to be won" only while open.
    balance: estimate.status === 'open' ? estimate.grandTotal : 0,
    convertedToNumber,
    lines,
  };
}

interface PreparedEstimate {
  header: Omit<EstimateHeaderUpdate, 'id'>;
  lines: EstimateLineWrite[];
}

/** Everything create and update must agree on, so an edit is validated as strictly as a create. */
async function prepareEstimate(tx: Tx, body: UpdateEstimateBody): Promise<PreparedEstimate> {
  if (body.validUntil && body.validUntil < body.documentDate) {
    throw new ValidationError('The validity date cannot be before the estimate date.', {
      details: { field: 'validUntil' },
    });
  }

  const settings = await tenantsRepository.getSettings(tx);
  const outlet = await outletsRepository.findOutlet(tx, body.outletId);
  if (!outlet) throw new NotFoundError('Outlet');

  const customer = body.customerId
    ? await customersRepository.find(tx, body.customerId)
    : undefined;
  if (body.customerId && !customer) throw new NotFoundError('Customer');

  const customerName = customer?.name ?? body.customerName ?? null;
  if (!customerName) {
    throw new ValidationError('A customer is required.', { details: { field: 'customerName' } });
  }

  for (const attachment of body.attachments ?? []) {
    assertKeyBelongsToTenant(attachment.objectKey);
    // Estimates share the order attachment policy (photo or PDF, 5 MB).
    if (attachment.objectKey.split('/')[1] !== 'order_attachment') {
      throw new ValidationError('That file was not uploaded as an attachment.', {
        details: { objectKey: attachment.objectKey },
      });
    }
  }

  await validateCustomFields(tx, 'estimate', body.customFields);

  const { items, unknown } = await loadSaleItems(tx, body.lines);
  assertItemsKnown(unknown);

  let totals: TaxInvoiceResult;
  if (body.lines.length === 0) {
    // An estimate may be for a typed amount with no items; anything else would let a
    // tampered request claim a total with nothing behind it.
    if (!body.manualTotal || body.manualTotal <= 0) {
      throw new ValidationError('Add at least one item or enter a total amount.', {
        details: { field: 'manualTotal' },
      });
    }
    if (body.billDiscount || (body.additionalCharges?.length ?? 0) > 0) {
      throw new ValidationError('A discount or charge needs items to apply to.', {
        details: { field: 'lines' },
      });
    }
    totals = manualTotals(taxModeFor(settings), body.manualTotal);
  } else {
    if (body.manualTotal !== undefined && body.manualTotal !== null) {
      throw new ValidationError('A manual total can only be used on an estimate with no items.', {
        details: { field: 'manualTotal' },
      });
    }
    totals = computeSaleTotals({
      settings,
      outlet,
      customer,
      items,
      placeOfSupplyStateCode: body.placeOfSupplyStateCode,
      supplyType: body.supplyType,
      isReverseCharge: body.isReverseCharge,
      pricesIncludeTax: body.pricesIncludeTax,
      roundOff: body.roundOff,
      billDiscount: body.billDiscount,
      additionalCharges: body.additionalCharges,
      lines: body.lines,
    });

    // The engine clamps an oversized discount, which would quietly store a smaller one
    // than the person typed.
    body.lines.forEach((line, index) => {
      const computed = totals.lines[index];
      if (
        line.discount?.kind === 'amount' &&
        computed &&
        computed.lineDiscount < line.discount.value
      ) {
        throw new ValidationError('A line discount is more than the line comes to.', {
          details: { code: ErrorCode.DISCOUNT_EXCEEDS_TOTAL, lineId: line.id },
        });
      }
    });
    if (body.billDiscount?.kind === 'amount' && totals.billDiscount < body.billDiscount.value) {
      throw new ValidationError('The bill discount is more than the bill comes to.', {
        details: { code: ErrorCode.DISCOUNT_EXCEEDS_TOTAL },
      });
    }
  }

  assertTotalsMatch(totals, body.expectedTotals, 'Estimate');

  const terms = await resolveTermsForDocument(tx, body.termsId, 'estimate');

  const lines: EstimateLineWrite[] = body.lines.map((l, index) => {
    const computed = totals.lines[index];
    if (!computed) throw new InternalError('Tax engine returned fewer lines than it was given.');
    const item = items.itemFor(l.itemId);
    return {
      id: l.id,
      lineNo: index + 1,
      itemId: l.itemId ?? null,
      itemName: l.itemName ?? item?.name ?? '',
      hsnCode: computed.hsnCode ?? null,
      unit: l.unit ?? item?.unit ?? null,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      discount: l.discount ?? null,
      grossAmount: computed.grossAmount,
      lineDiscount: computed.lineDiscount,
      billDiscountShare: computed.apportionedBillDiscount,
      taxableAmount: computed.taxableAmount,
      taxRatePercent: computed.taxRatePercent,
      cessRatePercent: computed.cessRatePercent,
      cgst: computed.cgst,
      sgst: computed.sgst,
      igst: computed.igst,
      cess: computed.cess,
      lineTotal: computed.lineTotal,
      supplyCategory: computed.supplyCategory,
    };
  });

  return {
    lines,
    header: {
      outletId: body.outletId,
      documentDate: body.documentDate,
      validUntil: body.validUntil ?? null,
      customerId: customer?.id ?? null,
      customerName,
      customerPhone: body.customerPhone ?? customer?.phone ?? null,
      placeOfSupplyStateCode: body.placeOfSupplyStateCode ?? customer?.stateCode ?? null,
      pricesIncludeTax: body.pricesIncludeTax,
      roundOffEnabled: body.roundOff,
      isReverseCharge: body.isReverseCharge ?? false,
      totals,
      billDiscount: body.billDiscount ?? null,
      billDiscountReason: body.billDiscountReason ?? null,
      additionalCharges: body.additionalCharges ?? [],
      notes: body.notes ?? null,
      customFields: body.customFields ?? null,
      attachments: body.attachments ?? [],
      termsId: terms?.termsId ?? null,
      termsSnapshot: terms?.snapshot ?? null,
    },
  };
}

/** Only an open estimate can change: a converted one is the origin of another document. */
function assertOpen(estimate: EstimateRow): void {
  if (estimate.status === 'converted') {
    throw new ConflictError(
      'This estimate has already been converted and can no longer be changed.',
      ErrorCode.ESTIMATE_ALREADY_CONVERTED,
      {
        details: {
          convertedToType: estimate.convertedToType,
          convertedToId: estimate.convertedToId,
        },
      },
    );
  }
  if (estimate.status !== 'open') {
    throw new ConflictError(
      `This estimate is ${estimate.status} and can no longer be changed.`,
      ErrorCode.ESTIMATE_NOT_OPEN,
      { details: { status: estimate.status } },
    );
  }
}

// --- Create / read / update --------------------------------------------------

export function createEstimate(body: CreateEstimateBody) {
  const auth = requireAuthContext();
  assertOutletAccess(body.outletId);

  return withTransaction(async (tx) => {
    await assertFeature(tx, FEATURE);
    if (await estimatesRepository.exists(tx, body.id)) {
      const existing = await estimatesRepository.find(tx, body.id);
      if (!existing) {
        throw new ConflictError('That estimate was deleted.', ErrorCode.ESTIMATE_NOT_OPEN);
      }
      return { estimate: await loadEstimate(tx, body.id), replayed: true };
    }

    const prepared = await prepareEstimate(tx, body);
    const settings = await tenantsRepository.getSettings(tx);
    const number = await allocateNumber(tx, {
      outletId: body.outletId,
      documentType: 'estimate',
      documentDate: body.documentDate,
      fyStartMonth: settings.fyStartMonth,
    });

    await estimatesRepository.insertHeader(tx, {
      ...prepared.header,
      id: body.id,
      seriesId: number.seriesId,
      sequenceNo: number.sequenceNo,
      documentNumber: number.documentNumber,
      fyStartYear: number.fyStartYear,
      createdBy: auth.userId,
    });
    await estimatesRepository.insertLines(tx, body.id, prepared.lines);

    await recordAudit(tx, {
      action: 'estimate.created',
      entityType: 'estimate',
      entityId: body.id,
      metadata: {
        documentNumber: number.documentNumber,
        grandTotal: prepared.header.totals.grandTotal,
        customerId: prepared.header.customerId,
      },
    });
    return { estimate: await loadEstimate(tx, body.id), replayed: false };
  });
}

export function updateEstimate(id: string, body: UpdateEstimateBody) {
  return withTransaction(async (tx) => {
    await assertFeature(tx, FEATURE);
    // Locked, so an edit and a conversion of the same estimate cannot interleave.
    const estimate = await estimatesRepository.find(tx, id, true);
    if (!estimate) throw new NotFoundError('Estimate');
    assertOutletAccess(estimate.outletId);
    assertOpen(estimate);
    if (body.outletId !== estimate.outletId) {
      throw new ValidationError('An estimate cannot be moved to another outlet.', {
        details: { field: 'outletId' },
      });
    }

    const prepared = await prepareEstimate(tx, body);
    await estimatesRepository.updateHeader(tx, { ...prepared.header, id });
    await estimatesRepository.deleteLines(tx, id);
    await estimatesRepository.insertLines(tx, id, prepared.lines);

    await recordAudit(tx, {
      action: 'estimate.updated',
      entityType: 'estimate',
      entityId: id,
      metadata: {
        documentNumber: estimate.documentNumber,
        grandTotalBefore: estimate.grandTotal,
        grandTotalAfter: prepared.header.totals.grandTotal,
      },
    });
    return { estimate: await loadEstimate(tx, id) };
  });
}

export function getEstimate(id: string) {
  return withReadTransaction(async (tx) => {
    await assertFeature(tx, FEATURE);
    const estimate = await loadEstimate(tx, id);
    assertOutletAccess(estimate.outletId);
    return estimate;
  });
}

export async function listEstimates(query: ListEstimatesQuery) {
  if (query.outletId) assertOutletAccess(query.outletId);
  const page = parsePage(query);
  const rows = await withReadTransaction(async (tx) => {
    await assertFeature(tx, FEATURE);
    return estimatesRepository.list(
      tx,
      {
        status: query.status,
        customerId: query.customerId,
        outletId: query.outletId,
        q: query.q,
      },
      accessibleOutletIds(),
      page.limit,
      page.cursor,
    );
  });
  const result = buildPage(rows, page.limit, (row: EstimateRow) => ({
    k: row.documentDate,
    id: row.id,
  }));
  return {
    ...result,
    data: result.data.map((row) => ({
      ...row,
      balance: row.status === 'open' ? row.grandTotal : 0,
    })),
  };
}

export function summaryEstimates(query: SummaryEstimatesQuery) {
  if (query.outletId) assertOutletAccess(query.outletId);
  return withReadTransaction(async (tx) => {
    await assertFeature(tx, FEATURE);
    return estimatesRepository.summary(tx, query.outletId, accessibleOutletIds());
  });
}

// --- Lifecycle -----------------------------------------------------------------

/** Deletes an estimate (soft: the number stays accounted for). A converted one is refused. */
export function deleteEstimate(id: string) {
  return withTransaction(async (tx) => {
    await assertFeature(tx, FEATURE);
    const estimate = await estimatesRepository.find(tx, id, true);
    if (!estimate) throw new NotFoundError('Estimate');
    assertOutletAccess(estimate.outletId);
    if (estimate.status === 'converted') assertOpen(estimate);

    await estimatesRepository.softDelete(tx, id);
    await recordAudit(tx, {
      action: 'estimate.deleted',
      entityType: 'estimate',
      entityId: id,
      metadata: { documentNumber: estimate.documentNumber },
    });
  });
}

export function cancelEstimate(id: string, body: CancelEstimateBody) {
  return withTransaction(async (tx) => {
    await assertFeature(tx, FEATURE);
    const estimate = await estimatesRepository.find(tx, id, true);
    if (!estimate) throw new NotFoundError('Estimate');
    assertOutletAccess(estimate.outletId);
    if (estimate.status === 'cancelled') return loadEstimate(tx, id);
    assertOpen(estimate);

    await estimatesRepository.cancel(tx, id, body.reason);
    await recordAudit(tx, {
      action: 'estimate.cancelled',
      entityType: 'estimate',
      entityId: id,
      metadata: { documentNumber: estimate.documentNumber, reason: body.reason },
    });
    return loadEstimate(tx, id);
  });
}

/** Closes an open estimate by hand: the quote was lost or lapsed. */
export function closeEstimate(id: string) {
  return withTransaction(async (tx) => {
    await assertFeature(tx, FEATURE);
    const estimate = await estimatesRepository.find(tx, id, true);
    if (!estimate) throw new NotFoundError('Estimate');
    assertOutletAccess(estimate.outletId);
    if (estimate.status === 'closed') return loadEstimate(tx, id);
    assertOpen(estimate);

    await estimatesRepository.close(tx, id);
    await recordAudit(tx, {
      action: 'estimate.closed',
      entityType: 'estimate',
      entityId: id,
      metadata: { documentNumber: estimate.documentNumber },
    });
    return loadEstimate(tx, id);
  });
}

// --- Conversion ----------------------------------------------------------------

/** The estimate's own date format is YYYY-MM-DD in the shop's time zone. */
function todayIn(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
}

const DECLARED_SUPPLY_TYPES = [
  'export_with_tax',
  'export_without_tax',
  'sez_with_tax',
  'sez_without_tax',
] as const;

/**
 * Raises a sales order from an open estimate, in one transaction with the estimate
 * becoming `converted`. The estimate row is locked first, so two clicks (or two devices)
 * cannot raise two orders; the second sees the estimate converted and is refused.
 *
 * The order carries the estimate's customer, items, quantities, prices, discounts and
 * taxes, and its T&C snapshot. The T&C is copied as the estimate printed it rather than
 * re-resolved, since a T&C written for estimates need not also apply to sales orders.
 */
export function convertEstimateToSalesOrder(id: string, input: ConvertEstimateBody) {
  const auth = requireAuthContext();
  if (!hasPermission(auth.role, 'sales_orders:create')) {
    throw new ForbiddenError(undefined, ErrorCode.INSUFFICIENT_ROLE, {
      details: { required: 'sales_orders:create' },
    });
  }

  return withTransaction(async (tx) => {
    await assertFeature(tx, FEATURE);
    const estimate = await estimatesRepository.find(tx, id, true);
    if (!estimate) throw new NotFoundError('Estimate');
    assertOutletAccess(estimate.outletId);
    assertOpen(estimate);

    const lines = await estimatesRepository.findLines(tx, id);
    const tenant = await tenantsRepository.findCurrent(tx);
    if (!tenant) throw new NotFoundError('Tenant');

    const declared = DECLARED_SUPPLY_TYPES.find((t) => t === estimate.supplyType);
    const body: CreateSaleOrderBody = {
      id: input.id,
      outletId: estimate.outletId,
      documentDate: todayIn(tenant.timezone),
      customerId: estimate.customerId,
      customerName: estimate.customerName,
      customerPhone: estimate.customerPhone,
      placeOfSupplyStateCode: estimate.placeOfSupplyStateCode,
      ...(declared ? { supplyType: declared } : {}),
      isReverseCharge: estimate.isReverseCharge,
      pricesIncludeTax: estimate.pricesIncludeTax,
      roundOff: estimate.roundOffEnabled,
      lines: lines.map((l) => ({
        // The order's lines are its own rows with their own ids.
        id: randomUUID(),
        itemId: l.itemId,
        itemName: l.itemName,
        ...(l.hsnCode ? { hsnCode: l.hsnCode } : {}),
        ...(l.unit ? { unit: l.unit } : {}),
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        ...(l.discount ? { discount: l.discount } : {}),
        taxRatePercent: Number(l.taxRatePercent),
        cessRatePercent: Number(l.cessRatePercent),
        supplyCategory: l.supplyCategory,
      })),
      ...(lines.length === 0 ? { manualTotal: estimate.grandTotal } : {}),
      ...(estimate.billDiscount ? { billDiscount: estimate.billDiscount } : {}),
      ...(estimate.billDiscountReason ? { billDiscountReason: estimate.billDiscountReason } : {}),
      additionalCharges:
        (estimate.additionalCharges as CreateSaleOrderBody['additionalCharges']) ?? [],
      advanceAmount: 0,
      notes: estimate.notes,
      attachments: (estimate.attachments as CreateSaleOrderBody['attachments']) ?? [],
      ...(input.discountApprovals ? { discountApprovals: input.discountApprovals } : {}),
      expectedTotals: {
        grandTotal: estimate.grandTotal,
        totalTax: estimate.totalTax,
        taxableAmount: estimate.taxableAmount,
      },
    };

    const { order, replayed, warnings } = await createSaleOrderInTx(tx, body, estimate.id);
    if (replayed) {
      // The caller reused an order id; nothing was raised, so nothing may be marked.
      throw new ConflictError('That order id is already in use.', ErrorCode.DUPLICATE);
    }
    await estimatesRepository.copyTermsToSalesOrder(
      tx,
      order.id,
      estimate.termsId,
      estimate.termsSnapshot,
    );
    await estimatesRepository.markConverted(tx, id, 'sales_order', order.id);

    await recordAudit(tx, {
      action: 'estimate.converted',
      entityType: 'estimate',
      entityId: id,
      metadata: {
        documentNumber: estimate.documentNumber,
        target: 'sales_order',
        salesOrderId: order.id,
        salesOrderNumber: order.documentNumber,
      },
    });
    return {
      estimate: await loadEstimate(tx, id),
      salesOrder: { id: order.id, documentNumber: order.documentNumber },
      warnings,
    };
  });
}

/**
 * Called inside invoice creation when the invoice was raised from an estimate. Returns the
 * estimate id to record on the invoice, or null when the link no longer holds (the estimate
 * is gone, or was already converted, e.g. by another till while this one was offline).
 *
 * It never refuses: by the time an invoice reaches the server it is a real sale that has
 * already been rung up, and a stale estimate link must not be able to reject it.
 */
export async function claimEstimateForInvoice(
  tx: Tx,
  estimateId: string | undefined,
): Promise<string | null> {
  if (!estimateId) return null;
  const estimate = await estimatesRepository.find(tx, estimateId, true);
  if (!estimate || estimate.status !== 'open') return null;
  return estimate.id;
}

/** Marks a claimed estimate converted, in the invoice's transaction. */
export async function markEstimateConvertedByInvoice(
  tx: Tx,
  estimateId: string,
  invoiceId: string,
  invoiceNumber: string,
): Promise<void> {
  await estimatesRepository.markConverted(tx, estimateId, 'invoice', invoiceId);
  await recordAudit(tx, {
    action: 'estimate.converted',
    entityType: 'estimate',
    entityId: estimateId,
    metadata: { target: 'invoice', invoiceId, invoiceNumber },
  });
}
