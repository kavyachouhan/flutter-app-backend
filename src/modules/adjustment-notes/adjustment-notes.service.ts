/**
 * The notes that move money on the khata with no goods moving (D10, D27): the sales debit note,
 * which adds value or tax to an issued invoice under s.34(3), and the financial credit note, a
 * commercial credit that carries no tax and never reaches a return. Each is immutable, in its own
 * series, and voiding it reverses the khata entry.
 */
import { env } from '../../config/env.js';
import { withReadTransaction, withTransaction, type Tx } from '../../db/tx.js';
import { adjustmentLine, voidRefusal } from '../../domain/gst/corrections.js';
import { financialYearOf, formatDocumentNumber } from '../../domain/numbering/series.js';
import { computeInvoice } from '../../domain/tax/engine.js';
import { taxPayableByFor, type SupplyType, type TaxMode } from '../../domain/tax/types.js';
import { requireAuthContext } from '../../lib/context.js';
import { ConflictError, ErrorCode, InternalError, NotFoundError, UnprocessableError } from '../../lib/errors.js';
import { buildPage, parsePage } from '../../lib/pagination.js';
import { accessibleOutletIds, assertOutletAccess } from '../../middleware/authorize.js';
import { recordAudit } from '../audit/audit.js';
import { creditNotesRepository } from '../credit-notes/credit-notes.repository.js';
import { customersRepository } from '../customers/customers.repository.js';
import { assertFeature } from '../entitlements/entitlements.js';
import { customerSnapshot, sellerSnapshot } from '../invoices/invoice-supply.js';
import { invoicesRepository } from '../invoices/invoices.repository.js';
import { gstr1FiledFor } from '../gst/filing-state.js';
import { numberingRepository } from '../numbering/numbering.repository.js';
import { toSeriesFormat } from '../numbering/numbering.service.js';
import { outletsRepository } from '../outlets/outlets.repository.js';
import { taxModeFor } from '../sales-docs/prepare.js';
import { tenantsRepository } from '../tenants/tenants.repository.js';
import { adjustmentNotesRepository as repo } from './adjustment-notes.repository.js';
import type {
  CreateFinancialCreditNoteBody,
  CreateSalesDebitNoteBody,
  ListNotesQuery,
} from './adjustment-notes.schemas.js';

/** The number this device was leased, with the checks every issued document makes. */
async function issueNumber(
  tx: Tx,
  input: {
    readonly seriesId: string;
    readonly outletId: string;
    readonly documentType: 'sales_debit_note' | 'financial_credit_note';
    readonly documentDate: string;
    readonly sequenceNo: number;
  },
) {
  const auth = requireAuthContext();
  const settings = await tenantsRepository.getSettings(tx);
  const series = await numberingRepository.findSeries(tx, input.seriesId);
  if (!series || series.outletId !== input.outletId || series.documentType !== input.documentType) {
    throw new UnprocessableError(`The series is not a ${input.documentType.replaceAll('_', ' ')} series for this outlet.`);
  }
  const fy = financialYearOf(input.documentDate, settings.fyStartMonth);
  if (fy.startYear !== series.fyStartYear) {
    throw new UnprocessableError('The document date falls outside the series financial year.');
  }
  const block = await numberingRepository.lockBlockForSequence(tx, series.id, auth.deviceId, input.sequenceNo);
  if (!block) {
    throw new UnprocessableError(`Sequence ${input.sequenceNo} is not leased to this device.`, ErrorCode.NUMBER_NOT_LEASED);
  }
  return {
    settings,
    series,
    fy,
    block,
    documentNumber: formatDocumentNumber(toSeriesFormat(series), fy, input.sequenceNo, env.DOCUMENT_NUMBER_MAX_LENGTH),
  };
}

async function loadDebitNote(tx: Tx, id: string) {
  const header = await repo.findDebitNote(tx, id);
  if (!header) throw new NotFoundError('Debit note');
  return { ...header, lines: await repo.findDebitNoteLines(tx, id) };
}

export async function createSalesDebitNote(body: CreateSalesDebitNoteBody) {
  const auth = requireAuthContext();
  return withTransaction(async (tx) => {
    if (await repo.debitNoteExists(tx, body.id)) return { debitNote: await loadDebitNote(tx, body.id), replayed: true };
    await assertFeature(tx, 'credit_notes');

    const invoice = await invoicesRepository.findHeader(tx, body.originalInvoiceId, true);
    if (!invoice) throw new NotFoundError('Invoice');
    assertOutletAccess(invoice.outletId);
    if (invoice.status !== 'issued') {
      throw new UnprocessableError('A void invoice cannot be adjusted.', ErrorCode.INVOICE_NOT_RETURNABLE);
    }
    if (!invoice.customerId) {
      throw new UnprocessableError(
        'A debit note adds to what the customer owes, so the bill needs a saved customer.',
        ErrorCode.CORRECTION_NOT_ALLOWED,
      );
    }

    const number = await issueNumber(tx, {
      seriesId: body.seriesId,
      outletId: invoice.outletId,
      documentType: 'sales_debit_note',
      documentDate: body.documentDate,
      sequenceNo: body.sequenceNo,
    });

    const sold = new Map((await creditNotesRepository.soldLines(tx, invoice.id, true)).map((l) => [l.id, l]));
    const taxLines = body.lines.map((line) => {
      const original = sold.get(line.invoiceLineId);
      if (!original) throw new UnprocessableError('That line does not belong to this invoice.');
      return adjustmentLine(
        {
          taxRatePercent: Number(original.taxRatePercent),
          cessRatePercent: Number(original.cessRatePercent),
          supplyCategory: original.supplyCategory,
          hsnCode: original.hsnCode,
          // A debit note adds value, so nothing caps it the way a credit is capped.
          remainingTaxable: null,
        },
        { id: line.id, amount: line.amount, differentialRatePercent: line.differentialRatePercent ?? null },
      );
    });

    // A rate correction taxes at the difference between two slabs, which need not be a slab.
    const totals = computeInvoice(
      {
        mode: invoice['taxMode'] as TaxMode,
        supplierStateCode: invoice['supplierStateCode'] as string,
        placeOfSupplyStateCode: (invoice['placeOfSupplyStateCode'] as string | null) ?? undefined,
        supplyType: invoice['supplyType'] as SupplyType,
        taxPayableBy: taxPayableByFor(invoice['isReverseCharge'] as boolean),
        pricesIncludeTax: false,
        roundOff: invoice['roundOffEnabled'] as boolean,
        lines: taxLines,
      },
      {
        allowedGstRates: new Set<number>([
          ...env.GST_ALLOWED_RATES,
          ...body.lines.flatMap((l) => (l.differentialRatePercent === undefined ? [] : [l.differentialRatePercent])),
        ]),
      },
    );

    const e = body.expectedTotals;
    if (e && (e.grandTotal !== totals.grandTotal || e.totalTax !== totals.totalTax || e.taxableAmount !== totals.taxableAmount)) {
      throw new ConflictError('Debit note totals do not match the server calculation.', ErrorCode.TOTALS_MISMATCH, {
        details: { client: e, server: { grandTotal: totals.grandTotal, totalTax: totals.totalTax, taxableAmount: totals.taxableAmount } },
      });
    }

    await repo.insertDebitNote(tx, {
      id: body.id,
      series: number.series,
      deviceId: auth.deviceId,
      sequenceNo: body.sequenceNo,
      documentNumber: number.documentNumber,
      documentDate: body.documentDate,
      fyStartYear: number.fy.startYear,
      invoice,
      correctionReason: body.correctionReason,
      totals,
      notes: body.notes ?? null,
      issuedAt: body.issuedAt,
      issuedBy: auth.userId,
    });
    await repo.insertDebitNoteLines(
      tx,
      body.id,
      invoice.outletId,
      body.documentDate,
      body.lines.map((line, index) => {
        const computed = totals.lines[index];
        const original = sold.get(line.invoiceLineId);
        if (!computed || !original) throw new InternalError('Debit note line resolution failed.');
        return {
          id: line.id,
          invoiceLineId: line.invoiceLineId,
          lineNo: index + 1,
          itemId: original.itemId,
          itemName: original.itemName,
          hsnCode: computed.hsnCode ?? null,
          unit: original.unit,
          adjustmentKind: line.differentialRatePercent === undefined ? 'value' : 'tax',
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
      }),
    );

    await customersRepository.insertLedgerEntries(tx, [
      {
        customerId: invoice.customerId,
        entryType: 'sales_debit_note',
        debit: totals.grandTotal,
        credit: 0,
        referenceType: 'sales_debit_note',
        referenceId: body.id,
        occurredAt: body.issuedAt,
        note: number.documentNumber,
        createdBy: auth.userId,
      },
    ]);
    await numberingRepository.markConsumed(tx, number.block.id, body.sequenceNo);
    await recordAudit(tx, {
      action: 'sales_debit_note.issued',
      entityType: 'sales_debit_note',
      entityId: body.id,
      metadata: {
        documentNumber: number.documentNumber,
        originalInvoiceId: invoice.id,
        grandTotal: totals.grandTotal,
        correctionReason: body.correctionReason,
      },
    });
    return { debitNote: await loadDebitNote(tx, body.id), replayed: false };
  });
}

export function getSalesDebitNote(id: string) {
  return withReadTransaction(async (tx) => {
    const note = await loadDebitNote(tx, id);
    assertOutletAccess(note.outletId);
    return note;
  });
}

export async function listSalesDebitNotes(query: ListNotesQuery) {
  const page = parsePage(query);
  const rows = await withReadTransaction((tx) => repo.listDebitNotes(tx, query, accessibleOutletIds(), page.limit, page.cursor));
  return buildPage(rows, page.limit, (row) => ({ k: row.documentDate, id: row.id }));
}

export function voidSalesDebitNote(id: string, reason: string) {
  const auth = requireAuthContext();
  return withTransaction(async (tx) => {
    const note = await repo.findDebitNote(tx, id, true);
    if (!note) throw new NotFoundError('Debit note');
    assertOutletAccess(note.outletId);
    if (note.status === 'void') return loadDebitNote(tx, id);

    const refusal = voidRefusal({
      gstr1Filed: await gstr1FiledFor(tx, note.supplierGstin, note.documentDate),
      einvoiced: note.irnState === 'registered',
      withinIrpCancelWindow: false,
    });
    if (refusal) {
      throw new UnprocessableError('This debit note has been reported and can no longer be cancelled.', ErrorCode.CORRECTION_NOT_ALLOWED, {
        details: { reason: refusal },
      });
    }

    await repo.markDebitNoteVoid(tx, id, reason, auth.userId);
    await customersRepository.insertLedgerEntries(tx, [
      {
        customerId: note.customerId,
        entryType: 'sales_debit_note_void',
        debit: 0,
        credit: note.grandTotal,
        referenceType: 'sales_debit_note',
        referenceId: id,
        occurredAt: new Date().toISOString(),
        note: reason,
        createdBy: auth.userId,
      },
    ]);
    await recordAudit(tx, {
      action: 'sales_debit_note.voided',
      entityType: 'sales_debit_note',
      entityId: id,
      metadata: { reason, documentNumber: note.documentNumber },
    });
    return loadDebitNote(tx, id);
  });
}

export function createFinancialCreditNote(body: CreateFinancialCreditNoteBody) {
  const auth = requireAuthContext();
  assertOutletAccess(body.outletId);
  return withTransaction(async (tx) => {
    const existing = await repo.findFinancialNote(tx, body.id);
    if (existing) return { creditNote: existing, replayed: true };
    await assertFeature(tx, 'credit_notes');

    const customer = await customersRepository.find(tx, body.customerId, true);
    if (!customer) throw new NotFoundError('Customer');
    const invoice = body.originalInvoiceId ? await invoicesRepository.findHeader(tx, body.originalInvoiceId) : undefined;
    if (body.originalInvoiceId && !invoice) throw new NotFoundError('Invoice');

    const number = await issueNumber(tx, {
      seriesId: body.seriesId,
      outletId: body.outletId,
      documentType: 'financial_credit_note',
      documentDate: body.documentDate,
      sequenceNo: body.sequenceNo,
    });
    const [tenant, outlet] = await Promise.all([tenantsRepository.findCurrent(tx), outletsRepository.findOutlet(tx, body.outletId)]);
    if (!tenant) throw new NotFoundError('Tenant');
    if (!outlet) throw new NotFoundError('Outlet');

    await repo.insertFinancialNote(tx, {
      id: body.id,
      outletId: body.outletId,
      deviceId: auth.deviceId,
      seriesId: number.series.id,
      sequenceNo: body.sequenceNo,
      documentNumber: number.documentNumber,
      documentDate: body.documentDate,
      fyStartYear: number.fy.startYear,
      originalInvoiceId: invoice?.id ?? null,
      originalDocumentNumber: invoice?.documentNumber ?? null,
      customerId: customer.id,
      customerName: customer.name,
      amount: body.amount,
      reason: body.reason,
      notes: body.notes ?? null,
      sellerSnapshot: sellerSnapshot(tenant, outlet, taxModeFor(number.settings)),
      buyerSnapshot: customerSnapshot(customer),
      issuedAt: body.issuedAt,
      issuedBy: auth.userId,
    });
    await customersRepository.insertLedgerEntries(tx, [
      {
        customerId: customer.id,
        entryType: 'financial_credit_note',
        debit: 0,
        credit: body.amount,
        referenceType: 'financial_credit_note',
        referenceId: body.id,
        occurredAt: body.issuedAt,
        note: number.documentNumber,
        createdBy: auth.userId,
      },
    ]);
    await numberingRepository.markConsumed(tx, number.block.id, body.sequenceNo);
    await recordAudit(tx, {
      action: 'financial_credit_note.issued',
      entityType: 'financial_credit_note',
      entityId: body.id,
      metadata: { documentNumber: number.documentNumber, amount: body.amount },
    });
    const created = await repo.findFinancialNote(tx, body.id);
    return { creditNote: created, replayed: false };
  });
}

export function getFinancialCreditNote(id: string) {
  return withReadTransaction(async (tx) => {
    const note = await repo.findFinancialNote(tx, id);
    if (!note) throw new NotFoundError('Credit note');
    assertOutletAccess(note.outletId);
    return note;
  });
}

export async function listFinancialCreditNotes(query: ListNotesQuery) {
  const page = parsePage(query);
  const rows = await withReadTransaction((tx) => repo.listFinancialNotes(tx, query, accessibleOutletIds(), page.limit, page.cursor));
  return buildPage(rows, page.limit, (row) => ({ k: row.documentDate, id: row.id }));
}

/** No return carries this note, so a filed return does not stop it being cancelled. */
export function voidFinancialCreditNote(id: string, reason: string) {
  const auth = requireAuthContext();
  return withTransaction(async (tx) => {
    const note = await repo.findFinancialNote(tx, id, true);
    if (!note) throw new NotFoundError('Credit note');
    assertOutletAccess(note.outletId);
    if (note.status === 'void') return note;
    await repo.markFinancialNoteVoid(tx, id, reason, auth.userId);
    await customersRepository.insertLedgerEntries(tx, [
      {
        customerId: note.customerId,
        entryType: 'financial_credit_note_void',
        debit: note.amount,
        credit: 0,
        referenceType: 'financial_credit_note',
        referenceId: id,
        occurredAt: new Date().toISOString(),
        note: reason,
        createdBy: auth.userId,
      },
    ]);
    await recordAudit(tx, {
      action: 'financial_credit_note.voided',
      entityType: 'financial_credit_note',
      entityId: id,
      metadata: { reason, documentNumber: note.documentNumber },
    });
    return repo.findFinancialNote(tx, id);
  });
}
