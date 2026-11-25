/**
 * Credit notes: the only way to correct an issued invoice. A credit note is
 * itself an immutable document with its own numbering series. Issuing one
 * puts goods back into stock (unless damaged), credits the customer's khata,
 * and optionally pays money out as a refund; voiding it reverses all three.
 */
import { env } from '../../config/env.js';
import { withReadTransaction, withTransaction, type Tx } from '../../db/tx.js';
import { financialYearOf, formatDocumentNumber } from '../../domain/numbering/series.js';
import { adjustmentLine, creditNoteLastDate, voidRefusal } from '../../domain/gst/corrections.js';
import { computeInvoice } from '../../domain/tax/engine.js';
import { taxPayableByFor } from '../../domain/tax/types.js';
import { deriveReturnLine } from '../../domain/tax/returns.js';
import type { SupplyType, TaxMode } from '../../domain/tax/types.js';
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
import { gstr1FiledFor } from '../gst/filing-state.js';
import { invoicesRepository } from '../invoices/invoices.repository.js';
import { numberingRepository } from '../numbering/numbering.repository.js';
import { toSeriesFormat } from '../numbering/numbering.service.js';
import { outletsRepository } from '../outlets/outlets.repository.js';
import { paymentsRepository } from '../payments/payments.repository.js';
import { validateCustomFields } from '../print/custom-fields.js';
import {
  reapplyFulfilmentForCreditNote,
  reverseFulfilmentForCreditNote,
} from '../sales-orders/sales-orders.service.js';
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
        taxableAmount: l.taxableAmount,
        creditableValue: Math.max(0, l.taxableAmount - l.creditedTaxable),
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

    // s.34(2): past this a GST credit note no longer reduces tax; a financial one still can.
    const invoiceDate = String(invoice.documentDate).slice(0, 10);
    if ((invoice['taxMode'] as TaxMode) === 'gst' && body.documentDate > creditNoteLastDate(invoiceDate)) {
      throw new UnprocessableError(
        'The time for a GST credit note against this invoice has passed. Issue a financial credit note instead.',
        ErrorCode.CREDIT_NOTE_TIME_BARRED,
        { details: { lastDate: creditNoteLastDate(invoiceDate) } },
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
      requested.set(line.invoiceLineId, (requested.get(line.invoiceLineId) ?? 0) + (line.quantity ?? 0));
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

    // Same guard as the invoice path: a credit note is equally immutable, so
    // the bag has to be right before it is written.
    await validateCustomFields(tx, 'credit_note', body.customFields);

    const lineFor = (invoiceLineId: string): SoldLineRow => {
      const line = sold.get(invoiceLineId);
      if (!line) throw new UnprocessableError('That line does not belong to this invoice.');
      return line;
    };
    const taxInput = body.lines.map((line) => {
      const original = lineFor(line.invoiceLineId);
      if (line.quantity !== undefined) {
        return deriveReturnLine(original, { id: line.id, invoiceLineId: line.invoiceLineId, quantity: line.quantity });
      }
      return adjustmentLine(
        {
          taxRatePercent: Number(original.taxRatePercent),
          cessRatePercent: Number(original.cessRatePercent),
          supplyCategory: original.supplyCategory,
          hsnCode: original.hsnCode,
          remainingTaxable: original.taxableAmount - original.creditedTaxable,
        },
        { id: line.id, amount: line.valueAmount ?? 0, differentialRatePercent: line.differentialRatePercent ?? null },
      );
    });
    const returnsGoods = body.lines.some((line) => line.quantity !== undefined);
    const correctionReason =
      body.correctionReason ??
      (returnsGoods ? 'goods_return' : body.lines.some((l) => l.differentialRatePercent !== undefined) ? 'excess_tax_charged' : 'value_reduction');
    if (correctionReason === 'value_increase' || correctionReason === 'tax_undercharged') {
      throw new ValidationError('An increase is a sales debit note, not a credit note.');
    }
    // s.15(3)(b), s.34(1) as amended: on a discount, a registered buyer must reverse the credit.
    const buyerRegistered = ['registered_regular', 'registered_composition', 'sez_unit', 'sez_developer'].includes(
      (invoice['buyerGstTreatment'] as string | null) ?? '',
    );
    const recipientItcReversalStatus = correctionReason === 'post_supply_discount' && buyerRegistered ? 'pending' : null;
    const totals = computeInvoice(
      {
        mode: invoice['taxMode'] as TaxMode,
        supplierStateCode: invoice['supplierStateCode'] as string,
        placeOfSupplyStateCode: (invoice['placeOfSupplyStateCode'] as string | null) ?? undefined,
        // Carried over from the invoice, not re-derived. A credit note against
        // an export is itself an export credit note, and one against a
        // reverse-charge supply carries no tax for the same reason the invoice
        // did not — GSTR-1 reports the pair together.
        supplyType: invoice['supplyType'] as SupplyType,
        taxPayableBy: taxPayableByFor(invoice['isReverseCharge'] as boolean),
        pricesIncludeTax: invoice['pricesIncludeTax'] as boolean,
        roundOff: invoice['roundOffEnabled'] as boolean,
        lines: taxInput,
      },
      {
        // A rate correction taxes at the difference between two slabs, which need not be a slab.
        allowedGstRates: new Set<number>([
          ...env.GST_ALLOWED_RATES,
          ...body.lines.flatMap((l) => (l.differentialRatePercent === undefined ? [] : [l.differentialRatePercent])),
        ]),
      },
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
    // Nothing comes back on a value-only note, so nothing goes on the shelf.
    const restock = returnsGoods && (body.restock ?? body.reasonCode !== 'damaged');

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
      customerName: invoice.customerName,
      correctionReason,
      recipientItcReversalStatus,
      supply: {
        scenario: (invoice['supplyScenario'] as string | null) ?? null,
        provision: (invoice['posProvision'] as string | null) ?? null,
        override: invoice['posOverride'] ?? null,
        sezAuthorisedOperations: (invoice['sezAuthorisedOperations'] as boolean | null) ?? null,
        lutReference: (invoice['lutReference'] as string | null) ?? null,
        buyerGstTreatment: (invoice['buyerGstTreatment'] as string | null) ?? null,
        customerUin: (invoice['customerUin'] as string | null) ?? null,
        seller: invoice['sellerSnapshot'] ?? null,
        buyer: invoice['buyerSnapshot'] ?? null,
        shipTo: invoice['shipToSnapshot'] ?? null,
        dispatchFrom: invoice['dispatchFromSnapshot'] ?? null,
      },
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
        adjustmentKind:
          line.quantity !== undefined ? 'quantity' : line.differentialRatePercent !== undefined ? 'tax' : 'value',
        id: line.id,
        invoiceLineId: line.invoiceLineId,
        lineNo: index + 1,
        itemId: original.itemId,
        itemName: original.itemName,
        hsnCode: computed.hsnCode ?? null,
        unit: original.unit,
        quantity: line.quantity ?? 0,
        unitPrice: line.quantity !== undefined ? original.unitPrice : (line.valueAmount ?? 0),
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
        supplyCategory: computed.supplyCategory,
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
        return original?.trackStock && original.itemId && line.quantity !== undefined
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

    // Goods taken back from an invoice that fulfilled a sales order are owed to the
    // customer again, so the order re-opens for them.
    if (invoice.salesOrderId) {
      await reverseFulfilmentForCreditNote(tx, invoice.salesOrderId, body.id);
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

    const refusal = voidRefusal({
      gstr1Filed: await gstr1FiledFor(tx, (header['supplierGstin'] as string | null) ?? null, String(header['documentDate']).slice(0, 10)),
      einvoiced: header['irnState'] === 'registered',
      withinIrpCancelWindow: false,
    });
    if (refusal) {
      throw new UnprocessableError('This credit note has been reported and can no longer be cancelled.', ErrorCode.CORRECTION_NOT_ALLOWED, {
        details: { reason: refusal },
      });
    }

    await creditNotesRepository.markVoid(tx, id, reason, auth.userId);
    // The return never happened, so what it handed back counts as delivered again.
    const original = await invoicesRepository.findHeader(tx, header.originalInvoiceId);
    if (original?.salesOrderId) {
      await reapplyFulfilmentForCreditNote(tx, original.salesOrderId, id);
    }
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

/** Records what the buyer has done about the credit, once the seller knows (D27). */
export function setRecipientReversal(id: string, status: string) {
  return withTransaction(async (tx) => {
    const header = await creditNotesRepository.findHeader(tx, id, true);
    if (!header) throw new NotFoundError('Credit note');
    assertOutletAccess(header.outletId);
    await creditNotesRepository.setRecipientReversal(tx, id, status);
    await recordAudit(tx, {
      action: 'credit_note.recipient_reversal_set',
      entityType: 'credit_note',
      entityId: id,
      metadata: { status },
    });
    return loadCreditNote(tx, id);
  });
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
