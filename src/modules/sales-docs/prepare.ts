/**
 * What every sales document shares: invoices and sales orders are priced, taxed
 * and discount-checked here, once.
 *
 * The two documents used to carry their own copy of this logic. They differ in
 * policy (an invoice is already a sale, so what a device could not know is a
 * warning; an order is typed online, so it is a rejection) but not in
 * arithmetic, and two copies of arithmetic drift. Each caller keeps its own
 * policy; the maths, the totals check and the discount rules live only here.
 */
import { env } from '../../config/env.js';
import type { Tx } from '../../db/tx.js';
import { capBreaches, type CapBreach } from '../../domain/pricing/resolve.js';
import { costOfGoodsSold } from '../../domain/costing/moving-average.js';
import { computeInvoice } from '../../domain/tax/engine.js';
import type {
  AdditionalCharge,
  Discount,
  SupplyCategory,
  SupplyType,
  TaxInvoiceResult,
  TaxMode,
} from '../../domain/tax/types.js';
import { ConflictError, ErrorCode, NotFoundError, UnprocessableError } from '../../lib/errors.js';
import { hasPermission, type Permission } from '../auth/permissions.js';
import type { CustomerRow } from '../customers/customers.repository.js';
import {
  invoicesRepository,
  type InvoiceItemRow,
} from '../invoices/invoices.repository.js';
import { membersRepository } from '../members/members.repository.js';
import type { OutletRow } from '../outlets/outlets.repository.js';
import { effectivePolicyFor } from '../price-lists/price-lists.service.js';
import { purchasesRepository } from '../purchases/purchases.repository.js';
import type { TenantSettings } from '../tenants/tenants.repository.js';

export function taxModeFor(settings: TenantSettings): TaxMode {
  if (!settings.isGstRegistered) return 'non_gst';
  return settings.isComposition ? 'composition' : 'gst';
}

/** The fields of a line that decide its price and tax, whichever document carries it. */
export interface SaleLine {
  id: string;
  itemId?: string | null | undefined;
  quantity: number;
  unitPrice: number;
  taxRatePercent: number;
  cessRatePercent?: number | undefined;
  discount?: Discount | undefined;
  hsnCode?: string | undefined;
  supplyCategory?: SupplyCategory | undefined;
}

export interface SaleItems {
  readonly byId: ReadonlyMap<string, InvoiceItemRow>;
  itemFor(itemId: string | null | undefined): InvoiceItemRow | undefined;
}

/**
 * Resolves the catalogue rows behind a document's lines. Deleted items are
 * included on purpose: an item removed after an offline sale must not block
 * that sale from uploading. Returns the ids that were not found, and lets the
 * caller choose how loudly to object.
 */
export async function loadSaleItems(
  tx: Tx,
  lines: readonly SaleLine[],
): Promise<{ items: SaleItems; unknown: string[] }> {
  const itemIds = [...new Set(lines.flatMap((l) => (l.itemId ? [l.itemId] : [])))];
  const byId = new Map(
    (await invoicesRepository.findItems(tx, itemIds)).map((item) => [item.id, item]),
  );
  return {
    items: { byId, itemFor: (itemId) => (itemId ? byId.get(itemId) : undefined) },
    unknown: itemIds.filter((id) => !byId.has(id)),
  };
}

export interface SaleTotalsInput {
  settings: TenantSettings;
  outlet: OutletRow;
  customer: CustomerRow | undefined;
  items: SaleItems;
  placeOfSupplyStateCode?: string | null | undefined;
  supplyType?: SupplyType | undefined;
  isReverseCharge?: boolean | undefined;
  pricesIncludeTax: boolean;
  roundOff: boolean;
  billDiscount?: Discount | undefined;
  additionalCharges?: readonly AdditionalCharge[] | undefined;
  lines: readonly SaleLine[];
}

/**
 * The totals, by the same engine every device runs. A line's own HSN and supply
 * category win over the catalogue's, because a till may know something the
 * catalogue does not: the same good sold exempt to one buyer and taxable to
 * another.
 */
export function computeSaleTotals(input: SaleTotalsInput): TaxInvoiceResult {
  const { settings, outlet, customer, items } = input;
  return computeInvoice(
    {
      mode: taxModeFor(settings),
      supplierStateCode: outlet.stateCode ?? settings.stateCode,
      placeOfSupplyStateCode: input.placeOfSupplyStateCode ?? customer?.stateCode ?? undefined,
      supplyType: input.supplyType,
      isReverseCharge: input.isReverseCharge,
      pricesIncludeTax: input.pricesIncludeTax,
      roundOff: input.roundOff,
      billDiscount: input.billDiscount,
      additionalCharges: input.additionalCharges,
      lines: input.lines.map((l) => ({
        id: l.id,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        taxRatePercent: l.taxRatePercent,
        cessRatePercent: l.cessRatePercent,
        discount: l.discount,
        hsnCode: l.hsnCode ?? items.itemFor(l.itemId)?.hsnCode ?? undefined,
        supplyCategory:
          l.supplyCategory ?? items.itemFor(l.itemId)?.supplyCategory ?? ('taxable' as const),
      })),
    },
    { allowedGstRates: env.GST_ALLOWED_RATES },
  );
}

export interface ExpectedTotals {
  grandTotal: number;
  totalTax: number;
  taxableAmount: number;
}

/**
 * Both sides run the same engine, so a mismatch is a client bug or a tampered
 * payload; silently storing either figure would be wrong.
 */
export function assertTotalsMatch(
  totals: Pick<TaxInvoiceResult, 'grandTotal' | 'totalTax' | 'taxableAmount'>,
  expected: ExpectedTotals,
  documentName: string,
): void {
  const server = {
    grandTotal: totals.grandTotal,
    totalTax: totals.totalTax,
    taxableAmount: totals.taxableAmount,
  };
  if (
    expected.grandTotal !== server.grandTotal ||
    expected.totalTax !== server.totalTax ||
    expected.taxableAmount !== server.taxableAmount
  ) {
    throw new ConflictError(
      `${documentName} totals do not match the server calculation.`,
      ErrorCode.TOTALS_MISMATCH,
      { details: { client: expected, server } },
    );
  }
}

export interface DiscountEvaluation {
  breaches: CapBreach[];
  approverPermission: string;
}

/**
 * Runs the shop's discount policy over a priced document. Percentages are of
 * gross (the ticket price); margin is checked against average cost. Returns the
 * breaches and who may approve them: whether a breach is a warning or a refusal
 * is the caller's policy.
 */
export async function evaluateDiscountCaps(
  tx: Tx,
  input: {
    outletId: string;
    totals: TaxInvoiceResult;
    lines: readonly SaleLine[];
    costs?: ReadonlyMap<string, number>;
  },
): Promise<DiscountEvaluation> {
  const { policy, approverPermission } = await effectivePolicyFor(tx, input.outletId);
  const costs =
    input.costs ??
    (await purchasesRepository.costsFor(
      tx,
      input.outletId,
      input.lines.flatMap((l) => (l.itemId ? [l.itemId] : [])),
    ));
  const breaches = capBreaches({
    policy,
    grossAmount: input.totals.grossAmount,
    billDiscount: input.totals.billDiscount,
    lines: input.totals.lines.map((line, index) => {
      const source = input.lines[index];
      const avgCost = source?.itemId ? costs.get(source.itemId) : undefined;
      return {
        id: line.id,
        grossAmount: line.grossAmount,
        lineDiscount: line.lineDiscount,
        billDiscountShare: line.apportionedBillDiscount,
        costAmount:
          avgCost === undefined || !source ? undefined : costOfGoodsSold(avgCost, source.quantity),
      };
    }),
  });
  return { breaches, approverPermission };
}

export interface ApprovalInput {
  id: string;
  invoiceLineId?: string | undefined;
  breachKind: string;
  requestedValue: number;
  allowedValue: number;
  approvedBy: string;
  reason?: string | undefined;
  approvedAt: string;
}

/**
 * Checks each named approver is an active member holding the permission the
 * policy requires. Rejected, never warned about: an approval from someone not
 * entitled to give it is not evidence of anything, and storing it would make
 * the audit trail assert something untrue.
 */
export async function resolveApprovers(
  tx: Tx,
  approvals: readonly ApprovalInput[],
  approverPermission: string,
): Promise<{ approval: ApprovalInput; role: string }[]> {
  const resolved: { approval: ApprovalInput; role: string }[] = [];
  for (const approval of approvals) {
    const approver = await membersRepository.findByUser(tx, approval.approvedBy);
    if (!approver?.isActive || !hasPermission(approver.role, approverPermission as Permission)) {
      throw new UnprocessableError(
        'The named approver cannot authorise a discount.',
        ErrorCode.APPROVER_NOT_PERMITTED,
        { details: { approvedBy: approval.approvedBy, required: approverPermission } },
      );
    }
    // The role at the time. Memberships change, and "was this person entitled to
    // approve it then" has to stay answerable afterwards.
    resolved.push({ approval, role: approver.role });
  }
  return resolved;
}

/** Breaches that no accompanying approval covers. */
export function unapprovedBreaches(
  breaches: readonly CapBreach[],
  approvedKinds: ReadonlySet<string>,
): CapBreach[] {
  return breaches.filter((breach) => !approvedKinds.has(breach.kind));
}

/**
 * The lines whose price differs from what the customer's price list says. Reported,
 * never corrected: rewriting the figure would make the stored document disagree with
 * the one the customer is holding.
 */
export function mispricedLines(
  expected: ReadonlyMap<
    string,
    { unitPrice: number; source: string; priceListId?: string | null | undefined }
  >,
  lines: readonly { id: string; unitPrice: number }[],
) {
  return lines.flatMap((line) => {
    const e = expected.get(line.id);
    if (!e || e.unitPrice === line.unitPrice) return [];
    return [
      {
        lineId: line.id,
        charged: line.unitPrice,
        expected: e.unitPrice,
        source: e.source,
        priceListId: e.priceListId ?? null,
      },
    ];
  });
}

/** Throws the standard "unknown items" error for orders and purchases, which refuse them. */
export function assertItemsKnown(unknown: readonly string[]): void {
  if (unknown.length > 0) throw new NotFoundError('Item', { details: { itemIds: unknown } });
}
