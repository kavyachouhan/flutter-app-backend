import { env } from '../../config/env.js';
import { withReadTransaction, withTransaction, type Tx } from '../../db/tx.js';
import { financialYearOf, formatDocumentNumber } from '../../domain/numbering/series.js';
import { requireAuthContext } from '../../lib/context.js';
import {
  ErrorCode,
  InternalError,
  NotFoundError,
  UnprocessableError,
  ValidationError,
  WarningCode,
  type WarningCodeValue,
} from '../../lib/errors.js';
import { buildPage, parsePage } from '../../lib/pagination.js';
import { accessibleOutletIds, assertOutletAccess } from '../../middleware/authorize.js';
import { businessEvents } from '../../observability/metrics.js';
import { recordAudit } from '../audit/audit.js';
import { customersRepository, type NewLedgerEntry } from '../customers/customers.repository.js';
import { numberingRepository } from '../numbering/numbering.repository.js';
import { toSeriesFormat } from '../numbering/numbering.service.js';
import { outletsRepository } from '../outlets/outlets.repository.js';
import { paymentsRepository } from '../payments/payments.repository.js';
import { validateCustomFields } from '../print/custom-fields.js';
import { purchasesRepository } from '../purchases/purchases.repository.js';
import { costOfGoodsSold } from '../../domain/costing/moving-average.js';
import { discountsRepository } from '../price-lists/discounts.repository.js';
import { resolveLinePrices } from '../price-lists/price-lists.service.js';
import { stockRepository } from '../stock/stock.repository.js';
import { assertFeature } from '../entitlements/entitlements.js';
import {
  applyAdvanceToInvoice,
  applyFulfilment,
  assertFulfilmentFits,
  reverseFulfilment,
} from '../sales-orders/sales-orders.service.js';
import {
  assertTotalsMatch,
  computeSaleTotals,
  evaluateDiscountCaps,
  loadSaleItems,
  mispricedLines,
  resolveApprovers,
  unapprovedBreaches,
} from '../sales-docs/prepare.js';
import { creditNotesRepository } from '../credit-notes/credit-notes.repository.js';
import { resolveTermsForDocument } from '../terms/terms.service.js';
import { tenantsRepository } from '../tenants/tenants.repository.js';
import { invoicesRepository, type InvoiceLineInsert } from './invoices.repository.js';
import type { CreateInvoiceBody, ListInvoicesQuery } from './invoices.schemas.js';

export interface Warning {
  code: WarningCodeValue;
  details: Record<string, unknown>;
}

async function loadInvoice(tx: Tx, id: string) {
  const header = await invoicesRepository.findHeader(tx, id);
  if (!header) throw new NotFoundError('Invoice');
  const lines = await invoicesRepository.findLines(tx, id);
  const payments = await paymentsRepository.findForInvoice(tx, id);
  const creditNotes = await creditNotesRepository.listForInvoice(tx, id);
  return {
    ...header,
    outstanding: header.grandTotal - header.amountPaid,
    lines,
    payments,
    creditNotes,
  };
}

/**
 * An invoice may be replaced once, and only after it has been fully credited.
 *
 * Amendment is a credit note for the whole invoice plus a new invoice. The credit
 * note reverses stock, tax and the khata; the replacement then bills what should
 * have been billed. Anything less than a full credit would leave the original
 * partly standing next to its own replacement.
 */
async function assertAmendable(tx: Tx, originalId: string): Promise<void> {
  const refuse = (message: string, details?: Record<string, unknown>): never => {
    throw new UnprocessableError(
      message,
      ErrorCode.AMENDMENT_NOT_ALLOWED,
      details ? { details } : {},
    );
  };
  const original = await invoicesRepository.findHeader(tx, originalId, true);
  if (!original) throw new NotFoundError('Invoice');
  assertOutletAccess(original.outletId);
  if (original.status !== 'issued') refuse('A void invoice cannot be amended.');
  if (original['amendedByInvoiceId']) {
    refuse('That invoice has already been replaced.', {
      replacedBy: original['amendedByInvoiceId'],
    });
  }
  // Charges are not on any line, so a credit note cannot reverse them: replacing the
  // invoice would bill them twice.
  const charges = original['additionalCharges'];
  if (Array.isArray(charges) && charges.length > 0) {
    refuse('An invoice with additional charges cannot be amended; void it instead.');
  }
  const sold = await creditNotesRepository.soldLines(tx, original.id, true);
  const open = sold.filter((l) => l.returnedQuantity < l.quantity).map((l) => l.id);
  if (open.length > 0) {
    refuse('Credit the whole invoice before replacing it.', { uncreditedLines: open });
  }
}

/**
 * Issues an invoice uploaded by a device — usually one billed offline.
 *
 * The sale has already happened by the time this runs, which shapes the rules:
 * structural problems (unleased number, totals that disagree with the shared
 * tax engine, unpaid credit with no customer) are rejected, but conditions a
 * device could not see offline (credit limit, stock level, a series deactivated
 * since the lease) are accepted and returned as warnings.
 */
export async function createInvoice(body: CreateInvoiceBody) {
  const auth = requireAuthContext();
  assertOutletAccess(body.outletId);

  const result = await withTransaction(async (tx) => {
    if (await invoicesRepository.exists(tx, body.id)) {
      return { invoice: await loadInvoice(tx, body.id), warnings: [] as Warning[], replayed: true };
    }

    const settings = await tenantsRepository.getSettings(tx);
    const outlet = await outletsRepository.findOutlet(tx, body.outletId);
    if (!outlet) throw new NotFoundError('Outlet');

    const series = await numberingRepository.findSeries(tx, body.seriesId);
    if (!series || series.outletId !== body.outletId || series.documentType !== 'invoice') {
      throw new UnprocessableError('The series is not an invoice series for this outlet.');
    }
    const counterId = body.counterId ?? series.counterId;
    if (series.counterId !== null && counterId !== series.counterId) {
      throw new UnprocessableError('The series belongs to a different counter.');
    }

    const fy = financialYearOf(body.documentDate, settings.fyStartMonth);
    if (fy.startYear !== series.fyStartYear) {
      throw new UnprocessableError('The document date falls outside the series financial year.');
    }

    const block = await numberingRepository.lockBlockForSequence(
      tx,
      series.id,
      auth.deviceId,
      body.sequenceNo,
    );
    if (!block) {
      throw new UnprocessableError(
        `Sequence ${body.sequenceNo} is not leased to this device.`,
        ErrorCode.NUMBER_NOT_LEASED,
      );
    }

    const customer = body.customerId
      ? await customersRepository.find(tx, body.customerId, true)
      : undefined;
    if (body.customerId && !customer) throw new NotFoundError('Customer');

    // Before the bag becomes part of an immutable document. A device that
    // billed offline against a field definition since deleted gets a clear
    // rejection naming the key, rather than an invoice that cannot be printed
    // with a proper label.
    await validateCustomFields(tx, 'invoice', body.customFields);

    // Deleted items are still resolved: an item removed after an offline sale
    // must not block that sale from uploading.
    const { items, unknown } = await loadSaleItems(tx, body.lines);
    if (unknown.length > 0)
      throw new ValidationError('Unknown items on the invoice.', { details: { itemIds: unknown } });
    const itemFor = (itemId: string | null | undefined) => items.itemFor(itemId);

    const totals = computeSaleTotals({
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
    assertTotalsMatch(totals, body.expectedTotals, 'Invoice');

    const tenders = body.payments ?? [];
    const paid = tenders.reduce((acc, t) => acc + t.amount, 0);
    if (paid > totals.grandTotal) {
      throw new UnprocessableError(
        'Payments exceed the invoice total; record change with tenderedAmount.',
        ErrorCode.OVERPAYMENT,
      );
    }
    const creditAmount = totals.grandTotal - paid;
    if (creditAmount > 0 && !customer) {
      throw new UnprocessableError(
        'An unpaid balance needs a customer to owe it.',
        ErrorCode.CREDIT_SALE_REQUIRES_CUSTOMER,
      );
    }

    // The moving average in force right now. It is snapshotted onto each line
    // below, so margin reads a historical fact rather than being recomputed
    // against whatever the item costs today — the bug that made Daily P&L
    // restate itself every time a buying price moved. The margin cap below
    // needs the same figures, so it is read once, here, before either.
    const costs = await purchasesRepository.costsFor(
      tx,
      body.outletId,
      body.lines.flatMap((l) => (l.itemId ? [l.itemId] : [])),
    );

    // What the customer's price list says each line should have cost. The
    // device priced from the list it held, so a difference is reported, never
    // corrected: rewriting the figure would make the stored invoice disagree
    // with the bill the customer is holding.
    const expectedPrices = await resolveLinePrices(tx, {
      outletId: body.outletId,
      customerId: customer?.id ?? null,
      documentDate: body.documentDate,
      lines: body.lines.map((l) => ({ id: l.id, itemId: l.itemId, quantity: l.quantity })),
    });

    const warnings: Warning[] = [];
    if (
      customer &&
      customer.creditLimit !== null &&
      customer.balance + creditAmount > customer.creditLimit
    ) {
      warnings.push({
        code: WarningCode.CREDIT_LIMIT_EXCEEDED,
        details: {
          customerId: customer.id,
          creditLimit: customer.creditLimit,
          balanceAfter: customer.balance + creditAmount,
        },
      });
    }

    // Discount caps. The till holds the policy and runs the same pure check,
    // so by the time a bill reaches here it either respected the cap or
    // carries an approval. The server re-runs the check anyway — that is what
    // makes a fabricated approval, or a device running a stale policy,
    // visible — and reports what it finds as a warning. Rejecting would
    // strand a sale that has already happened, which is the one thing an
    // offline till cannot recover from.
    const evaluation = await evaluateDiscountCaps(tx, {
      outletId: body.outletId,
      totals,
      lines: body.lines,
      costs,
    });
    const { breaches, approverPermission } = evaluation;

    const approvals = body.discountApprovals ?? [];
    const approvedKinds = new Set<string>(approvals.map((approval) => approval.breachKind));
    // An invoice fulfilling an order inherits what was approved on the order, so the
    // same discount is not asked about twice.
    if (body.salesOrderId) {
      for (const kind of await discountsRepository.approvedKindsForOrder(tx, body.salesOrderId)) {
        approvedKinds.add(kind);
      }
    }
    const unapproved = unapprovedBreaches(breaches, approvedKinds);
    if (unapproved.length > 0) {
      warnings.push({
        code: WarningCode.DISCOUNT_CAP_EXCEEDED,
        details: { breaches: unapproved },
      });
    }

    const mispriced = mispricedLines(expectedPrices, body.lines);
    if (mispriced.length > 0) {
      warnings.push({ code: WarningCode.PRICE_LIST_MISMATCH, details: { lines: mispriced } });
    }

    const documentNumber = formatDocumentNumber(
      toSeriesFormat(series),
      fy,
      body.sequenceNo,
      env.DOCUMENT_NUMBER_MAX_LENGTH,
    );

    const terms = await resolveTermsForDocument(tx, body.termsId, 'sale');

    // Fulfilling a sales order. The order's lines are locked and the claim
    // checked before anything is written, so two invoices raised against one
    // order at once cannot together over-fulfil it.
    const fulfilments = body.lines.flatMap((l) =>
      l.salesOrderLineId ? [{ lineId: l.salesOrderLineId, quantity: l.quantity }] : [],
    );
    if (fulfilments.length > 0 && !body.salesOrderId) {
      throw new ValidationError('salesOrderLineId needs salesOrderId on the invoice.');
    }
    // A plan without sales orders cannot fulfil one either.
    if (body.salesOrderId) await assertFeature(tx, 'sales_orders');
    // First, so an invoice that cannot be an amendment says so, rather than tripping over
    // the order it was raised against.
    if (body.amendsInvoiceId) await assertAmendable(tx, body.amendsInvoiceId);
    const order = body.salesOrderId
      ? await assertFulfilmentFits(tx, body.salesOrderId, customer?.id ?? null, fulfilments, {
          // The replacement re-bills what its credit note took back, which must work even
          // on an order that has since been closed.
          allowClosed: body.amendsInvoiceId !== undefined,
        })
      : undefined;

    await invoicesRepository.insertHeader(tx, {
      id: body.id,
      outletId: body.outletId,
      counterId,
      deviceId: auth.deviceId,
      seriesId: series.id,
      sequenceNo: body.sequenceNo,
      documentNumber,
      documentDate: body.documentDate,
      fyStartYear: fy.startYear,
      customerId: customer?.id ?? null,
      customerName: customer?.name ?? null,
      customerGstin: customer?.gstin ?? null,
      supplierGstin: outlet.gstin ?? settings.gstin,
      supplierStateCode: outlet.stateCode ?? settings.stateCode,
      placeOfSupplyStateCode: body.placeOfSupplyStateCode ?? customer?.stateCode ?? null,
      pricesIncludeTax: body.pricesIncludeTax,
      roundOffEnabled: body.roundOff,
      totals,
      billDiscount: body.billDiscount ?? null,
      additionalCharges: body.additionalCharges ?? [],
      notes: body.notes ?? null,
      termsId: terms?.termsId ?? null,
      termsSnapshot: terms?.snapshot ?? null,
      customFields: body.customFields ?? null,
      salesOrderId: body.salesOrderId ?? null,
      amendsInvoiceId: body.amendsInvoiceId ?? null,
      billDiscountReason: body.billDiscountReason ?? null,
      issuedAt: body.issuedAt,
      issuedBy: auth.userId,
    });

    const lineRows: InvoiceLineInsert[] = body.lines.map((l, index) => {
      const computed = totals.lines[index];
      if (!computed) throw new InternalError('Tax engine returned fewer lines than it was given.');
      const item = itemFor(l.itemId);
      const avgCost = l.itemId ? costs.get(l.itemId) : undefined;
      return {
        // Undefined, not zero, when the item has never been purchased
        // through the system: reports must show margin as unknown rather
        // than as total profit.
        cogsAmount: avgCost === undefined ? null : costOfGoodsSold(avgCost, l.quantity),
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
        // Which list priced the line, and whether the list or the item
        // decided it. Stored for the same reason cogsAmount is: a margin or
        // discount report must read what was true at the sale.
        priceListId: expectedPrices.get(l.id)?.priceListId ?? null,
        priceSource: expectedPrices.get(l.id)?.source ?? null,
        salesOrderLineId: l.salesOrderLineId ?? null,
      };
    });
    await invoicesRepository.insertLines(tx, body.id, body.outletId, body.documentDate, lineRows);
    if (body.salesOrderId) await applyFulfilment(tx, body.salesOrderId, fulfilments);

    const stockLines = body.lines.flatMap((l) => {
      const item = itemFor(l.itemId);
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
          referenceType: 'invoice',
          referenceId: body.id,
          occurredAt: body.issuedAt,
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
      // Stock promised to an open sales order that this sale has just taken. Not a
      // rejection (the sale happened); the shortfall is on the order, and shown there.
      const negative = new Set(
        (
          await stockRepository.findNegativeBalances(
            tx,
            body.outletId,
            stockLines.map((s) => s.itemId),
          )
        ).map((b) => b.itemId),
      );
      for (const shortfall of await stockRepository.findReservedShortfalls(
        tx,
        body.outletId,
        stockLines.map((s) => s.itemId),
      )) {
        if (!negative.has(shortfall.itemId)) {
          warnings.push({ code: WarningCode.RESERVED_STOCK, details: shortfall });
        }
      }

      // Keeps item_costs.quantity_on_hand in step with stock_balances. The
      // average itself does not move on a sale — only a purchase changes
      // what goods cost — but the quantity has to, or the next receipt
      // would blend against a stale pool.
      await purchasesRepository.adjustCostQuantity(
        tx,
        body.outletId,
        stockLines.map((s) => ({ itemId: s.itemId, quantityDelta: -s.quantity })),
      );
    }

    if (tenders.length > 0) {
      await paymentsRepository.insertTenders(tx, {
        outletId: body.outletId,
        customerId: customer?.id ?? null,
        receivedAt: body.issuedAt,
        receivedBy: auth.userId,
        tenders,
      });
      await paymentsRepository.insertAllocations(
        tx,
        tenders.map((t) => ({ paymentId: t.id, invoiceId: body.id, amount: t.amount })),
      );
    }
    // What the customer already paid on the order counts toward this invoice. The khata
    // already nets it (the advance was a credit), so this changes no ledger entry; it is
    // what makes the invoice show what it was really paid with.
    if (order) {
      await applyAdvanceToInvoice(tx, order, body.id, totals.grandTotal - paid);
    }

    if (customer) {
      const entries: NewLedgerEntry[] = [
        {
          customerId: customer.id,
          entryType: 'invoice',
          debit: totals.grandTotal,
          credit: 0,
          referenceType: 'invoice',
          referenceId: body.id,
          occurredAt: body.issuedAt,
          note: documentNumber,
          createdBy: auth.userId,
        },
        ...tenders.map((t): NewLedgerEntry => ({
          customerId: customer.id,
          entryType: 'payment',
          debit: 0,
          credit: t.amount,
          referenceType: 'payment',
          referenceId: t.id,
          occurredAt: body.issuedAt,
          note: documentNumber,
          createdBy: auth.userId,
        })),
      ];
      await customersRepository.insertLedgerEntries(
        tx,
        entries.filter((e) => e.debit > 0 || e.credit > 0),
      );
    }

    await numberingRepository.markConsumed(tx, block.id, body.sequenceNo);

    // Written after the header, so the foreign key holds and the approval can
    // never exist without the invoice it authorised.
    for (const { approval, role } of await resolveApprovers(tx, approvals, approverPermission)) {
      await discountsRepository.insertApproval(tx, {
        id: approval.id,
        outletId: body.outletId,
        invoiceId: body.id,
        invoiceLineId: approval.invoiceLineId ?? null,
        breachKind: approval.breachKind,
        requestedValue: approval.requestedValue,
        allowedValue: approval.allowedValue,
        requestedBy: auth.userId,
        approvedBy: approval.approvedBy,
        approverRole: role,
        reason: approval.reason ?? null,
        approvedAt: approval.approvedAt,
      });
    }

    // Sales are the events an owner most wants to see in the trail; auditing
    // only voids would leave the log unable to answer "who billed what".
    await recordAudit(tx, {
      action: 'invoice.issued',
      entityType: 'invoice',
      entityId: body.id,
      metadata: {
        documentNumber,
        grandTotal: totals.grandTotal,
        customerId: customer?.id ?? null,
        outletId: body.outletId,
      },
    });

    // A separate entry, and only when something was actually discounted. The
    // issued entry above carries no discount figures, which is why no
    // discount audit was possible before: the trail knew a sale happened but
    // not that margin had left with it.
    if (totals.totalDiscount > 0 || breaches.length > 0) {
      await recordAudit(tx, {
        action: 'invoice.discounted',
        entityType: 'invoice',
        entityId: body.id,
        metadata: {
          documentNumber,
          lineDiscountTotal: totals.totalLineDiscount,
          billDiscount: totals.billDiscount,
          totalDiscount: totals.totalDiscount,
          grandTotal: totals.grandTotal,
          breaches,
          approvedBy: approvals.map((approval) => approval.approvedBy),
          outletId: body.outletId,
        },
      });
    }

    return { invoice: await loadInvoice(tx, body.id), warnings, replayed: false };
  });

  if (!result.replayed) businessEvents.inc({ event: 'invoice.issued' });
  return result;
}

export function getInvoice(id: string) {
  return withReadTransaction(async (tx) => {
    const invoice = await loadInvoice(tx, id);
    assertOutletAccess(invoice.outletId);
    return invoice;
  });
}

export async function listInvoices(query: ListInvoicesQuery) {
  if (query.outletId) assertOutletAccess(query.outletId);
  const page = parsePage(query);
  const rows = await withReadTransaction((tx) =>
    invoicesRepository.list(
      tx,
      {
        from: query.from,
        to: query.to,
        status: query.status,
        customerId: query.customerId,
        outletId: query.outletId,
      },
      accessibleOutletIds(),
      page.limit,
      page.cursor,
    ),
  );
  return buildPage(rows, page.limit, (row) => ({ k: row.documentDate, id: row.id }));
}

/**
 * A void keeps the number (GST requires the series to account for it) and
 * writes reversing stock and khata entries rather than deleting anything.
 */
export async function voidInvoice(id: string, reason: string) {
  const auth = requireAuthContext();

  const { invoice, voided } = await withTransaction(async (tx) => {
    const header = await invoicesRepository.findHeader(tx, id, true);
    if (!header) throw new NotFoundError('Invoice');
    assertOutletAccess(header.outletId);
    if (header.status === 'void') return { invoice: await loadInvoice(tx, id), voided: false };

    if (await paymentsRepository.hasActiveReceiptAllocations(tx, id)) {
      throw new UnprocessableError('Void the receipts collected against this invoice first.');
    }
    // Returned goods were already put back into stock and credited, so voiding as well
    // would reverse them a second time. Void those credit notes first, or amend instead.
    if (await creditNotesRepository.hasIssuedForInvoice(tx, id)) {
      throw new UnprocessableError(
        'Credit notes have been issued against this invoice. Void them first.',
        ErrorCode.INVOICE_HAS_CREDIT_NOTES,
      );
    }

    await invoicesRepository.markVoid(tx, id, reason, auth.userId);
    // The order gets back what this invoice had fulfilled, so a void cannot
    // leave it closed against goods that were never billed.
    if (header.salesOrderId) {
      await reverseFulfilment(tx, header.salesOrderId, id);
    }
    await stockRepository.reverseEntries(tx, {
      referenceType: 'invoice',
      referenceId: id,
      entryType: 'sale',
      reversalType: 'sale_void',
      userId: auth.userId,
    });
    const voidedTenders = await paymentsRepository.voidTendersForInvoice(
      tx,
      id,
      reason,
      auth.userId,
    );

    if (header.customerId) {
      const customerId = header.customerId;
      const occurredAt = new Date().toISOString();
      const entries: NewLedgerEntry[] = [
        {
          customerId,
          entryType: 'invoice_void',
          debit: 0,
          credit: header.grandTotal,
          referenceType: 'invoice',
          referenceId: id,
          occurredAt,
          note: reason,
          createdBy: auth.userId,
        },
        ...voidedTenders.map((t): NewLedgerEntry => ({
          customerId,
          entryType: 'payment_void',
          debit: t.amount,
          credit: 0,
          referenceType: 'payment',
          referenceId: t.id,
          occurredAt,
          note: reason,
          createdBy: auth.userId,
        })),
      ];
      await customersRepository.insertLedgerEntries(
        tx,
        entries.filter((e) => e.debit > 0 || e.credit > 0),
      );
    }

    await recordAudit(tx, {
      action: 'invoice.voided',
      entityType: 'invoice',
      entityId: id,
      metadata: { reason, documentNumber: header.documentNumber },
    });
    return { invoice: await loadInvoice(tx, id), voided: true };
  });

  if (voided) businessEvents.inc({ event: 'invoice.voided' });
  return invoice;
}

export function markPrinted(id: string) {
  return withTransaction(async (tx) => {
    const header = await invoicesRepository.findHeader(tx, id, true);
    if (!header) throw new NotFoundError('Invoice');
    assertOutletAccess(header.outletId);
    await invoicesRepository.markPrinted(tx, id);
    return loadInvoice(tx, id);
  });
}
