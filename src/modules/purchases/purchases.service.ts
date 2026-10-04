/**
 * Purchase bills: stock in, cost moved, payable created, all in one
 * transaction.
 *
 * Three things here deserve the attention of whoever reads this next.
 *
 * **Cost.** A purchase is the only event that changes what stock is worth.
 * The landed rate — supplier price, plus apportioned freight, minus the GST
 * that will be reclaimed — is folded into a moving weighted average per item
 * per outlet. Sales then read that average and snapshot it onto the invoice
 * line, which is what turns margin from a number recomputed against today's
 * prices into a historical fact.
 *
 * **Immutability.** A bill cannot be edited. It moved stock, moved cost and
 * created a payable; unwinding those after later sales have consumed the
 * blended cost is not something a correction screen can honestly do. A
 * mistake is voided and re-entered.
 *
 * **Double entry.** Keying the same supplier bill twice is the commonest
 * error in purchasing and silently doubles both stock and the payable, so
 * it is checked here by name and enforced by a unique index underneath.
 */
import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { withReadTransaction, withTransaction, type Tx } from '../../db/tx.js';
import { apportionLandedCost } from '../../domain/costing/landed-cost.js';
import { applyReceipt, reverseReceipt } from '../../domain/costing/moving-average.js';
import { computeInvoice } from '../../domain/tax/engine.js';
import type { TaxMode } from '../../domain/tax/types.js';
import { requireAuthContext } from '../../lib/context.js';
import {
  ConflictError,
  ErrorCode,
  InternalError,
  NotFoundError,
  UnprocessableError,
} from '../../lib/errors.js';
import { buildPage, parsePage } from '../../lib/pagination.js';
import { accessibleOutletIds, assertOutletAccess } from '../../middleware/authorize.js';
import { businessEvents } from '../../observability/metrics.js';
import { recordAudit } from '../audit/audit.js';
import { assertFeature } from '../entitlements/entitlements.js';
import { invoicesRepository } from '../invoices/invoices.repository.js';
import { outletsRepository } from '../outlets/outlets.repository.js';
import { stockRepository } from '../stock/stock.repository.js';
import {
  suppliersRepository,
  type NewSupplierLedgerEntry,
} from '../suppliers/suppliers.repository.js';
import { tenantsRepository, type TenantSettings } from '../tenants/tenants.repository.js';
import { allocateNumber } from './numbering.js';
import { ordersRepository } from './orders.repository.js';
import { assertReceiptFits } from './orders.service.js';
import { purchasesRepository, type PurchaseBillLineInsert } from './purchases.repository.js';
import type {
  CreatePurchaseBillBody,
  CreateSupplierPaymentBody,
  ListPurchaseBillsQuery,
  ListSupplierPaymentsQuery,
} from './purchases.schemas.js';

function taxModeFor(settings: TenantSettings): TaxMode {
  if (!settings.isGstRegistered) return 'non_gst';
  return settings.isComposition ? 'composition' : 'gst';
}

async function loadBill(tx: Tx, id: string) {
  const header = await purchasesRepository.findBill(tx, id);
  if (!header) throw new NotFoundError('Purchase bill');
  const lines = await purchasesRepository.findBillLines(tx, id);
  return {
    ...header,
    outstanding: header.grandTotal - header.amountPaid - header.returnedAmount,
    lines,
  };
}

/**
 * Records a supplier bill.
 *
 * Runs the same tax engine as a sale. A purchase does not need tax
 * *computed* — the supplier already decided it — but running the engine
 * gives a consistent rate-wise and HSN-wise summary for GSTR-2 workings and
 * catches a bill whose own arithmetic does not add up, which is worth
 * knowing before it is paid.
 */
export async function createPurchaseBill(body: CreatePurchaseBillBody) {
  const auth = requireAuthContext();
  assertOutletAccess(body.outletId);

  const result = await withTransaction(async (tx) => {
    await assertFeature(tx, 'purchases');

    // Client-generated id: a retried upload returns the stored bill rather
    // than entering stock twice.
    if (await purchasesRepository.billExists(tx, body.id)) {
      return { bill: await loadBill(tx, body.id), replayed: true };
    }

    const settings = await tenantsRepository.getSettings(tx);
    const outlet = await outletsRepository.findOutlet(tx, body.outletId);
    if (!outlet) throw new NotFoundError('Outlet');

    const supplier = await suppliersRepository.find(tx, body.supplierId);
    if (!supplier) throw new NotFoundError('Supplier');

    const taxMode = taxModeFor(settings);
    // Only a regular registered dealer reclaims input tax. A composition or
    // unregistered business never does, so the tax is part of what the goods
    // cost and must be capitalised.
    const itcEligible = taxMode === 'gst' && body.itcEligible;

    const number = await allocateNumber(tx, {
      outletId: body.outletId,
      documentType: 'purchase_bill',
      documentDate: body.documentDate,
      fyStartMonth: settings.fyStartMonth,
      seriesId: body.seriesId,
    });

    const duplicate = await purchasesRepository.findBySupplierInvoice(
      tx,
      body.supplierId,
      body.supplierInvoiceNo,
      number.fyStartYear,
    );
    if (duplicate) {
      throw new ConflictError(
        `Bill ${body.supplierInvoiceNo} from this supplier is already recorded as ${duplicate.documentNumber}.`,
        ErrorCode.DUPLICATE_SUPPLIER_INVOICE,
        { details: { existingId: duplicate.id, documentNumber: duplicate.documentNumber } },
      );
    }

    const itemIds = [...new Set(body.lines.map((l) => l.itemId))];
    const items = new Map(
      (await invoicesRepository.findItems(tx, itemIds)).map((item) => [item.id, item]),
    );
    const unknown = itemIds.filter((id) => !items.has(id));
    if (unknown.length > 0) throw new NotFoundError('Item', { details: { itemIds: unknown } });

    const totals = computeInvoice(
      {
        mode: taxMode,
        // On a purchase the supplier is the one supplying, so their state is
        // the origin and ours is the place of supply. Reversing these would
        // charge CGST/SGST on an inter-state buy.
        supplierStateCode: supplier.stateCode ?? outlet.stateCode ?? settings.stateCode,
        placeOfSupplyStateCode:
          body.placeOfSupplyStateCode ?? outlet.stateCode ?? settings.stateCode,
        pricesIncludeTax: body.pricesIncludeTax,
        roundOff: body.roundOff,
        billDiscount: body.billDiscount,
        lines: body.lines.map((l) => ({
          id: l.id,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          taxRatePercent: l.taxRatePercent,
          cessRatePercent: l.cessRatePercent,
          discount: l.discount,
          hsnCode: l.hsnCode ?? items.get(l.itemId)?.hsnCode ?? undefined,
        })),
      },
      { allowedGstRates: env.GST_ALLOWED_RATES },
    );

    const costed = apportionLandedCost({
      lines: totals.lines.map((line) => {
        const source = body.lines.find((l) => l.id === line.id);
        return {
          quantity: source?.quantity ?? 0,
          taxableAmount: line.taxableAmount,
          taxAmount: line.cgst + line.sgst + line.igst + line.cess,
        };
      }),
      additionalCost: body.freightAmount + body.otherChargesAmount,
      basis: body.landedCostBasis,
      itcEligible,
    });

    await purchasesRepository.insertBill(tx, {
      id: body.id,
      outletId: body.outletId,
      supplierId: supplier.id,
      purchaseOrderId: body.purchaseOrderId ?? null,
      seriesId: number.seriesId,
      sequenceNo: number.sequenceNo,
      documentNumber: number.documentNumber,
      documentDate: body.documentDate,
      fyStartYear: number.fyStartYear,
      supplierInvoiceNo: body.supplierInvoiceNo,
      supplierInvoiceDate: body.supplierInvoiceDate,
      dueDate: body.dueDate ?? dueDateFor(body.documentDate, supplier.paymentTermsDays),
      supplierGstin: supplier.gstin,
      supplierStateCode: supplier.stateCode,
      placeOfSupplyStateCode: body.placeOfSupplyStateCode ?? outlet.stateCode ?? settings.stateCode,
      pricesIncludeTax: body.pricesIncludeTax,
      roundOffEnabled: body.roundOff,
      itcEligible,
      totals,
      billDiscount: body.billDiscount ?? null,
      freightAmount: body.freightAmount,
      otherChargesAmount: body.otherChargesAmount,
      landedCostBasis: body.landedCostBasis,
      notes: body.notes ?? null,
      receivedAt: body.receivedAt,
      createdBy: auth.userId,
    });

    const lineRows: PurchaseBillLineInsert[] = body.lines.map((line, index) => {
      const computed = totals.lines[index];
      const cost = costed[index];
      if (!computed || !cost) {
        throw new InternalError('Tax engine returned fewer lines than it was given.');
      }
      const item = items.get(line.itemId);
      return {
        id: line.id,
        purchaseOrderLineId: line.purchaseOrderLineId ?? null,
        lineNo: index + 1,
        itemId: line.itemId,
        itemName: line.itemName ?? item?.name ?? '',
        hsnCode: computed.hsnCode ?? null,
        unit: line.unit ?? item?.unit ?? null,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        discount: line.discount ?? null,
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
        landedCostShare: cost.landedCostShare,
        effectiveUnitCost: cost.effectiveUnitCost,
      };
    });
    await purchasesRepository.insertBillLines(
      tx,
      body.id,
      body.outletId,
      body.documentDate,
      lineRows,
    );

    const tracked = lineRows.filter((line) => items.get(line.itemId)?.trackStock);

    // Cost BEFORE stock, and the order matters.
    //
    // `lockCost` seeds a missing row's quantity from `stock_balances`, which
    // a trigger maintains from the stock ledger. Writing the stock entries
    // first would make that seed already include the goods arriving now, so
    // the first purchase of an item would blend the new cost against a pool
    // of the same size held at zero — halving the average and understating
    // COGS on every subsequent sale.
    //
    // Only stocked goods are costed: a service has no inventory to value,
    // and giving it a cost quantity would make item_costs disagree with
    // stock_balances for a row nothing ever reconciles.
    //
    // Each row is locked for update, so two bills for one item cannot both
    // read the old average and lose one of the updates.
    for (const line of tracked) {
      const current = await purchasesRepository.lockCost(tx, body.outletId, line.itemId);
      const next = applyReceipt(current, {
        quantity: line.quantity,
        unitCost: line.effectiveUnitCost,
      });
      await purchasesRepository.writeCost(tx, body.outletId, line.itemId, next, {
        unitCost: line.effectiveUnitCost,
        at: body.receivedAt,
      });
    }

    // Stock in, for anything the catalogue tracks.
    if (tracked.length > 0) {
      await stockRepository.insertEntries(
        tx,
        tracked.map((line) => ({
          id: null,
          outletId: body.outletId,
          itemId: line.itemId,
          entryType: 'purchase',
          quantityDelta: line.quantity,
          reasonCode: null,
          referenceType: 'purchase_bill',
          referenceId: body.id,
          occurredAt: body.receivedAt,
          note: null,
          createdBy: auth.userId,
        })),
      );
    }

    // Payable.
    const ledger: NewSupplierLedgerEntry[] = [
      {
        supplierId: supplier.id,
        entryType: 'purchase',
        debit: 0,
        credit: totals.grandTotal,
        referenceType: 'purchase_bill',
        referenceId: body.id,
        occurredAt: body.receivedAt,
        note: number.documentNumber,
        createdBy: auth.userId,
      },
    ];

    if (body.paidAmount > 0) {
      if (body.paidAmount > totals.grandTotal) {
        throw new UnprocessableError(
          'The amount paid is more than the bill total.',
          ErrorCode.OVERPAYMENT,
        );
      }
      if (!body.paymentMode) {
        throw new UnprocessableError('A payment needs a mode.', ErrorCode.UNPROCESSABLE);
      }
      const paymentId = randomUUID();
      await purchasesRepository.insertPayment(tx, {
        id: paymentId,
        outletId: body.outletId,
        supplierId: supplier.id,
        mode: body.paymentMode,
        amount: body.paidAmount,
        reference: null,
        paidAt: body.receivedAt,
        paidBy: auth.userId,
        notes: null,
      });
      await purchasesRepository.insertAllocations(tx, [
        { supplierPaymentId: paymentId, purchaseBillId: body.id, amount: body.paidAmount },
      ]);
      ledger.push({
        supplierId: supplier.id,
        entryType: 'payment',
        debit: body.paidAmount,
        credit: 0,
        referenceType: 'supplier_payment',
        referenceId: paymentId,
        occurredAt: body.receivedAt,
        note: number.documentNumber,
        createdBy: auth.userId,
      });
    }

    await suppliersRepository.insertLedgerEntries(tx, ledger);

    if (body.purchaseOrderId) {
      const receipts = lineRows.flatMap((line) =>
        line.purchaseOrderLineId
          ? [{ lineId: line.purchaseOrderLineId, quantity: line.quantity }]
          : [],
      );
      // Checked with the order's lines locked, so two bills entered against
      // one order cannot both pass and together over-receive it.
      await assertReceiptFits(tx, body.purchaseOrderId, receipts);
      await ordersRepository.applyReceipt(tx, body.purchaseOrderId, receipts);
      await ordersRepository.refreshStatus(tx, body.purchaseOrderId);
    }

    await recordAudit(tx, {
      action: 'purchase_bill.created',
      entityType: 'purchase_bill',
      entityId: body.id,
      metadata: {
        documentNumber: number.documentNumber,
        supplierInvoiceNo: body.supplierInvoiceNo,
        supplierId: supplier.id,
        grandTotal: totals.grandTotal,
      },
    });

    return { bill: await loadBill(tx, body.id), replayed: false };
  });

  if (!result.replayed) businessEvents.inc({ event: 'purchase_bill.created' });
  return result;
}

/** Supplier terms decide the due date unless the bill states one. */
function dueDateFor(documentDate: string, termsDays: number | null): string | null {
  if (termsDays === null) return null;
  const date = new Date(`${documentDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + termsDays);
  return date.toISOString().slice(0, 10);
}

export function getPurchaseBill(id: string) {
  return withReadTransaction(async (tx) => {
    const bill = await loadBill(tx, id);
    assertOutletAccess(bill.outletId);
    return bill;
  });
}

export async function listPurchaseBills(query: ListPurchaseBillsQuery) {
  if (query.outletId) assertOutletAccess(query.outletId);
  const page = parsePage(query);
  const rows = await withReadTransaction((tx) =>
    purchasesRepository.listBills(
      tx,
      {
        from: query.from,
        to: query.to,
        status: query.status,
        supplierId: query.supplierId,
        outletId: query.outletId,
        unpaidOnly: query.unpaidOnly ?? false,
      },
      accessibleOutletIds(),
      page.limit,
      page.cursor,
    ),
  );
  return buildPage(rows, page.limit, (row) => ({ k: row.documentDate, id: row.id }));
}

/**
 * Voids a bill: stock out, cost backed out, payable reversed.
 *
 * The cost reversal is exact only if nothing has been sold since. Once the
 * blended average has been consumed by sales there is no arithmetic that
 * restores the prior figure, so the reversal approximates and the
 * moving-average module documents why. A bill with payments or debit notes
 * against it must have those undone first, because reversing a payable that
 * has already been partly settled would leave the ledger describing money
 * that did not move.
 */
export async function voidPurchaseBill(id: string, reason: string) {
  const auth = requireAuthContext();

  const { bill, voided } = await withTransaction(async (tx) => {
    const header = await purchasesRepository.findBill(tx, id, true);
    if (!header) throw new NotFoundError('Purchase bill');
    assertOutletAccess(header.outletId);
    if (header.status === 'void') return { bill: await loadBill(tx, id), voided: false };

    if (header.amountPaid > 0) {
      throw new UnprocessableError(
        'Void the payments made against this bill first.',
        ErrorCode.UNPROCESSABLE,
        { details: { amountPaid: header.amountPaid } },
      );
    }
    if (header.returnedAmount > 0) {
      throw new UnprocessableError(
        'Void the debit notes raised against this bill first.',
        ErrorCode.UNPROCESSABLE,
        { details: { returnedAmount: header.returnedAmount } },
      );
    }

    const lines = (await purchasesRepository.findBillLines(tx, id)) as unknown as {
      itemId: string;
      quantity: number;
      effectiveUnitCost: number;
    }[];

    // Only the lines that were costed on the way in get reversed, which is
    // the same set that moved stock.
    const trackStock = new Map(
      (await invoicesRepository.findItems(tx, [...new Set(lines.map((l) => l.itemId))])).map(
        (item) => [item.id, item.trackStock],
      ),
    );

    await purchasesRepository.markBillVoid(tx, id, reason, auth.userId);

    // Cost before stock, mirroring the create path: reversing stock first
    // would move stock_balances under a cost row that is about to be seeded
    // from it.
    for (const line of lines) {
      if (!trackStock.get(line.itemId)) continue;
      const current = await purchasesRepository.lockCost(tx, header.outletId, line.itemId);
      const next = reverseReceipt(current, {
        quantity: line.quantity,
        unitCost: line.effectiveUnitCost,
      });
      await purchasesRepository.writeCost(tx, header.outletId, line.itemId, next, null);
    }

    await stockRepository.reverseEntries(tx, {
      referenceType: 'purchase_bill',
      referenceId: id,
      entryType: 'purchase',
      reversalType: 'purchase_void',
      userId: auth.userId,
    });

    await suppliersRepository.insertLedgerEntries(tx, [
      {
        supplierId: header.supplierId,
        entryType: 'purchase_void',
        debit: header.grandTotal,
        credit: 0,
        referenceType: 'purchase_bill',
        referenceId: id,
        occurredAt: new Date().toISOString(),
        note: reason,
        createdBy: auth.userId,
      },
    ]);

    if (header.purchaseOrderId) {
      await ordersRepository.reverseReceipt(tx, header.purchaseOrderId, id);
      await ordersRepository.refreshStatus(tx, header.purchaseOrderId);
    }

    await recordAudit(tx, {
      action: 'purchase_bill.voided',
      entityType: 'purchase_bill',
      entityId: id,
      metadata: { reason, documentNumber: header.documentNumber },
    });

    return { bill: await loadBill(tx, id), voided: true };
  });

  if (voided) businessEvents.inc({ event: 'purchase_bill.voided' });
  return bill;
}

// ---------------------------------------------------------------------------
// Supplier payments
// ---------------------------------------------------------------------------

export function createSupplierPayment(body: CreateSupplierPaymentBody) {
  const auth = requireAuthContext();
  assertOutletAccess(body.outletId);

  return withTransaction(async (tx) => {
    await assertFeature(tx, 'purchases');

    const existing = await purchasesRepository.findPayment(tx, body.id);
    if (existing) return existing;

    const supplier = await suppliersRepository.find(tx, body.supplierId);
    if (!supplier) throw new NotFoundError('Supplier');

    const allocations = body.allocations ?? [];
    const allocated = allocations.reduce((sum, a) => sum + a.amount, 0);
    if (allocated > body.amount) {
      throw new UnprocessableError(
        'The allocations add up to more than the payment.',
        ErrorCode.OVERALLOCATION,
        { details: { amount: body.amount, allocated } },
      );
    }

    // Each bill is checked against what is actually still owed on it, with
    // the bill row locked so two payments cannot both allocate the last
    // rupee of the same bill.
    for (const allocation of allocations) {
      const bill = await purchasesRepository.findBill(tx, allocation.purchaseBillId, true);
      if (!bill) throw new NotFoundError('Purchase bill');
      if (bill.supplierId !== body.supplierId) {
        throw new UnprocessableError(
          'That bill belongs to a different supplier.',
          ErrorCode.UNPROCESSABLE,
        );
      }
      if (bill.status === 'void') {
        throw new UnprocessableError(
          `Bill ${bill.documentNumber} is void and cannot be paid.`,
          ErrorCode.BILL_NOT_RETURNABLE,
        );
      }
      const outstanding = bill.grandTotal - bill.amountPaid - bill.returnedAmount;
      if (allocation.amount > outstanding) {
        throw new UnprocessableError(
          `Only ${outstanding} paise is outstanding on bill ${bill.documentNumber}.`,
          ErrorCode.OVERALLOCATION,
          { details: { purchaseBillId: bill.id, outstanding, requested: allocation.amount } },
        );
      }
    }

    await purchasesRepository.insertPayment(tx, {
      id: body.id,
      outletId: body.outletId,
      supplierId: body.supplierId,
      mode: body.mode,
      amount: body.amount,
      reference: body.reference ?? null,
      paidAt: body.paidAt,
      paidBy: auth.userId,
      notes: body.notes ?? null,
    });

    if (allocations.length > 0) {
      await purchasesRepository.insertAllocations(
        tx,
        allocations.map((a) => ({
          supplierPaymentId: body.id,
          purchaseBillId: a.purchaseBillId,
          amount: a.amount,
        })),
      );
    }

    // The full amount hits the ledger whether or not it was allocated: an
    // unallocated payment is an advance, and it still reduces what is owed.
    await suppliersRepository.insertLedgerEntries(tx, [
      {
        supplierId: body.supplierId,
        entryType: 'payment',
        debit: body.amount,
        credit: 0,
        referenceType: 'supplier_payment',
        referenceId: body.id,
        occurredAt: body.paidAt,
        note: body.reference ?? null,
        createdBy: auth.userId,
      },
    ]);

    await recordAudit(tx, {
      action: 'supplier_payment.created',
      entityType: 'supplier_payment',
      entityId: body.id,
      metadata: { supplierId: body.supplierId, amount: body.amount, allocated },
    });

    return purchasesRepository.findPayment(tx, body.id);
  });
}

export async function listSupplierPayments(query: ListSupplierPaymentsQuery) {
  const page = parsePage(query);
  const rows = await withReadTransaction((tx) =>
    purchasesRepository.listPayments(
      tx,
      { supplierId: query.supplierId, from: query.from, to: query.to },
      accessibleOutletIds(),
      page.limit,
      page.cursor,
    ),
  );
  return buildPage(rows, page.limit, (row) => ({ k: row.paidAt.toISOString(), id: row.id }));
}

export function voidSupplierPayment(id: string, reason: string) {
  const auth = requireAuthContext();

  return withTransaction(async (tx) => {
    const payment = await purchasesRepository.findPayment(tx, id, true);
    if (!payment) throw new NotFoundError('Supplier payment');
    assertOutletAccess(payment.outletId);
    if (payment.status === 'void') return payment;

    await purchasesRepository.markPaymentVoid(tx, id, reason, auth.userId);
    await suppliersRepository.insertLedgerEntries(tx, [
      {
        supplierId: payment.supplierId,
        entryType: 'payment_void',
        debit: 0,
        credit: payment.amount,
        referenceType: 'supplier_payment',
        referenceId: id,
        occurredAt: new Date().toISOString(),
        note: reason,
        createdBy: auth.userId,
      },
    ]);

    await recordAudit(tx, {
      action: 'supplier_payment.voided',
      entityType: 'supplier_payment',
      entityId: id,
      metadata: { reason, amount: payment.amount },
    });

    return purchasesRepository.findPayment(tx, id);
  });
}
