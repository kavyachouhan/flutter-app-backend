/**
 * Proforma invoices.
 *
 * A proforma invoice is a preliminary invoice, not a sale: it moves no stock, takes no GST
 * invoice number and records no payment or revenue. It is editable while open. It becomes an
 * invoice when the till raises one that names it (see `claimProformaInvoiceForInvoice`); it is
 * then frozen and says what it became. It lapses by date: see `sales-docs/expiry.ts`.
 */
import { withReadTransaction, withTransaction, type Tx } from '../../db/tx.js';
import type { TaxInvoiceResult } from '../../domain/tax/types.js';
import {
  assertAttachments,
  checkAttachments,
  removeDroppedAttachments,
} from '../../lib/attachments.js';
import { requireAuthContext } from '../../lib/context.js';
import {
  ConflictError,
  ErrorCode,
  InternalError,
  NotFoundError,
  ValidationError,
} from '../../lib/errors.js';
import { buildPage, parsePage } from '../../lib/pagination.js';
import { accessibleOutletIds, assertOutletAccess } from '../../middleware/authorize.js';
import { recordAudit } from '../audit/audit.js';
import { customersRepository } from '../customers/customers.repository.js';
import { assertFeature } from '../entitlements/entitlements.js';
import { outletsRepository } from '../outlets/outlets.repository.js';
import { numberForDocument } from '../purchases/numbering.js';
import { effectiveStatus, isExpired, todayIn } from '../sales-docs/expiry.js';
import {
  assertItemsKnown,
  assertTotalsMatch,
  computeSaleTotals,
  loadSaleItems,
  taxModeFor,
} from '../sales-docs/prepare.js';
import { manualTotals } from '../sales-orders/sales-orders.service.js';
import { resolveTermsForDocument } from '../terms/terms.service.js';
import { tenantsRepository } from '../tenants/tenants.repository.js';
import {
  proformaInvoicesRepository,
  type ProformaInvoiceHeaderUpdate,
  type ProformaInvoiceLineWrite,
  type ProformaInvoiceRow,
} from './proforma-invoices.repository.js';
import type {
  CancelProformaInvoiceBody,
  CreateProformaInvoiceBody,
  ListProformaInvoicesQuery,
  SummaryProformaInvoicesQuery,
  UpdateProformaInvoiceBody,
} from './proforma-invoices.schemas.js';

/** Proforma invoices ride on the sales-order plan feature: they are the first step of the same flow. */
const FEATURE = 'sales_orders';

async function loadProformaInvoice(tx: Tx, id: string) {
  const proformaInvoice = await proformaInvoicesRepository.find(tx, id);
  if (!proformaInvoice) throw new NotFoundError('ProformaInvoice');
  const lines = await proformaInvoicesRepository.findLines(tx, id);
  const convertedToNumber =
    proformaInvoice.convertedToType && proformaInvoice.convertedToId
      ? await proformaInvoicesRepository.convertedDocumentNumber(
          tx,
          proformaInvoice.convertedToType,
          proformaInvoice.convertedToId,
        )
      : null;
  const today = await shopToday(tx);
  return {
    ...proformaInvoice,
    ...validity(proformaInvoice, today),
    // Nothing is owed on a proforma invoice until it is invoiced; it is "to be won" only while open.
    balance: proformaInvoice.status === 'open' ? proformaInvoice.grandTotal : 0,
    convertedToNumber,
    lines,
  };
}

/** Today in the shop's time zone: the date every validity check is made against. */
async function shopToday(tx: Tx): Promise<string> {
  const tenant = await tenantsRepository.findCurrent(tx);
  if (!tenant) throw new NotFoundError('Tenant');
  return todayIn(tenant.timezone);
}

function validity(row: Pick<ProformaInvoiceRow, 'status' | 'validUntil'>, today: string) {
  return {
    isExpired: isExpired(row.status, row.validUntil, today),
    effectiveStatus: effectiveStatus(row.status, row.validUntil, today),
  };
}

interface PreparedProformaInvoice {
  header: Omit<ProformaInvoiceHeaderUpdate, 'id'>;
  lines: ProformaInvoiceLineWrite[];
}

/** Everything create and update must agree on, so an edit is validated as strictly as a create. */
async function prepareProformaInvoice(tx: Tx, body: UpdateProformaInvoiceBody): Promise<PreparedProformaInvoice> {
  if (body.validUntil && body.validUntil < body.documentDate) {
    throw new ValidationError('The validity date cannot be before the proforma invoice date.', {
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

  // Same rules as a sales order: the older `order_attachment` kind and the newer
  // `attachment_image` / `attachment_file` are both accepted.
  assertAttachments(body.attachments);

  const { items, unknown } = await loadSaleItems(tx, body.lines);
  assertItemsKnown(unknown);

  let totals: TaxInvoiceResult;
  if (body.lines.length === 0) {
    // A proforma invoice may be for a typed amount with no items; anything else would let a
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
      throw new ValidationError('A manual total can only be used on a proforma invoice with no items.', {
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

  assertTotalsMatch(totals, body.expectedTotals, 'Proforma invoice');

  const terms = await resolveTermsForDocument(tx, body.termsId, 'proforma_invoice');

  const lines: ProformaInvoiceLineWrite[] = body.lines.map((l, index) => {
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
      customFields: null,
      attachments: body.attachments ?? [],
      termsId: terms?.termsId ?? null,
      termsSnapshot: terms?.snapshot ?? null,
    },
  };
}

/** Only an open proforma invoice can change: a converted one is the origin of another document. */
function assertOpen(proformaInvoice: ProformaInvoiceRow): void {
  if (proformaInvoice.status === 'converted') {
    throw new ConflictError(
      'This proforma invoice has already been converted and can no longer be changed.',
      ErrorCode.PROFORMA_INVOICE_ALREADY_CONVERTED,
      {
        details: {
          convertedToType: proformaInvoice.convertedToType,
          convertedToId: proformaInvoice.convertedToId,
        },
      },
    );
  }
  if (proformaInvoice.status !== 'open') {
    throw new ConflictError(
      `This proforma invoice is ${proformaInvoice.status} and can no longer be changed.`,
      ErrorCode.PROFORMA_INVOICE_NOT_OPEN,
      { details: { status: proformaInvoice.status } },
    );
  }
}

// --- Create / read / update --------------------------------------------------

export async function createProformaInvoice(body: CreateProformaInvoiceBody) {
  const auth = requireAuthContext();
  // Proves each file really exists and is what it claims, before anything is written.
  await checkAttachments(body.attachments);
  assertOutletAccess(body.outletId);

  return withTransaction(async (tx) => {
    await assertFeature(tx, FEATURE);
    if (await proformaInvoicesRepository.exists(tx, body.id)) {
      const existing = await proformaInvoicesRepository.find(tx, body.id);
      if (!existing) {
        throw new ConflictError('That proforma invoice was deleted.', ErrorCode.PROFORMA_INVOICE_NOT_OPEN);
      }
      return { proformaInvoice: await loadProformaInvoice(tx, body.id), replayed: true };
    }

    const prepared = await prepareProformaInvoice(tx, body);
    const settings = await tenantsRepository.getSettings(tx);
    const number = await numberForDocument(tx, {
      outletId: body.outletId,
      documentType: 'proforma_invoice',
      documentDate: body.documentDate,
      fyStartMonth: settings.fyStartMonth,
      seriesId: body.seriesId,
      sequenceNo: body.sequenceNo,
    });

    await proformaInvoicesRepository.insertHeader(tx, {
      ...prepared.header,
      id: body.id,
      seriesId: number.seriesId,
      sequenceNo: number.sequenceNo,
      documentNumber: number.documentNumber,
      fyStartYear: number.fyStartYear,
      createdBy: auth.userId,
    });
    await proformaInvoicesRepository.insertLines(tx, body.id, prepared.lines);

    await recordAudit(tx, {
      action: 'proforma_invoice.created',
      entityType: 'proforma_invoice',
      entityId: body.id,
      metadata: {
        documentNumber: number.documentNumber,
        grandTotal: prepared.header.totals.grandTotal,
        customerId: prepared.header.customerId,
      },
    });
    return { proformaInvoice: await loadProformaInvoice(tx, body.id), replayed: false };
  });
}

export async function updateProformaInvoice(id: string, body: UpdateProformaInvoiceBody) {
  await checkAttachments(body.attachments);
  let previous: unknown;
  const result = await updateProformaInvoiceInTransaction(id, body, (a) => {
    previous = a;
  });
  // After the commit: files the edit took off the proforma invoice are no longer referenced.
  await removeDroppedAttachments(previous, body.attachments);
  return result;
}

function updateProformaInvoiceInTransaction(
  id: string,
  body: UpdateProformaInvoiceBody,
  onPrevious: (attachments: unknown) => void,
) {
  return withTransaction(async (tx) => {
    await assertFeature(tx, FEATURE);
    // Locked, so an edit and a conversion of the same proforma invoice cannot interleave.
    const proformaInvoice = await proformaInvoicesRepository.find(tx, id, true);
    if (!proformaInvoice) throw new NotFoundError('ProformaInvoice');
    onPrevious(proformaInvoice.attachments);
    assertOutletAccess(proformaInvoice.outletId);
    assertOpen(proformaInvoice);
    if (body.outletId !== proformaInvoice.outletId) {
      throw new ValidationError('A proforma invoice cannot be moved to another outlet.', {
        details: { field: 'outletId' },
      });
    }

    const prepared = await prepareProformaInvoice(tx, body);
    await proformaInvoicesRepository.updateHeader(tx, { ...prepared.header, id });
    await proformaInvoicesRepository.replaceLines(tx, id, prepared.lines);

    await recordAudit(tx, {
      action: 'proforma_invoice.updated',
      entityType: 'proforma_invoice',
      entityId: id,
      metadata: {
        documentNumber: proformaInvoice.documentNumber,
        grandTotalBefore: proformaInvoice.grandTotal,
        grandTotalAfter: prepared.header.totals.grandTotal,
      },
    });
    return { proformaInvoice: await loadProformaInvoice(tx, id) };
  });
}

export function getProformaInvoice(id: string) {
  return withReadTransaction(async (tx) => {
    await assertFeature(tx, FEATURE);
    const proformaInvoice = await loadProformaInvoice(tx, id);
    assertOutletAccess(proformaInvoice.outletId);
    return proformaInvoice;
  });
}

export async function listProformaInvoices(query: ListProformaInvoicesQuery) {
  if (query.outletId) assertOutletAccess(query.outletId);
  const page = parsePage(query);
  let today = '';
  const rows = await withReadTransaction(async (tx) => {
    await assertFeature(tx, FEATURE);
    today = await shopToday(tx);
    return proformaInvoicesRepository.list(
      tx,
      {
        status: query.status,
        customerId: query.customerId,
        outletId: query.outletId,
        q: query.q,
        today,
      },
      accessibleOutletIds(),
      page.limit,
      page.cursor,
    );
  });
  const result = buildPage(rows, page.limit, (row: ProformaInvoiceRow) => ({
    k: row.documentDate,
    id: row.id,
  }));
  return {
    ...result,
    data: result.data.map((row) => ({
      ...row,
      ...validity(row, today),
      balance: row.status === 'open' ? row.grandTotal : 0,
    })),
  };
}

export function summaryProformaInvoices(query: SummaryProformaInvoicesQuery) {
  if (query.outletId) assertOutletAccess(query.outletId);
  return withReadTransaction(async (tx) => {
    await assertFeature(tx, FEATURE);
    return proformaInvoicesRepository.summary(
      tx,
      query.outletId,
      accessibleOutletIds(),
      await shopToday(tx),
    );
  });
}

// --- Lifecycle -----------------------------------------------------------------

/** Deletes a proforma invoice (soft: the number stays accounted for). A converted one is refused. */
export function deleteProformaInvoice(id: string) {
  return withTransaction(async (tx) => {
    await assertFeature(tx, FEATURE);
    const proformaInvoice = await proformaInvoicesRepository.find(tx, id, true);
    if (!proformaInvoice) throw new NotFoundError('ProformaInvoice');
    assertOutletAccess(proformaInvoice.outletId);
    if (proformaInvoice.status === 'converted') assertOpen(proformaInvoice);

    await proformaInvoicesRepository.softDelete(tx, id);
    await recordAudit(tx, {
      action: 'proforma_invoice.deleted',
      entityType: 'proforma_invoice',
      entityId: id,
      metadata: { documentNumber: proformaInvoice.documentNumber },
    });
  });
}

export function cancelProformaInvoice(id: string, body: CancelProformaInvoiceBody) {
  return withTransaction(async (tx) => {
    await assertFeature(tx, FEATURE);
    const proformaInvoice = await proformaInvoicesRepository.find(tx, id, true);
    if (!proformaInvoice) throw new NotFoundError('ProformaInvoice');
    assertOutletAccess(proformaInvoice.outletId);
    if (proformaInvoice.status === 'cancelled') return loadProformaInvoice(tx, id);
    assertOpen(proformaInvoice);

    await proformaInvoicesRepository.cancel(tx, id, body.reason);
    await recordAudit(tx, {
      action: 'proforma_invoice.cancelled',
      entityType: 'proforma_invoice',
      entityId: id,
      metadata: { documentNumber: proformaInvoice.documentNumber, reason: body.reason },
    });
    return loadProformaInvoice(tx, id);
  });
}

/** Closes an open proforma invoice by hand: the quote was lost or lapsed. */
export function closeProformaInvoice(id: string) {
  return withTransaction(async (tx) => {
    await assertFeature(tx, FEATURE);
    const proformaInvoice = await proformaInvoicesRepository.find(tx, id, true);
    if (!proformaInvoice) throw new NotFoundError('ProformaInvoice');
    assertOutletAccess(proformaInvoice.outletId);
    if (proformaInvoice.status === 'closed') return loadProformaInvoice(tx, id);
    assertOpen(proformaInvoice);

    await proformaInvoicesRepository.close(tx, id);
    await recordAudit(tx, {
      action: 'proforma_invoice.closed',
      entityType: 'proforma_invoice',
      entityId: id,
      metadata: { documentNumber: proformaInvoice.documentNumber },
    });
    return loadProformaInvoice(tx, id);
  });
}

/**
 * Called inside invoice creation when the invoice was raised from a proforma invoice. Returns the
 * proforma invoice id to record on the invoice, or null when the link no longer holds (the proforma invoice
 * is gone, expired on the sale's date, or was already converted, e.g. by another till while
 * this one was offline).
 *
 * It never refuses: by the time an invoice reaches the server it is a real sale that has
 * already been rung up, and a stale proforma invoice link must not be able to reject it.
 */
export async function claimProformaInvoiceForInvoice(
  tx: Tx,
  proformaInvoiceId: string | undefined,
  asOf: string,
): Promise<string | null> {
  if (!proformaInvoiceId) return null;
  const proformaInvoice = await proformaInvoicesRepository.find(tx, proformaInvoiceId, true);
  if (!proformaInvoice || proformaInvoice.status !== 'open') return null;
  // Validity is judged on the day of the sale, not the day it reached the server: a till that
  // was offline sold it while the proforma invoice still held.
  if (isExpired(proformaInvoice.status, proformaInvoice.validUntil, asOf)) return null;
  return proformaInvoice.id;
}

/** Marks a claimed proforma invoice converted, in the invoice's transaction. */
export async function markProformaInvoiceConvertedByInvoice(
  tx: Tx,
  proformaInvoiceId: string,
  invoiceId: string,
  invoiceNumber: string,
): Promise<void> {
  await proformaInvoicesRepository.markConverted(tx, proformaInvoiceId, 'invoice', invoiceId);
  await recordAudit(tx, {
    action: 'proforma_invoice.converted',
    entityType: 'proforma_invoice',
    entityId: proformaInvoiceId,
    metadata: { target: 'invoice', invoiceId, invoiceNumber },
  });
}
