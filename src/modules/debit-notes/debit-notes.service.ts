/**
 * Debit notes: goods or value going back to a supplier.
 *
 * A debit note is a GST document the shop *issues*, unlike a purchase bill
 * which it merely records. So it carries only our own number, from a real
 * series, and it appears in the issued-numbers view that GSTR-1 Table 13
 * reads.
 *
 * Pricing comes from the original bill line, never from the item master: a
 * return is settled at what was paid, and the supplier's credit note has to
 * agree with ours. The same reasoning applies to cost — stock leaves at the
 * `effective_unit_cost` the goods came in at, so returning them unwinds
 * exactly the value they added rather than today's blended average.
 */
import { env } from '../../config/env.js';
import { withReadTransaction, withTransaction, type Tx } from '../../db/tx.js';
import { reverseReceipt } from '../../domain/costing/moving-average.js';
import { computeInvoice } from '../../domain/tax/engine.js';
import type { SupplyType, TaxMode } from '../../domain/tax/types.js';
import { requireAuthContext } from '../../lib/context.js';
import { ErrorCode, InternalError, NotFoundError, UnprocessableError } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { buildPage, parsePage } from '../../lib/pagination.js';
import { accessibleOutletIds, assertOutletAccess } from '../../middleware/authorize.js';
import { businessEvents } from '../../observability/metrics.js';
import { recordAudit } from '../audit/audit.js';
import { assertFeature } from '../entitlements/entitlements.js';
import { outletsRepository } from '../outlets/outlets.repository.js';
import { itcRepository } from '../gst/itc.repository.js';
import { allocateNumber } from '../purchases/numbering.js';
import { purchasesRepository } from '../purchases/purchases.repository.js';
import { stockRepository } from '../stock/stock.repository.js';
import { suppliersRepository } from '../suppliers/suppliers.repository.js';
import { tenantsRepository } from '../tenants/tenants.repository.js';
import { debitNotesRepository, type DebitNoteLineInsert } from './debit-notes.repository.js';
import type { CreateDebitNoteBody, ListDebitNotesQuery } from './debit-notes.schemas.js';

/**
 * The bill columns a return reads.
 *
 * `PurchaseBillHeaderRow` carries an index signature for columns its own
 * callers do not name, which would make every read here a bracket lookup.
 * Naming them once keeps this readable and makes the dependency explicit.
 */
interface BillForReturn {
  readonly id: string;
  readonly outletId: string;
  readonly supplierId: string;
  readonly documentNumber: string;
  readonly status: 'issued' | 'void';
  readonly taxMode: TaxMode;
  // A debit note has no ITC eligibility of its own: it reverses whatever the
  // bill claimed, so both come from the bill.
  readonly itcEligible: boolean;
  readonly itcCategory: string | null;
  readonly supplyType: SupplyType;
  readonly isReverseCharge: boolean;
  readonly placeOfSupplyStateCode: string | null;
  readonly pricesIncludeTax: boolean;
  readonly roundOffEnabled: boolean;
}

async function loadNote(tx: Tx, id: string) {
  const header = await debitNotesRepository.findHeader(tx, id);
  if (!header) throw new NotFoundError('Debit note');
  return { ...header, lines: await debitNotesRepository.findLines(tx, id) };
}

/** What can still be sent back on each line of a bill. */
export function listReturnable(purchaseBillId: string) {
  return withReadTransaction(async (tx) => {
    const bill = await purchasesRepository.findBill(tx, purchaseBillId);
    if (!bill) throw new NotFoundError('Purchase bill');
    assertOutletAccess(bill.outletId);

    const lines = await debitNotesRepository.returnableLines(tx, purchaseBillId);
    return {
      purchaseBillId,
      documentNumber: bill.documentNumber,
      returnable: bill.status === 'issued',
      lines: lines.map((line) => ({
        ...line,
        taxRatePercent: Number(line.taxRatePercent),
        cessRatePercent: Number(line.cessRatePercent),
        returnableQuantity: Math.max(0, line.quantity - line.returnedQuantity),
      })),
    };
  });
}

export async function createDebitNote(body: CreateDebitNoteBody) {
  const auth = requireAuthContext();

  const result = await withTransaction(async (tx) => {
    await assertFeature(tx, 'purchases');
    if (await debitNotesRepository.exists(tx, body.id)) {
      return { note: await loadNote(tx, body.id), replayed: true };
    }

    const row = await purchasesRepository.findBill(tx, body.purchaseBillId, true);
    if (!row) throw new NotFoundError('Purchase bill');
    const bill = row as unknown as BillForReturn;
    assertOutletAccess(bill.outletId);
    if (bill.status === 'void') {
      throw new UnprocessableError(
        'That purchase bill is void, so nothing can be returned against it.',
        ErrorCode.BILL_NOT_RETURNABLE,
      );
    }

    const settings = await tenantsRepository.getSettings(tx);
    const supplier = await suppliersRepository.find(tx, bill.supplierId);
    if (!supplier) throw new NotFoundError('Supplier');

    // Locked, so two returns raised at once cannot both pass the
    // "not more than was bought" check.
    const billLines = new Map(
      (await debitNotesRepository.returnableLines(tx, body.purchaseBillId, true)).map((l) => [
        l.id,
        l,
      ]),
    );

    for (const line of body.lines) {
      const source = billLines.get(line.purchaseBillLineId);
      if (!source) {
        throw new UnprocessableError(
          'That line does not belong to this purchase bill.',
          ErrorCode.UNPROCESSABLE,
        );
      }
      const remaining = source.quantity - source.returnedQuantity;
      if (line.quantity > remaining) {
        throw new UnprocessableError(
          `Only ${remaining / 1000} of ${source.itemName} remains to return.`,
          ErrorCode.RETURN_EXCEEDS_BILL,
          { details: { purchaseBillLineId: line.purchaseBillLineId, remaining } },
        );
      }
    }

    const totals = computeInvoice(
      {
        mode: bill.taxMode,
        supplierStateCode: supplier.stateCode ?? settings.stateCode,
        placeOfSupplyStateCode: bill.placeOfSupplyStateCode ?? settings.stateCode,
        // Both carried over from the bill: a return of a reverse-charge
        // purchase reverses the same self-assessed liability, so the two have
        // to be reported on the same footing.
        supplyType: bill.supplyType,
        isReverseCharge: bill.isReverseCharge,
        pricesIncludeTax: bill.pricesIncludeTax,
        roundOff: bill.roundOffEnabled,
        lines: body.lines.map((line) => {
          const source = billLines.get(line.purchaseBillLineId);
          if (!source) throw new InternalError('Return line lost between checks.');
          return {
            id: line.id,
            quantity: line.quantity,
            // The original rate, so our debit note and the supplier's credit
            // note agree to the paisa.
            unitPrice: source.unitPrice,
            taxRatePercent: Number(source.taxRatePercent),
            cessRatePercent: Number(source.cessRatePercent),
            hsnCode: source.hsnCode ?? undefined,
            supplyCategory: source.supplyCategory,
          };
        }),
      },
      { allowedGstRates: env.GST_ALLOWED_RATES },
    );

    const number = await allocateNumber(tx, {
      outletId: bill.outletId,
      documentType: 'debit_note',
      documentDate: body.documentDate,
      fyStartMonth: settings.fyStartMonth,
    });

    await debitNotesRepository.insertHeader(tx, {
      id: body.id,
      outletId: bill.outletId,
      supplierId: bill.supplierId,
      purchaseBillId: body.purchaseBillId,
      originalDocumentNumber: bill.documentNumber,
      seriesId: number.seriesId,
      sequenceNo: number.sequenceNo,
      documentNumber: number.documentNumber,
      documentDate: body.documentDate,
      fyStartYear: number.fyStartYear,
      supplierGstin: supplier.gstin,
      supplierStateCode: supplier.stateCode,
      placeOfSupplyStateCode: bill.placeOfSupplyStateCode,
      pricesIncludeTax: bill.pricesIncludeTax,
      roundOffEnabled: bill.roundOffEnabled,
      totals,
      reasonCode: body.reasonCode,
      restock: body.restock,
      notes: body.notes ?? null,
      issuedAt: body.issuedAt,
      issuedBy: auth.userId,
    });

    const lineRows: DebitNoteLineInsert[] = body.lines.map((line, index) => {
      const computed = totals.lines[index];
      const source = billLines.get(line.purchaseBillLineId);
      if (!computed || !source) throw new InternalError('Tax engine returned fewer lines.');
      return {
        id: line.id,
        purchaseBillLineId: line.purchaseBillLineId,
        lineNo: index + 1,
        itemId: source.itemId,
        itemName: source.itemName,
        hsnCode: source.hsnCode,
        unit: source.unit,
        quantity: line.quantity,
        unitPrice: source.unitPrice,
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
        // The cost the goods came in at, not today's average.
        effectiveUnitCost: source.effectiveUnitCost,
        supplyCategory: computed.supplyCategory,
      };
    });
    await debitNotesRepository.insertLines(tx, body.id, bill.outletId, body.documentDate, lineRows);

    // Stock out, unless the goods never physically go back — damaged or
    // expired stock the supplier credits without collecting has already
    // left usable inventory by other means.
    if (body.restock) {
      // Cost before stock, as on the purchase side: `lockCost` seeds a
      // missing row's quantity from `stock_balances`, so writing the stock
      // entries first would have the seed already reflect this return and
      // the quantity would be deducted twice.
      for (const line of lineRows) {
        const current = await purchasesRepository.lockCost(tx, bill.outletId, line.itemId);
        const next = reverseReceipt(current, {
          quantity: line.quantity,
          unitCost: line.effectiveUnitCost,
        });
        await purchasesRepository.writeCost(tx, bill.outletId, line.itemId, next, null);
      }

      await stockRepository.insertEntries(
        tx,
        lineRows.map((line) => ({
          id: null,
          outletId: bill.outletId,
          itemId: line.itemId,
          entryType: 'purchase_return',
          quantityDelta: -line.quantity,
          reasonCode: null,
          referenceType: 'debit_note',
          referenceId: body.id,
          occurredAt: body.issuedAt,
          note: null,
          createdBy: auth.userId,
        })),
      );
    }

    // Debit reduces what the shop owes.
    await suppliersRepository.insertLedgerEntries(tx, [
      {
        supplierId: bill.supplierId,
        entryType: 'debit_note',
        debit: totals.grandTotal,
        credit: 0,
        referenceType: 'debit_note',
        referenceId: body.id,
        occurredAt: body.issuedAt,
        note: number.documentNumber,
        createdBy: auth.userId,
      },
    ]);

    // Reverse the credit on void as well, which the void path does below.
    // Returning goods gives back the credit claimed on them. Signed negative,
    // so the register sums to the claimable figure without a CASE on the
    // source type — and only when the bill claimed credit at all, since there
    // is nothing to reverse on an ineligible or composition purchase.
    if (bill.itcEligible) {
      await itcRepository.insert(tx, {
        id: newId(),
        // Our own registration, which an outlet may override. The register is
        // read per GSTIN because each registration files its own return.
        gstin:
          (await outletsRepository.findOutlet(tx, bill.outletId))?.gstin ?? settings.gstin ?? '',
        sourceType: 'debit_note',
        sourceId: body.id,
        supplierId: bill.supplierId,
        supplierGstin: supplier.gstin,
        documentDate: body.documentDate,
        itcCategory: (bill.itcCategory ?? 'inputs') as
          | 'inputs'
          | 'input_services'
          | 'capital_goods'
          | 'ineligible',
        ineligibleReason: null,
        isReverseCharge: bill.isReverseCharge,
        cgst: -totals.totalCgst,
        sgst: -totals.totalSgst,
        igst: -totals.totalIgst,
        cess: -totals.totalCess,
        taxableAmount: -totals.taxableAmount,
        state: 'available',
      });
    }

    await recordAudit(tx, {
      action: 'debit_note.created',
      entityType: 'debit_note',
      entityId: body.id,
      metadata: {
        documentNumber: number.documentNumber,
        purchaseBillId: body.purchaseBillId,
        grandTotal: totals.grandTotal,
      },
    });

    return { note: await loadNote(tx, body.id), replayed: false };
  });

  if (!result.replayed) businessEvents.inc({ event: 'debit_note.created' });
  return result;
}

export function getDebitNote(id: string) {
  return withReadTransaction(async (tx) => {
    const note = await loadNote(tx, id);
    assertOutletAccess(note.outletId);
    return note;
  });
}

export async function listDebitNotes(query: ListDebitNotesQuery) {
  const page = parsePage(query);
  const rows = await withReadTransaction((tx) =>
    debitNotesRepository.list(
      tx,
      {
        supplierId: query.supplierId,
        purchaseBillId: query.purchaseBillId,
        from: query.from,
        to: query.to,
      },
      accessibleOutletIds(),
      page.limit,
      page.cursor,
    ),
  );
  return buildPage(rows, page.limit, (row) => ({ k: row.documentDate, id: row.id }));
}

export async function voidDebitNote(id: string, reason: string) {
  const auth = requireAuthContext();

  const { note, voided } = await withTransaction(async (tx) => {
    const header = await debitNotesRepository.findHeader(tx, id, true);
    if (!header) throw new NotFoundError('Debit note');
    assertOutletAccess(header.outletId);
    if (header.status === 'void') return { note: await loadNote(tx, id), voided: false };

    await debitNotesRepository.markVoid(tx, id, reason, auth.userId);

    // Puts back whatever went out, and only if anything did: a return booked
    // against damaged goods never left stock, so there is nothing to restore.
    // The guard inside reverseEntries makes a repeated void a no-op on top of
    // that, so stock cannot be restored twice.
    if (header.restock) {
      await stockRepository.reverseEntries(tx, {
        referenceType: 'debit_note',
        referenceId: id,
        entryType: 'purchase_return',
        reversalType: 'purchase_return_void',
        userId: auth.userId,
      });
    }

    // The reversal entry is itself reversed: the goods did not go back after
    // all, so the credit stands as the bill claimed it.
    await itcRepository.markReversed(tx, 'debit_note', id);

    await suppliersRepository.insertLedgerEntries(tx, [
      {
        supplierId: header.supplierId,
        entryType: 'debit_note_void',
        debit: 0,
        credit: header.grandTotal,
        referenceType: 'debit_note',
        referenceId: id,
        occurredAt: new Date().toISOString(),
        note: reason,
        createdBy: auth.userId,
      },
    ]);

    await recordAudit(tx, {
      action: 'debit_note.voided',
      entityType: 'debit_note',
      entityId: id,
      metadata: { reason, documentNumber: header.documentNumber },
    });

    return { note: await loadNote(tx, id), voided: true };
  });

  if (voided) businessEvents.inc({ event: 'debit_note.voided' });
  return note;
}
