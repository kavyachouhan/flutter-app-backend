/**
 * Credit notes: the only way to correct an issued invoice. A credit note is
 * itself an immutable document with its own numbering series. Issuing one
 * puts goods back into stock (unless damaged), credits the customer's khata,
 * and optionally pays money out as a refund; voiding it reverses all three.
 */
import { env } from '../../config/env.js';
import { withReadTransaction, withTransaction, type Tx } from '../../db/tx.js';
import { financialYearOf, formatDocumentNumber } from '../../domain/numbering/series.js';
import { computeInvoice } from '../../domain/tax/engine.js';
import { deriveReturnLine } from '../../domain/tax/returns.js';
import type { TaxMode } from '../../domain/tax/types.js';
import { requireAuthContext } from '../../lib/context.js';
import {
  ConflictError,
  ErrorCode,
  InternalError,
  NotFoundError,
  UnprocessableError,
  ValidationError,
} from '../../lib/errors.js';
import { buildPage, parsePage } from '../../lib/pagination.js';
import { accessibleOutletIds, assertOutletAccess } from '../../middleware/authorize.js';
import { businessEvents } from '../../observability/metrics.js';
import { recordAudit } from '../audit/audit.js';
import { customersRepository, type NewLedgerEntry } from '../customers/customers.repository.js';
import { assertFeature } from '../entitlements/entitlements.js';
import { invoicesRepository } from '../invoices/invoices.repository.js';
import { numberingRepository } from '../numbering/numbering.repository.js';
import { toSeriesFormat } from '../numbering/numbering.service.js';
import { outletsRepository } from '../outlets/outlets.repository.js';
import { paymentsRepository } from '../payments/payments.repository.js';
import { stockRepository } from '../stock/stock.repository.js';
import { tenantsRepository, type TenantSettings } from '../tenants/tenants.repository.js';
import {
  creditNotesRepository,
  type CreditNoteLineInsert,
  type SoldLineRow,
} from './credit-notes.repository.js';
import type { CreateCreditNoteBody, ListCreditNotesQuery } from './credit-notes.schemas.js';

function taxModeFor(settings: TenantSettings): TaxMode {
  if (!settings.isGstRegistered) return 'non_gst';
  return settings.isComposition ? 'composition' : 'gst';
}

async function loadCreditNote(tx: Tx, id: string) {
  const header = await creditNotesRepository.findHeader(tx, id);
  if (!header) throw new NotFoundError('Credit note');
  const lines = await creditNotesRepository.findLines(tx, id);
  const refund = await paymentsRepository.findRefundForCreditNote(tx, id);
  return { ...header, lines, refund: refund ?? null };
}

/** What a device needs to build a return screen for an invoice. */
export function listReturnable(invoiceId: string) {
  return withReadTransaction(async (tx) => {
    const header = await invoicesRepository.findHeader(tx, invoiceId);
    if (!header) throw new NotFoundError('Invoice');
    assertOutletAccess(header.outletId);
    const lines = await creditNotesRepository.soldLines(tx, invoiceId);
    return {
      invoiceId,
      documentNumber: header.documentNumber,
      status: header.status,
      returnable: header.status === 'issued',
      lines: lines.map((l) => ({
        invoiceLineId: l.id,
        lineNo: l.lineNo,
        itemId: l.itemId,
        itemName: l.itemName,
        unit: l.unit,
        unitPrice: l.unitPrice,
        soldQuantity: l.quantity,
        returnedQuantity: l.returnedQuantity,
        returnableQuantity: l.quantity - l.returnedQuantity,
      })),
    };
  });
}

export async function createCreditNote(body: CreateCreditNoteBody) {
  const auth = requireAuthContext();

  const result = await withTransaction(async (tx) => {
    if (await creditNotesRepository.exists(tx, body.id)) {
      return { creditNote: await loadCreditNote(tx, body.id), replayed: true };
    }
    await assertFeature(tx, 'credit_notes');

    const invoice = await invoicesRepository.findHeader(tx, body.originalInvoiceId, true);
    if (!invoice) throw new NotFoundError('Invoice');
    assertOutletAccess(invoice.outletId);
    if (invoice.status !== 'issued') {
      throw new UnprocessableError(
        'A void invoice cannot be returned against.',
        ErrorCode.INVOICE_NOT_RETURNABLE,
      );
    }

    const settings = await tenantsRepository.getSettings(tx);
    const outlet = await outletsRepository.findOutlet(tx, invoice.outletId);
    if (!outlet) throw new NotFoundError('Outlet');

    const series = await numberingRepository.findSeries(tx, body.seriesId);
    if (!series || series.outletId !== invoice.outletId || series.documentType !== 'credit_note') {
      throw new UnprocessableError('The series is not a credit-note series for this outlet.');
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

    // Locked: two returns of the same line at once must not both pass the quantity check.
    const sold = new Map(
      (await creditNotesRepository.soldLines(tx, invoice.id, true)).map((l) => [l.id, l]),
    );
    const requested = new Map<string, number>();
    for (const line of body.lines) {
      requested.set(line.invoiceLineId, (requested.get(line.invoiceLineId) ?? 0) + line.quantity);
    }
    for (const [invoiceLineId, qty] of requested) {
      const line = sold.get(invoiceLineId);
      if (!line) {
        throw new ValidationError('A returned line does not belong to this invoice.', {
          details: { invoiceLineId },
        });
      }
      const remaining = line.quantity - line.returnedQuantity;
      if (qty > remaining) {
        throw new UnprocessableError(
          'The return exceeds what is left to return on the invoice line.',
          ErrorCode.RETURN_EXCEEDS_INVOICE,
          { details: { invoiceLineId, remaining, requested: qty } },
        );
      }
    }

    const customer = invoice.customerId
      ? await customersRepository.find(tx, invoice.customerId, true)
      : undefined;

    const taxInput = body.lines.map((line) =>
      deriveReturnLine(sold.get(line.invoiceLineId) as SoldLineRow, line),
    );
    const totals = computeInvoice(
      {
        mode: invoice['taxMode'] as TaxMode,
        supplierStateCode: invoice['supplierStateCode'] as string,
        placeOfSupplyStateCode: (invoice['placeOfSupplyStateCode'] as string | null) ?? undefined,
        pricesIncludeTax: invoice['pricesIncludeTax'] as boolean,
        roundOff: invoice['roundOffEnabled'] as boolean,
        lines: taxInput,
      },
      { allowedGstRates: env.GST_ALLOWED_RATES },
    );
    void taxModeFor;

    if (body.expectedTotals) {
      const server = {
        grandTotal: totals.grandTotal,
        totalTax: totals.totalTax,
        taxableAmount: totals.taxableAmount,
      };
      const e = body.expectedTotals;
      if (
        e.grandTotal !== server.grandTotal ||
        e.totalTax !== server.totalTax ||
        e.taxableAmount !== server.taxableAmount
      ) {
        throw new ConflictError(
          'Credit note totals do not match the server calculation.',
          ErrorCode.TOTALS_MISMATCH,
          { details: { client: e, server } },
        );
      }
    }

    const refundAmount = body.refundAmount ?? totals.grandTotal;
    if (refundAmount > totals.grandTotal) {
      throw new ValidationError('The refund cannot exceed the credit note total.');
    }
    const paysOut = body.refundMode !== 'khata';
    if (!customer && (!paysOut || refundAmount !== totals.grandTotal)) {
      // A walk-in customer has no khata to carry a balance on.
      throw new UnprocessableError(
        'A return without a customer must be refunded in full.',
        ErrorCode.REFUND_REQUIRES_CUSTOMER,
      );
    }

    const documentNumber = formatDocumentNumber(
      toSeriesFormat(series),
      fy,
      body.sequenceNo,
      env.DOCUMENT_NUMBER_MAX_LENGTH,
    );
    const restock = body.restock ?? body.reasonCode !== 'damaged';

    await creditNotesRepository.insertHeader(tx, {
      id: body.id,
      outletId: invoice.outletId,
      counterId: series.counterId,
      deviceId: auth.deviceId,
      seriesId: series.id,
      sequenceNo: body.sequenceNo,
      documentNumber,
      documentDate: body.documentDate,
      fyStartYear: fy.startYear,
      originalInvoiceId: invoice.id,
      originalDocumentNumber: invoice.documentNumber,
      customerId: customer?.id ?? null,
      customerName: (invoice.customerName as string | null) ?? null,
      customerGstin: (invoice['customerGstin'] as string | null) ?? null,
      supplierGstin: (invoice['supplierGstin'] as string | null) ?? null,
      supplierStateCode: invoice['supplierStateCode'] as string,
      placeOfSupplyStateCode: (invoice['placeOfSupplyStateCode'] as string | null) ?? null,
      pricesIncludeTax: invoice['pricesIncludeTax'] as boolean,
      roundOffEnabled: invoice['roundOffEnabled'] as boolean,
      totals,
      reasonCode: body.reasonCode,
      refundMode: body.refundMode,
      refundAmount: paysOut ? refundAmount : 0,
      restock,
      customFields: body.customFields ?? null,
      notes: body.notes ?? null,
      issuedAt: body.issuedAt,
      issuedBy: auth.userId,
    });

    const lineRows: CreditNoteLineInsert[] = body.lines.map((line, index) => {
      const computed = totals.lines[index];
      const original = sold.get(line.invoiceLineId);
      if (!computed || !original) throw new InternalError('Return line resolution failed.');
      return {
        id: line.id,
        invoiceLineId: line.invoiceLineId,
        lineNo: index + 1,
        itemId: original.itemId,
        itemName: original.itemName,
        hsnCode: computed.hsnCode ?? null,
        unit: original.unit,
        quantity: line.quantity,
        unitPrice: original.unitPrice,
        discount: taxInput[index]?.discount ?? null,
        grossAmount: computed.grossAmount,
        lineDiscount: computed.lineDiscount,
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
    await creditNotesRepository.insertLines(
      tx,
      body.id,
      invoice.outletId,
      body.documentDate,
      lineRows,
    );

    if (restock) {
      const stockLines = body.lines.flatMap((line) => {
        const original = sold.get(line.invoiceLineId);
        return original?.trackStock && original.itemId
          ? [{ itemId: original.itemId, quantity: line.quantity }]
          : [];
      });
      await stockRepository.insertEntries(
        tx,
        stockLines.map((s) => ({
          id: null,
          outletId: invoice.outletId,
          itemId: s.itemId,
          entryType: 'sale_return',
          quantityDelta: s.quantity,
          reasonCode: null,
          referenceType: 'credit_note',
          referenceId: body.id,
          occurredAt: body.issuedAt,
          note: null,
          createdBy: auth.userId,
        })),
      );
    }

    if (paysOut && refundAmount > 0) {
      await paymentsRepository.insertRefund(tx, {
        id: body.refundPaymentId ?? body.id,
        outletId: invoice.outletId,
        customerId: customer?.id ?? null,
        creditNoteId: body.id,
        mode: body.refundMode,
        amount: refundAmount,
        receivedAt: body.issuedAt,
        receivedBy: auth.userId,
      });
    }

    if (customer) {
      const entries: NewLedgerEntry[] = [
        {
          customerId: customer.id,
          entryType: 'credit_note',
          debit: 0,
          credit: totals.grandTotal,
          referenceType: 'credit_note',
          referenceId: body.id,
          occurredAt: body.issuedAt,
          note: documentNumber,
          createdBy: auth.userId,
        },
      ];
      if (paysOut && refundAmount > 0) {
        entries.push({
          customerId: customer.id,
          entryType: 'refund',
          debit: refundAmount,
          credit: 0,
          referenceType: 'payment',
          referenceId: body.refundPaymentId ?? body.id,
          occurredAt: body.issuedAt,
          note: documentNumber,
          createdBy: auth.userId,
        });
      }
      await customersRepository.insertLedgerEntries(tx, entries);
    }

    await numberingRepository.markConsumed(tx, block.id, body.sequenceNo);
    await recordAudit(tx, {
      action: 'credit_note.issued',
      entityType: 'credit_note',
      entityId: body.id,
      metadata: {
        documentNumber,
        originalInvoiceId: invoice.id,
        grandTotal: totals.grandTotal,
        refundMode: body.refundMode,
        refundAmount: paysOut ? refundAmount : 0,
        reasonCode: body.reasonCode,
      },
    });

    return { creditNote: await loadCreditNote(tx, body.id), replayed: false };
  });

  if (!result.replayed) businessEvents.inc({ event: 'credit_note.issued' });
  return result;
}

export function getCreditNote(id: string) {
  return withReadTransaction(async (tx) => {
    const note = await loadCreditNote(tx, id);
    assertOutletAccess(note.outletId);
    return note;
  });
}

export async function listCreditNotes(query: ListCreditNotesQuery) {
  if (query.outletId) assertOutletAccess(query.outletId);
  const page = parsePage(query);
  const rows = await withReadTransaction((tx) =>
    creditNotesRepository.list(
      tx,
      {
        from: query.from,
        to: query.to,
        status: query.status,
        customerId: query.customerId,
        outletId: query.outletId,
        originalInvoiceId: query.originalInvoiceId,
      },
      accessibleOutletIds(),
      page.limit,
      page.cursor,
    ),
  );
  return buildPage(rows, page.limit, (row) => ({ k: row.documentDate, id: row.id }));
}

export async function voidCreditNote(id: string, reason: string) {
  const auth = requireAuthContext();

  const { note, voided } = await withTransaction(async (tx) => {
    const header = await creditNotesRepository.findHeader(tx, id, true);
    if (!header) throw new NotFoundError('Credit note');
    assertOutletAccess(header.outletId);
    if (header.status === 'void') return { note: await loadCreditNote(tx, id), voided: false };

    await creditNotesRepository.markVoid(tx, id, reason, auth.userId);
    if (header.restock) {
      await stockRepository.reverseEntries(tx, {
        referenceType: 'credit_note',
        referenceId: id,
        entryType: 'sale_return',
        reversalType: 'sale_return_void',
        userId: auth.userId,
      });
    }
    const refund = await paymentsRepository.voidRefundForCreditNote(tx, id, reason, auth.userId);

    if (header.customerId) {
      const occurredAt = new Date().toISOString();
      const entries: NewLedgerEntry[] = [
        {
          customerId: header.customerId,
          entryType: 'credit_note_void',
          debit: header.grandTotal,
          credit: 0,
          referenceType: 'credit_note',
          referenceId: id,
          occurredAt,
          note: reason,
          createdBy: auth.userId,
        },
      ];
      if (refund) {
        entries.push({
          customerId: header.customerId,
          entryType: 'refund_void',
          debit: 0,
          credit: refund.amount,
          referenceType: 'payment',
          referenceId: refund.id,
          occurredAt,
          note: reason,
          createdBy: auth.userId,
        });
      }
      await customersRepository.insertLedgerEntries(tx, entries);
    }

    await recordAudit(tx, {
      action: 'credit_note.voided',
      entityType: 'credit_note',
      entityId: id,
      metadata: { reason, documentNumber: header.documentNumber },
    });
    return { note: await loadCreditNote(tx, id), voided: true };
  });

  if (voided) businessEvents.inc({ event: 'credit_note.voided' });
  return note;
}

export function markPrinted(id: string) {
  return withTransaction(async (tx) => {
    const header = await creditNotesRepository.findHeader(tx, id, true);
    if (!header) throw new NotFoundError('Credit note');
    assertOutletAccess(header.outletId);
    await creditNotesRepository.markPrinted(tx, id);
    return loadCreditNote(tx, id);
  });
}
