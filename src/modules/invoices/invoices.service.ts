import { env } from '../../config/env.js';
import { withReadTransaction, withTransaction, type Tx } from '../../db/tx.js';
import { financialYearOf, formatDocumentNumber } from '../../domain/numbering/series.js';
import { computeInvoice } from '../../domain/tax/engine.js';
import type { TaxMode } from '../../domain/tax/types.js';
import { requireAuthContext } from '../../lib/context.js';
import {
  ConflictError,
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
import { stockRepository } from '../stock/stock.repository.js';
import { tenantsRepository, type TenantSettings } from '../tenants/tenants.repository.js';
import { invoicesRepository, type InvoiceLineInsert } from './invoices.repository.js';
import type { CreateInvoiceBody, ListInvoicesQuery } from './invoices.schemas.js';

export interface Warning {
  code: WarningCodeValue;
  details: Record<string, unknown>;
}

function taxModeFor(settings: TenantSettings): TaxMode {
  if (!settings.isGstRegistered) return 'non_gst';
  return settings.isComposition ? 'composition' : 'gst';
}

async function loadInvoice(tx: Tx, id: string) {
  const header = await invoicesRepository.findHeader(tx, id);
  if (!header) throw new NotFoundError('Invoice');
  const lines = await invoicesRepository.findLines(tx, id);
  const payments = await paymentsRepository.findForInvoice(tx, id);
  return { ...header, outstanding: header.grandTotal - header.amountPaid, lines, payments };
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
    const itemIds = [...new Set(body.lines.flatMap((l) => (l.itemId ? [l.itemId] : [])))];
    const items = new Map(
      (await invoicesRepository.findItems(tx, itemIds)).map((item) => [item.id, item]),
    );
    const unknown = itemIds.filter((id) => !items.has(id));
    if (unknown.length > 0)
      throw new ValidationError('Unknown items on the invoice.', { details: { itemIds: unknown } });

    const itemFor = (itemId: string | null | undefined) => (itemId ? items.get(itemId) : undefined);

    const totals = computeInvoice(
      {
        mode: taxModeFor(settings),
        supplierStateCode: outlet.stateCode ?? settings.stateCode,
        placeOfSupplyStateCode: body.placeOfSupplyStateCode ?? customer?.stateCode ?? undefined,
        pricesIncludeTax: body.pricesIncludeTax,
        roundOff: body.roundOff,
        billDiscount: body.billDiscount,
        additionalCharges: body.additionalCharges,
        lines: body.lines.map((l) => ({
          id: l.id,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          taxRatePercent: l.taxRatePercent,
          cessRatePercent: l.cessRatePercent,
          discount: l.discount,
          hsnCode: l.hsnCode ?? itemFor(l.itemId)?.hsnCode ?? undefined,
        })),
      },
      { allowedGstRates: env.GST_ALLOWED_RATES },
    );

    // Both sides run the same engine, so a mismatch is a client bug or a
    // tampered payload; silently storing either figure would be wrong.
    const serverTotals = {
      grandTotal: totals.grandTotal,
      totalTax: totals.totalTax,
      taxableAmount: totals.taxableAmount,
    };
    const expected = body.expectedTotals;
    if (
      expected.grandTotal !== serverTotals.grandTotal ||
      expected.totalTax !== serverTotals.totalTax ||
      expected.taxableAmount !== serverTotals.taxableAmount
    ) {
      throw new ConflictError(
        'Invoice totals do not match the server calculation.',
        ErrorCode.TOTALS_MISMATCH,
        {
          details: { client: expected, server: serverTotals },
        },
      );
    }

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

    const documentNumber = formatDocumentNumber(
      toSeriesFormat(series),
      fy,
      body.sequenceNo,
      env.DOCUMENT_NUMBER_MAX_LENGTH,
    );

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
      customFields: body.customFields ?? null,
      issuedAt: body.issuedAt,
      issuedBy: auth.userId,
    });

    // The moving average in force right now, snapshotted onto each line
    // below. Margin then reads a historical fact instead of being recomputed
    // against whatever the item costs today — which is the bug that made
    // Daily P&L restate itself every time a buying price moved.
    const costs = await purchasesRepository.costsFor(
      tx,
      body.outletId,
      body.lines.flatMap((l) => (l.itemId ? [l.itemId] : [])),
    );

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
      };
    });
    await invoicesRepository.insertLines(tx, body.id, body.outletId, body.documentDate, lineRows);

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

    await invoicesRepository.markVoid(tx, id, reason, auth.userId);
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
