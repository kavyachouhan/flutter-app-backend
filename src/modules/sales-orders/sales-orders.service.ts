/**
 * Sales orders.
 *
 * An order is an intention, not a GST document: it moves no stock and takes no
 * invoice number. Its job is to be fulfilled by invoices, so the one piece of
 * state it really keeps is how much of each line has been invoiced.
 *
 * Three facts are kept apart:
 *   - fulfilment (open / partial / closed) is derived from the lines;
 *   - payment (the advance) is a real `payments` row plus a khata credit, and
 *     never moves the status;
 *   - reservation (stock promised to the order) is a projection on
 *     `stock_balances`, kept in step with the lines at every change.
 */
import { randomUUID } from 'node:crypto';
import { withReadTransaction, withTransaction, type Tx } from '../../db/tx.js';
import type { Discount, TaxInvoiceResult, TaxMode } from '../../domain/tax/types.js';
import {
  assertAttachments,
  checkAttachments,
  removeDroppedAttachments,
} from '../../lib/attachments.js';
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
import { recordAudit } from '../audit/audit.js';
import { customersRepository, type NewLedgerEntry } from '../customers/customers.repository.js';
import { assertFeature } from '../entitlements/entitlements.js';
import { outletsRepository } from '../outlets/outlets.repository.js';
import { paymentsRepository } from '../payments/payments.repository.js';
import { validateCustomFields } from '../print/custom-fields.js';
import { discountsRepository } from '../price-lists/discounts.repository.js';
import { resolveLinePrices } from '../price-lists/price-lists.service.js';
import { allocateNumber } from '../purchases/numbering.js';
import {
  assertItemsKnown,
  assertTotalsMatch,
  computeSaleTotals,
  evaluateDiscountCaps,
  loadSaleItems,
  mispricedLines,
  resolveApprovers,
  taxModeFor,
  unapprovedBreaches,
  type ApprovalInput,
} from '../sales-docs/prepare.js';
import { stockRepository } from '../stock/stock.repository.js';
import { resolveTermsForDocument } from '../terms/terms.service.js';
import { tenantsRepository } from '../tenants/tenants.repository.js';
import {
  salesOrdersRepository,
  type SaleOrderHeaderUpdate,
  type SaleOrderLineRow,
  type SaleOrderLineWrite,
  type SaleOrderRow,
} from './sales-orders.repository.js';
import type {
  CancelSaleOrderBody,
  CloseSaleOrderBody,
  CreateSaleOrderBody,
  DeleteSaleOrderQuery,
  ListSaleOrdersQuery,
  SummarySaleOrdersQuery,
  UpdateSaleOrderBody,
} from './sales-orders.schemas.js';

export interface OrderWarning {
  code: WarningCodeValue;
  details: Record<string, unknown>;
}

type OrderBody = UpdateSaleOrderBody;

async function loadOrder(tx: Tx, id: string) {
  const order = await salesOrdersRepository.find(tx, id);
  if (!order) throw new NotFoundError('Sales order');
  const lines = await salesOrdersRepository.findLines(tx, id);
  const advance = await salesOrdersRepository.advanceState(tx, id);
  const invoices = await salesOrdersRepository.findInvoices(tx, id);
  const discountInvoiced = await salesOrdersRepository.billDiscountInvoiced(tx, id);
  const held = Math.max(0, advance.taken - advance.refunded);
  return {
    ...order,
    // What the customer has paid in and not been given back, against the total.
    balanceDue: Math.max(0, order.grandTotal - held),
    advanceApplied: advance.applied,
    advanceRemaining: advance.remaining,
    // What the bill-level discount still has to give to the next invoice.
    billDiscountRemaining: Math.max(0, order.billDiscountAmount - discountInvoiced),
    invoices,
    lines: lines.map((line) => ({
      ...line,
      quantityPending: Math.max(0, line.quantity - line.quantityFulfilled),
    })),
  };
}

/** A header-only order: no items, the user typed the amount. No tax is derivable from it. */
function manualTotals(mode: TaxMode, amount: number): TaxInvoiceResult {
  return {
    supplyType: 'intra_state',
    mode,
    lines: [],
    grossAmount: amount,
    totalLineDiscount: 0,
    billDiscount: 0,
    totalDiscount: 0,
    taxableAmount: amount,
    totalCgst: 0,
    totalSgst: 0,
    totalIgst: 0,
    totalCess: 0,
    totalTax: 0,
    taxableCharges: 0,
    nonTaxableCharges: 0,
    subTotal: amount,
    roundOff: 0,
    grandTotal: amount,
    taxSummary: [],
    hsnSummary: [],
    categoryTotals: { taxable: amount, exempt: 0, nilRated: 0, nonGst: 0 },
    isReverseCharge: false,
  };
}

interface PreparedOrder {
  header: Omit<
    SaleOrderHeaderUpdate,
    'id' | 'advancePaymentId'
  >;
  lines: SaleOrderLineWrite[];
  customer: Awaited<ReturnType<typeof customersRepository.find>>;
  approvals: { approval: ApprovalInput; role: string }[];
  discounted: boolean;
  warnings: OrderWarning[];
}

const normDiscount = (d: Discount | null | undefined) =>
  d ? { kind: d.kind, value: Number(d.value) } : null;

/**
 * Everything both create and update must agree on: validation, the shared tax
 * engine, the totals check and the discount policy. Kept in one place so an edit
 * cannot be validated more loosely than a create.
 */
async function prepareOrder(tx: Tx, body: OrderBody): Promise<PreparedOrder> {
  if (body.dueDate && body.dueDate < body.documentDate) {
    throw new ValidationError('The due date cannot be before the order date.', {
      details: { field: 'dueDate' },
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

  // Accepts the older `order_attachment` kind as well as the newer
  // `attachment_image` / `attachment_file`, so existing orders stay editable.
  assertAttachments(body.attachments);

  // Before the bag becomes part of the order, so a field the tenant never defined is
  // named in the rejection rather than stored and unprintable.
  await validateCustomFields(tx, 'sales_order', body.customFields);

  const { items, unknown } = await loadSaleItems(tx, body.lines);
  assertItemsKnown(unknown);

  const warnings: OrderWarning[] = [];
  let totals: TaxInvoiceResult;
  let approvals: { approval: ApprovalInput; role: string }[] = [];
  let discounted = false;

  if (body.lines.length === 0) {
    // The form allows an order with no items and a typed total. Anything else would
    // make a tampered request able to claim a total with nothing behind it.
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
      throw new ValidationError('A manual total can only be used on an order with no items.', {
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

    // The engine clamps an oversized discount to what it is taken from, which would
    // quietly store a smaller discount than the one the person typed.
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

    // The shop's discount policy. The order is typed online, so a discount over policy
    // without an approval is refused here; an invoice, already a sale, only warns.
    const evaluation = await evaluateDiscountCaps(tx, {
      outletId: body.outletId,
      totals,
      lines: body.lines,
    });
    const submitted = body.discountApprovals ?? [];
    const unapproved = unapprovedBreaches(
      evaluation.breaches,
      new Set(submitted.map((a) => a.breachKind)),
    );
    if (unapproved.length > 0) {
      throw new UnprocessableError(
        'A discount is over the limit the shop has set and needs approval.',
        ErrorCode.DISCOUNT_CAP_EXCEEDED,
        {
          details: {
            breaches: unapproved,
            approverPermission: evaluation.approverPermission,
          },
        },
      );
    }
    approvals = await resolveApprovers(tx, submitted, evaluation.approverPermission);
    discounted = totals.totalDiscount > 0 || evaluation.breaches.length > 0;

    // What the customer's price list says each catalogue line should cost. Reported, not
    // corrected: the order records the price that was agreed.
    const expectedPrices = await resolveLinePrices(tx, {
      outletId: body.outletId,
      customerId: customer?.id ?? null,
      documentDate: body.documentDate,
      lines: body.lines.map((l) => ({ id: l.id, itemId: l.itemId, quantity: l.quantity })),
    });
    const mispriced = mispricedLines(expectedPrices, body.lines);
    if (mispriced.length > 0) {
      warnings.push({ code: WarningCode.PRICE_LIST_MISMATCH, details: { lines: mispriced } });
    }
  }

  assertTotalsMatch(totals, body.expectedTotals, 'Order');

  const advance = body.advanceAmount;
  if (advance > totals.grandTotal) {
    throw new UnprocessableError(
      'The advance cannot be more than the order total.',
      ErrorCode.OVERPAYMENT,
      { details: { advance, grandTotal: totals.grandTotal } },
    );
  }
  if (advance > 0 && !customer) {
    throw new UnprocessableError(
      'An advance needs a saved customer to hold the credit.',
      ErrorCode.CREDIT_SALE_REQUIRES_CUSTOMER,
    );
  }
  if (advance > 0 && !body.paymentMode) {
    throw new ValidationError('Choose how the advance was paid.', {
      details: { field: 'paymentMode' },
    });
  }

  const terms = await resolveTermsForDocument(tx, body.termsId, 'sale_order');

  const lines: SaleOrderLineWrite[] = body.lines.map((l, index) => {
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
    customer,
    lines,
    approvals,
    discounted,
    warnings,
    header: {
      outletId: body.outletId,
      documentDate: body.documentDate,
      dueDate: body.dueDate ?? null,
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
      advanceAmount: advance,
      paymentMode: body.paymentMode ?? null,
      notes: body.notes ?? null,
      customFields: body.customFields ?? null,
      attachments: body.attachments ?? [],
      termsId: terms?.termsId ?? null,
      termsSnapshot: terms?.snapshot ?? null,
    },
  };
}

// --- Reservation -------------------------------------------------------------

/**
 * Runs a change to an order and moves the stock reservation by exactly what the
 * change did to it.
 *
 * The delta is read from the order's own lines before and after, so no call site
 * has to work out what it reserves: create, edit, fulfil, reverse, cancel, close
 * and delete all go through here. Rows are touched in item order so two orders
 * changing at once cannot deadlock on each other.
 *
 * [enforce] says whether going short is a problem. A new or enlarged order checks
 * it; a void or a return giving stock back to an order must always go through.
 */
async function trackReservation(
  tx: Tx,
  orderId: string,
  mutate: () => Promise<void>,
  enforce: boolean,
): Promise<OrderWarning[]> {
  const before = await salesOrdersRepository.reservedFor(tx, orderId);
  await mutate();
  const after = await salesOrdersRepository.reservedFor(tx, orderId);
  const outletId = after.outletId ?? before.outletId;
  if (!outletId) return [];

  const itemIds = [...new Set([...before.byItem.keys(), ...after.byItem.keys()])].sort();
  const grown: string[] = [];
  for (const itemId of itemIds) {
    const delta = (after.byItem.get(itemId) ?? 0) - (before.byItem.get(itemId) ?? 0);
    if (delta === 0) continue;
    await stockRepository.adjustReserved(tx, outletId, itemId, delta);
    if (delta > 0) grown.push(itemId);
  }
  if (!enforce || grown.length === 0) return [];

  const short = await stockRepository.findReservedShortfalls(tx, outletId, grown);
  if (short.length === 0) return [];

  const details = {
    items: short.map((s) => ({
      itemId: s.itemId,
      onHand: s.onHand,
      reserved: s.reserved,
      short: s.reserved - s.onHand,
    })),
  };
  const settings = await tenantsRepository.getSettings(tx);
  if (!settings.allowNegativeStock) {
    throw new UnprocessableError(
      'There is not enough stock available to reserve for this order.',
      ErrorCode.INSUFFICIENT_STOCK,
      { details },
    );
  }
  return [{ code: WarningCode.RESERVATION_SHORTFALL, details }];
}

// --- Advance -----------------------------------------------------------------

/**
 * Brings the advance payment in line with the order.
 *
 * An unchanged advance is left alone. A changed one voids the old payment and
 * writes a new one rather than editing it: payments are immutable records, and the
 * khata gets a matching reversal so the trail reads what happened.
 */
async function syncAdvance(
  tx: Tx,
  order: { id: string; documentNumber: string },
  previous: SaleOrderRow | undefined,
  next: { amount: number; mode: string | null; customerId: string | null; outletId: string },
): Promise<string | null> {
  const auth = requireAuthContext();
  const unchanged =
    previous !== undefined &&
    previous.advanceAmount === next.amount &&
    previous.customerId === next.customerId &&
    (next.amount === 0 || previous.paymentMode === next.mode);
  if (unchanged) return previous.advancePaymentId;

  const now = new Date().toISOString();
  const entries: NewLedgerEntry[] = [];

  if (previous?.advancePaymentId && previous.customerId) {
    await paymentsRepository.markVoid(
      tx,
      previous.advancePaymentId,
      'Sales order advance changed',
      auth.userId,
    );
    entries.push({
      customerId: previous.customerId,
      entryType: 'payment_void',
      debit: previous.advanceAmount,
      credit: 0,
      referenceType: 'payment',
      referenceId: previous.advancePaymentId,
      occurredAt: now,
      note: `Advance changed on ${order.documentNumber}`,
      createdBy: auth.userId,
    });
  }

  let paymentId: string | null = null;
  if (next.amount > 0 && next.customerId && next.mode) {
    paymentId = randomUUID();
    await paymentsRepository.insertOrderAdvance(tx, {
      id: paymentId,
      outletId: next.outletId,
      customerId: next.customerId,
      salesOrderId: order.id,
      mode: next.mode,
      amount: next.amount,
      receivedAt: now,
      receivedBy: auth.userId,
    });
    entries.push({
      customerId: next.customerId,
      entryType: 'payment',
      debit: 0,
      credit: next.amount,
      referenceType: 'payment',
      referenceId: paymentId,
      occurredAt: now,
      note: `Advance for ${order.documentNumber}`,
      createdBy: auth.userId,
    });
  }

  if (entries.length > 0) await customersRepository.insertLedgerEntries(tx, entries);
  return paymentId;
}

export interface AdvanceRefund {
  /** Paise left on the order's advance when it was settled. */
  amount: number;
  /** `khata` means it stays as the customer's credit and no money moved. */
  mode: string;
  paidOut: boolean;
}

/**
 * Settles the advance that has not been used when an order is cancelled, closed or
 * deleted: pays it back, or leaves it as the customer's credit.
 *
 * [defaultToOriginal] is the cancel and delete behaviour (pay back the way it was
 * taken); close defaults to leaving the credit, since a closed order usually still
 * has a customer who will buy again.
 */
async function settleAdvance(
  tx: Tx,
  order: SaleOrderRow,
  requested: string | undefined,
  defaultToOriginal: boolean,
  reason: string,
): Promise<AdvanceRefund | null> {
  if (!order.customerId) return null;
  const state = await salesOrdersRepository.advanceState(tx, order.id);
  if (state.remaining <= 0) return null;

  const mode = requested ?? (defaultToOriginal ? (order.paymentMode ?? 'khata') : 'khata');
  if (mode === 'khata') return { amount: state.remaining, mode: 'khata', paidOut: false };

  const auth = requireAuthContext();
  const paymentId = randomUUID();
  const now = new Date().toISOString();
  await paymentsRepository.insertOrderRefund(tx, {
    id: paymentId,
    outletId: order.outletId,
    customerId: order.customerId,
    salesOrderId: order.id,
    mode,
    amount: state.remaining,
    reference: null,
    receivedAt: now,
    receivedBy: auth.userId,
  });
  await customersRepository.insertLedgerEntries(tx, [
    {
      customerId: order.customerId,
      entryType: 'refund',
      debit: state.remaining,
      credit: 0,
      referenceType: 'payment',
      referenceId: paymentId,
      occurredAt: now,
      note: `${reason}: ${order.documentNumber}`,
      createdBy: auth.userId,
    },
  ]);
  await salesOrdersRepository.addRefunded(tx, order.id, state.remaining);
  await recordAudit(tx, {
    action: 'sales_order.advance_refunded',
    entityType: 'sales_order',
    entityId: order.id,
    metadata: {
      documentNumber: order.documentNumber,
      amount: state.remaining,
      mode,
      reason,
    },
  });
  return { amount: state.remaining, mode, paidOut: true };
}

/** Records the approvals that let a discount through, against the order that carries it. */
async function recordApprovals(
  tx: Tx,
  orderId: string,
  outletId: string,
  approvals: PreparedOrder['approvals'],
): Promise<void> {
  const auth = requireAuthContext();
  for (const { approval, role } of approvals) {
    await discountsRepository.insertApproval(tx, {
      id: approval.id,
      outletId,
      invoiceId: null,
      salesOrderId: orderId,
      invoiceLineId: null,
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
}

// --- Create / read / update --------------------------------------------------

export async function createSaleOrder(body: CreateSaleOrderBody) {
  const auth = requireAuthContext();
  await checkAttachments(body.attachments);
  assertOutletAccess(body.outletId);

  return withTransaction(async (tx) => {
    await assertFeature(tx, 'sales_orders');
    if (await salesOrdersRepository.exists(tx, body.id)) {
      const existing = await salesOrdersRepository.find(tx, body.id);
      if (!existing) {
        throw new UnprocessableError('That sales order was deleted.', ErrorCode.SALES_ORDER_CLOSED);
      }
      return { order: await loadOrder(tx, body.id), replayed: true, warnings: [] as OrderWarning[] };
    }

    const prepared = await prepareOrder(tx, body);
    const settings = await tenantsRepository.getSettings(tx);
    const number = await allocateNumber(tx, {
      outletId: body.outletId,
      documentType: 'sales_order',
      documentDate: body.documentDate,
      fyStartMonth: settings.fyStartMonth,
    });

    // The header goes in with no advance yet: the payment row points at the order,
    // so the order must exist first. The pointer is set right after.
    const reservation = await trackReservation(
      tx,
      body.id,
      async () => {
        await salesOrdersRepository.insertHeader(tx, {
          ...prepared.header,
          id: body.id,
          seriesId: number.seriesId,
          sequenceNo: number.sequenceNo,
          documentNumber: number.documentNumber,
          fyStartYear: number.fyStartYear,
          advanceAmount: 0,
          advancePaymentId: null,
          createdBy: auth.userId,
        });
        await salesOrdersRepository.insertLines(tx, body.id, prepared.lines);
      },
      true,
    );

    const paymentId = await syncAdvance(
      tx,
      { id: body.id, documentNumber: number.documentNumber },
      undefined,
      {
        amount: prepared.header.advanceAmount,
        mode: prepared.header.paymentMode,
        customerId: prepared.header.customerId,
        outletId: body.outletId,
      },
    );
    if (prepared.header.advanceAmount > 0) {
      await salesOrdersRepository.setAdvance(
        tx,
        body.id,
        prepared.header.advanceAmount,
        paymentId,
      );
    }
    await recordApprovals(tx, body.id, body.outletId, prepared.approvals);

    await recordAudit(tx, {
      action: 'sales_order.created',
      entityType: 'sales_order',
      entityId: body.id,
      metadata: {
        documentNumber: number.documentNumber,
        grandTotal: prepared.header.totals.grandTotal,
        advanceAmount: prepared.header.advanceAmount,
        customerId: prepared.header.customerId,
      },
    });
    if (prepared.discounted) {
      await recordAudit(tx, {
        action: 'sales_order.discounted',
        entityType: 'sales_order',
        entityId: body.id,
        metadata: {
          documentNumber: number.documentNumber,
          lineDiscountTotal: prepared.header.totals.totalLineDiscount,
          billDiscount: prepared.header.totals.billDiscount,
          reason: prepared.header.billDiscountReason,
          approvedBy: prepared.approvals.map((a) => a.approval.approvedBy),
        },
      });
    }

    return {
      order: await loadOrder(tx, body.id),
      replayed: false,
      warnings: [...prepared.warnings, ...reservation],
    };
  });
}

/** An order that was cancelled or deleted cannot be changed or invoiced. */
function assertNotCancelled(order: SaleOrderRow): void {
  if (order.status === 'cancelled') {
    throw new UnprocessableError(
      'This sales order is cancelled and cannot be changed.',
      ErrorCode.SALES_ORDER_CLOSED,
    );
  }
}

/**
 * Edits an order, replacing its header and lines in one transaction.
 *
 * Lines are matched by id. A line that has been invoiced keeps the item, price, tax
 * and discount it was invoiced at: those figures are on issued invoices, and changing
 * them here would make the order disagree with its own bills. To change them, amend
 * the invoice first. Quantity can still go up (more to deliver at the same price) or
 * come down as far as what has already been invoiced.
 *
 * A closed order can be edited too. Adding something to deliver re-opens it.
 */
export async function updateSaleOrder(id: string, body: UpdateSaleOrderBody) {
  await checkAttachments(body.attachments);
  let previous: unknown;
  const result = await updateSaleOrderInTransaction(id, body, (a) => {
    previous = a;
  });
  // After the commit: files the edit took off the order are no longer referenced.
  await removeDroppedAttachments(previous, body.attachments);
  return result;
}

function updateSaleOrderInTransaction(
  id: string,
  body: UpdateSaleOrderBody,
  onPrevious: (attachments: unknown) => void,
) {
  return withTransaction(async (tx) => {
    await assertFeature(tx, 'sales_orders');
    const order = await salesOrdersRepository.find(tx, id, true);
    if (!order) throw new NotFoundError('Sales order');
    onPrevious(order.attachments);
    assertOutletAccess(order.outletId);
    assertNotCancelled(order);
    if (body.outletId !== order.outletId) {
      throw new UnprocessableError('An order cannot be moved to another outlet.');
    }

    const existing = new Map(
      (await salesOrdersRepository.lockLines(tx, id)).map((l): [string, SaleOrderLineRow] => [
        l.id,
        l,
      ]),
    );
    const incomingIds = new Set(body.lines.map((l) => l.id));

    for (const line of existing.values()) {
      if (line.quantityFulfilled > 0 && !incomingIds.has(line.id)) {
        throw new UnprocessableError(
          'A line that has already been invoiced cannot be removed.',
          ErrorCode.ORDER_LINE_INVOICED,
          { details: { lineId: line.id } },
        );
      }
    }
    for (const line of body.lines) {
      const before = existing.get(line.id);
      if (!before || before.quantityFulfilled === 0) continue;
      if (line.quantity < before.quantityFulfilled) {
        throw new UnprocessableError(
          'The quantity cannot be less than what has already been invoiced.',
          ErrorCode.FULFILMENT_EXCEEDS_ORDER,
          {
            details: {
              lineId: line.id,
              fulfilled: before.quantityFulfilled,
              requested: line.quantity,
            },
          },
        );
      }
      const sameFinancials =
        (line.itemId ?? null) === before.itemId &&
        line.unitPrice === before.unitPrice &&
        Number(line.taxRatePercent) === Number(before.taxRatePercent) &&
        Number(line.cessRatePercent ?? 0) === Number(before.cessRatePercent) &&
        JSON.stringify(normDiscount(line.discount)) ===
          JSON.stringify(normDiscount(before.discount));
      if (!sameFinancials) {
        throw new UnprocessableError(
          'The item, price, tax and discount of an invoiced line are fixed. Amend the invoice to change them.',
          ErrorCode.ORDER_LINE_INVOICED,
          { details: { lineId: line.id } },
        );
      }
    }

    const prepared = await prepareOrder(tx, body);
    const invoicedAny = [...existing.values()].some((l) => l.quantityFulfilled > 0);
    if (order.customerId !== null && prepared.header.customerId !== order.customerId && invoicedAny) {
      throw new UnprocessableError(
        'The customer cannot be changed once an invoice has been raised against the order.',
        ErrorCode.SALES_ORDER_CLOSED,
      );
    }

    const advanceNow = await salesOrdersRepository.advanceState(tx, id);
    const advanceChanged = !(
      order.advanceAmount === prepared.header.advanceAmount &&
      order.customerId === prepared.header.customerId &&
      (prepared.header.advanceAmount === 0 || order.paymentMode === prepared.header.paymentMode)
    );
    if (advanceChanged && (advanceNow.applied > 0 || advanceNow.refunded > 0)) {
      throw new UnprocessableError(
        'The advance has been used or refunded, so it can no longer be changed.',
        ErrorCode.ADVANCE_LOCKED,
        { details: { applied: advanceNow.applied, refunded: advanceNow.refunded } },
      );
    }

    const pendingBefore = [...existing.values()].reduce(
      (sum, l) => sum + Math.max(0, l.quantity - l.quantityFulfilled),
      0,
    );
    const pendingAfter = prepared.lines.reduce(
      (sum, l) => sum + Math.max(0, l.quantity - (existing.get(l.id)?.quantityFulfilled ?? 0)),
      0,
    );

    const toUpdate = prepared.lines.filter((l) => existing.has(l.id));
    const toInsert = prepared.lines.filter((l) => !existing.has(l.id));
    const toDelete = [...existing.keys()].filter((lineId) => !incomingIds.has(lineId));

    const reservation = await trackReservation(
      tx,
      id,
      async () => {
        const paymentId = await syncAdvance(
          tx,
          { id, documentNumber: order.documentNumber },
          order,
          {
            amount: prepared.header.advanceAmount,
            mode: prepared.header.paymentMode,
            customerId: prepared.header.customerId,
            outletId: order.outletId,
          },
        );
        await salesOrdersRepository.updateHeader(tx, {
          ...prepared.header,
          id,
          advancePaymentId: paymentId,
        });
        await salesOrdersRepository.deleteLines(tx, id, toDelete);
        await salesOrdersRepository.updateLines(tx, id, toUpdate);
        await salesOrdersRepository.insertLines(tx, id, toInsert);
        // A manually closed order stays closed through an edit that adds nothing to
        // deliver (notes, T&C); one that adds quantity or a line is open for business again.
        if (order.closedManually && pendingAfter > pendingBefore) {
          await salesOrdersRepository.setClosedManually(tx, id, false);
        }
        await salesOrdersRepository.refreshStatus(tx, id);
      },
      true,
    );
    await recordApprovals(tx, id, order.outletId, prepared.approvals);

    await recordAudit(tx, {
      action: 'sales_order.updated',
      entityType: 'sales_order',
      entityId: id,
      metadata: {
        documentNumber: order.documentNumber,
        grandTotalBefore: order.grandTotal,
        grandTotalAfter: prepared.header.totals.grandTotal,
        advanceBefore: order.advanceAmount,
        advanceAfter: prepared.header.advanceAmount,
        statusBefore: order.status,
      },
    });
    if (prepared.discounted) {
      await recordAudit(tx, {
        action: 'sales_order.discounted',
        entityType: 'sales_order',
        entityId: id,
        metadata: {
          documentNumber: order.documentNumber,
          billDiscount: prepared.header.totals.billDiscount,
          reason: prepared.header.billDiscountReason,
          approvedBy: prepared.approvals.map((a) => a.approval.approvedBy),
        },
      });
    }
    return { order: await loadOrder(tx, id), warnings: [...prepared.warnings, ...reservation] };
  });
}

export function getSaleOrder(id: string) {
  return withReadTransaction(async (tx) => {
    await assertFeature(tx, 'sales_orders');
    const order = await loadOrder(tx, id);
    assertOutletAccess(order.outletId);
    return order;
  });
}

export async function listSaleOrders(query: ListSaleOrdersQuery) {
  if (query.outletId) assertOutletAccess(query.outletId);
  const page = parsePage(query);
  const rows = await withReadTransaction(async (tx) => {
    await assertFeature(tx, 'sales_orders');
    return salesOrdersRepository.list(
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
  return buildPage(rows, page.limit, (row: SaleOrderRow) => ({
    k: row.documentDate,
    id: row.id,
  }));
}

export function summarySaleOrders(query: SummarySaleOrdersQuery) {
  if (query.outletId) assertOutletAccess(query.outletId);
  return withReadTransaction(async (tx) => {
    await assertFeature(tx, 'sales_orders');
    return salesOrdersRepository.summary(tx, query.outletId, accessibleOutletIds());
  });
}

// --- Cancel / close / delete ---------------------------------------------------

async function fulfilledQuantity(tx: Tx, orderId: string): Promise<number> {
  const lines = await salesOrdersRepository.findLines(tx, orderId);
  return lines.reduce((sum, l) => sum + l.quantityFulfilled, 0);
}

/**
 * Deletes an order (soft: the number stays accounted for). Refused once anything has
 * been invoiced against it, since those invoices are real documents that name this
 * order. An advance that has not been used is paid back first, the way it was taken
 * unless [query.refundMode] says otherwise: it may already be in the bank, so
 * un-recording it would leave the drawer wrong.
 */
export function deleteSaleOrder(id: string, query: DeleteSaleOrderQuery = {}) {
  return withTransaction(async (tx) => {
    await assertFeature(tx, 'sales_orders');
    const order = await salesOrdersRepository.find(tx, id, true);
    if (!order) throw new NotFoundError('Sales order');
    assertOutletAccess(order.outletId);

    const fulfilled = await fulfilledQuantity(tx, id);
    if (fulfilled > 0) {
      throw new UnprocessableError(
        'Invoices have been raised against this order, so it cannot be deleted.',
        ErrorCode.ORDER_LINE_INVOICED,
        { details: { fulfilledQuantity: fulfilled } },
      );
    }

    const refund = await settleAdvance(tx, order, query.refundMode, true, 'Sales order deleted');
    await trackReservation(tx, id, () => salesOrdersRepository.softDelete(tx, id), false);
    await recordAudit(tx, {
      action: 'sales_order.deleted',
      entityType: 'sales_order',
      entityId: id,
      metadata: { documentNumber: order.documentNumber, refund },
    });
    return { refund };
  });
}

/**
 * Cancels an order and gives back its stock reservation. An advance that has not been
 * used is paid back the way it was taken, unless [body.refundMode] says otherwise
 * (`khata` leaves it as the customer's credit). Refused once invoiced: close it instead.
 */
export function cancelSaleOrder(id: string, body: CancelSaleOrderBody) {
  return withTransaction(async (tx) => {
    await assertFeature(tx, 'sales_orders');
    const order = await salesOrdersRepository.find(tx, id, true);
    if (!order) throw new NotFoundError('Sales order');
    assertOutletAccess(order.outletId);
    if (order.status === 'cancelled') {
      return { order: await loadOrder(tx, id), refund: null as AdvanceRefund | null };
    }

    const fulfilled = await fulfilledQuantity(tx, id);
    if (fulfilled > 0) {
      throw new UnprocessableError(
        'Invoices have been raised against this order, so it cannot be cancelled. Close it instead.',
        ErrorCode.ORDER_LINE_INVOICED,
        { details: { fulfilledQuantity: fulfilled } },
      );
    }

    await trackReservation(
      tx,
      id,
      () => salesOrdersRepository.cancel(tx, id, body.reason),
      false,
    );
    const refund = await settleAdvance(tx, order, body.refundMode, true, 'Sales order cancelled');
    await recordAudit(tx, {
      action: 'sales_order.cancelled',
      entityType: 'sales_order',
      entityId: id,
      metadata: { reason: body.reason, documentNumber: order.documentNumber, refund },
    });
    return { order: await loadOrder(tx, id), refund };
  });
}

/**
 * Closes an order by hand, e.g. the customer took less than they ordered. What was not
 * delivered stops being reserved. An unused advance stays as the customer's credit
 * unless [body.refundMode] pays it out.
 */
export function closeSaleOrder(id: string, body: CloseSaleOrderBody = {}) {
  return withTransaction(async (tx) => {
    await assertFeature(tx, 'sales_orders');
    const order = await salesOrdersRepository.find(tx, id, true);
    if (!order) throw new NotFoundError('Sales order');
    assertOutletAccess(order.outletId);
    assertNotCancelled(order);

    await trackReservation(
      tx,
      id,
      async () => {
        await salesOrdersRepository.setClosedManually(tx, id, true);
        await salesOrdersRepository.refreshStatus(tx, id);
      },
      false,
    );
    const refund = await settleAdvance(tx, order, body.refundMode, false, 'Sales order closed');
    await recordAudit(tx, {
      action: 'sales_order.closed',
      entityType: 'sales_order',
      entityId: id,
      metadata: { documentNumber: order.documentNumber, refund },
    });
    return { order: await loadOrder(tx, id), refund };
  });
}

// --- Called by invoices and credit notes ---------------------------------------

/**
 * Checks an invoice's claim on an order, with the lines locked so the figures cannot
 * move between the check and the write. Returns the locked order.
 *
 * [allowClosed] is for an amendment: the replacement invoice re-bills what its
 * credit note just took back, which must work even on an order closed by hand.
 */
export async function assertFulfilmentFits(
  tx: Tx,
  orderId: string,
  customerId: string | null,
  fulfilments: readonly { lineId: string; quantity: number }[],
  options: { allowClosed?: boolean } = {},
): Promise<SaleOrderRow> {
  const order = await salesOrdersRepository.find(tx, orderId, true);
  if (!order) throw new NotFoundError('Sales order');
  assertOutletAccess(order.outletId);
  assertNotCancelled(order);
  if (order.status === 'closed' && !options.allowClosed) {
    throw new UnprocessableError(
      'This sales order is closed and cannot be invoiced.',
      ErrorCode.SALES_ORDER_CLOSED,
    );
  }
  if (order.customerId && order.customerId !== customerId) {
    throw new UnprocessableError(
      'This invoice is for a different customer than the sales order.',
      ErrorCode.UNPROCESSABLE,
    );
  }

  const lines = new Map((await salesOrdersRepository.lockLines(tx, orderId)).map((l) => [l.id, l]));
  const claimed = new Map<string, number>();
  for (const f of fulfilments) {
    claimed.set(f.lineId, (claimed.get(f.lineId) ?? 0) + f.quantity);
  }
  for (const [lineId, quantity] of claimed) {
    const line = lines.get(lineId);
    if (!line) {
      throw new UnprocessableError(
        'That order line does not belong to this sales order.',
        ErrorCode.UNPROCESSABLE,
      );
    }
    const pending = line.quantity - line.quantityFulfilled;
    if (quantity > pending) {
      throw new UnprocessableError(
        'The quantity invoiced is more than what remains on the order.',
        ErrorCode.FULFILMENT_EXCEEDS_ORDER,
        { details: { lineId, pending, requested: quantity } },
      );
    }
  }
  return order;
}

export async function applyFulfilment(
  tx: Tx,
  orderId: string,
  fulfilments: readonly { lineId: string; quantity: number }[],
): Promise<void> {
  await trackReservation(
    tx,
    orderId,
    async () => {
      await salesOrdersRepository.applyFulfilment(tx, orderId, fulfilments);
      await salesOrdersRepository.refreshStatus(tx, orderId);
    },
    false,
  );
}

/** Called when an invoice that fulfilled part of an order is voided. */
export async function reverseFulfilment(tx: Tx, orderId: string, invoiceId: string): Promise<void> {
  await trackReservation(
    tx,
    orderId,
    async () => {
      await salesOrdersRepository.reverseFulfilment(tx, orderId, invoiceId);
      await salesOrdersRepository.refreshStatus(tx, orderId);
    },
    false,
  );
}

/** Called when a credit note takes goods back from an invoice that fulfilled an order. */
export async function reverseFulfilmentForCreditNote(
  tx: Tx,
  orderId: string,
  creditNoteId: string,
): Promise<void> {
  await trackReservation(
    tx,
    orderId,
    async () => {
      await salesOrdersRepository.reverseFulfilmentForCreditNote(tx, orderId, creditNoteId);
      await salesOrdersRepository.refreshStatus(tx, orderId);
    },
    false,
  );
}

/** Called when a credit note is voided: the return never happened. */
export async function reapplyFulfilmentForCreditNote(
  tx: Tx,
  orderId: string,
  creditNoteId: string,
): Promise<void> {
  await trackReservation(
    tx,
    orderId,
    async () => {
      await salesOrdersRepository.reapplyFulfilmentForCreditNote(tx, orderId, creditNoteId);
      await salesOrdersRepository.refreshStatus(tx, orderId);
    },
    false,
  );
}

/**
 * Counts the order's unused advance toward an invoice raised against it, up to what the
 * invoice still owes. The khata already nets the advance (it was a credit), so this
 * changes no ledger entry; it is what makes the invoice show it was paid.
 */
export async function applyAdvanceToInvoice(
  tx: Tx,
  order: SaleOrderRow,
  invoiceId: string,
  stillOwed: number,
): Promise<void> {
  if (!order.advancePaymentId || stillOwed <= 0) return;
  const state = await salesOrdersRepository.advanceState(tx, order.id);
  const amount = Math.min(state.remaining, stillOwed);
  if (amount <= 0) return;
  await paymentsRepository.insertAllocations(tx, [
    { paymentId: order.advancePaymentId, invoiceId, amount },
  ]);
}

// --- Reservation reconciliation ---------------------------------------------------

export interface ReservationDrift {
  outletId: string;
  itemId: string;
  expected: number;
  stored: number;
}

/**
 * Compares the reserved column with what the open orders' lines say it should be, and
 * optionally rewrites it. The incremental path keeps them equal; this exists to prove
 * that, and to repair a tenant if a bug ever let them part.
 */
export function reconcileReservations(options: { outletId?: string | undefined; repair: boolean }) {
  return withTransaction(async (tx) => {
    await assertFeature(tx, 'sales_orders');
    if (options.outletId) assertOutletAccess(options.outletId);
    const outletId = options.outletId ?? null;
    const key = (r: { outletId: string; itemId: string }) => `${r.outletId}:${r.itemId}`;
    const compare = async (): Promise<ReservationDrift[]> => {
      const expected = new Map(
        (await stockRepository.expectedReserved(tx, outletId)).map((r) => [key(r), r]),
      );
      const stored = new Map(
        (await stockRepository.storedReserved(tx, outletId)).map((r) => [key(r), r]),
      );
      const drift: ReservationDrift[] = [];
      for (const k of new Set([...expected.keys(), ...stored.keys()])) {
        const e = expected.get(k);
        const s = stored.get(k);
        const want = e?.reserved ?? 0;
        const have = s?.reserved ?? 0;
        if (want !== have) {
          const row = (e ?? s)!;
          drift.push({ outletId: row.outletId, itemId: row.itemId, expected: want, stored: have });
        }
      }
      return drift;
    };

    const drift = await compare();
    if (options.repair && drift.length > 0) {
      await stockRepository.repairReserved(tx, outletId);
      await recordAudit(tx, {
        action: 'stock.reservation_repaired',
        entityType: 'stock',
        entityId: randomUUID(),
        metadata: { rows: drift.length },
      });
    }
    return { drift, repaired: options.repair && drift.length > 0 };
  });
}
