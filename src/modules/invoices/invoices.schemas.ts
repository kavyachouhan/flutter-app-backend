import { z } from 'zod';
import { clientId } from '../../lib/ids.js';
import { pageQuery } from '../../lib/pagination.js';
import {
  hsnCode,
  isoDate,
  nonEmpty,
  paise,
  positivePaise,
  quantity,
  stateCode,
  timestamp,
} from '../../lib/validators.js';

export const discount = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('amount'), value: paise }),
  z.object({ kind: z.literal('percent'), value: z.number().min(0).max(100) }),
]);

const line = z
  .object({
    id: clientId,
    itemId: z.string().uuid().nullable().optional(),
    /** Required for an ad-hoc line with no catalogue item. */
    itemName: nonEmpty.optional(),
    hsnCode: hsnCode.optional(),
    unit: nonEmpty.optional(),
    quantity,
    unitPrice: paise,
    discount: discount.optional(),
    // Validated by the tax engine against the tenant's tax mode rather than here.
    taxRatePercent: z.number().nonnegative(),
    cessRatePercent: z.number().nonnegative().optional(),
  })
  .refine((l) => l.itemId || l.itemName, {
    message: 'itemName is required without itemId',
    path: ['itemName'],
  });

const additionalCharge = z.object({
  id: nonEmpty,
  label: nonEmpty,
  amount: paise,
  taxable: z.boolean(),
  taxRatePercent: z.number().nonnegative().optional(),
});

export const TENDER_MODES = ['cash', 'card', 'upi', 'wallet', 'bank_transfer', 'cheque'] as const;

const tender = z.object({
  id: clientId,
  mode: z.enum(TENDER_MODES),
  amount: positivePaise,
  tenderedAmount: paise.optional(),
  reference: nonEmpty.optional(),
});

export const createInvoiceBody = z.object({
  id: clientId,
  outletId: z.string().uuid(),
  counterId: z.string().uuid().nullable().optional(),
  seriesId: z.string().uuid(),
  sequenceNo: z.number().int().positive().refine(Number.isSafeInteger),
  documentDate: isoDate,
  issuedAt: timestamp,
  customerId: z.string().uuid().nullable().optional(),
  placeOfSupplyStateCode: stateCode.optional(),
  pricesIncludeTax: z.boolean(),
  roundOff: z.boolean(),
  lines: z.array(line).nonempty(),
  billDiscount: discount.optional(),
  additionalCharges: z.array(additionalCharge).optional(),
  /** Paid at billing. Whatever is left of the total goes to the customer's khata. */
  payments: z.array(tender).optional(),
  notes: nonEmpty.optional(),
  /** The device's own computation, re-checked on the server. */
  expectedTotals: z.object({
    grandTotal: z.number().int(),
    totalTax: z.number().int(),
    taxableAmount: z.number().int(),
  }),
});
export type CreateInvoiceBody = z.infer<typeof createInvoiceBody>;

export const voidInvoiceBody = z.object({ reason: nonEmpty });

export const listInvoicesQuery = pageQuery.extend({
  from: isoDate.optional(),
  to: isoDate.optional(),
  status: z.enum(['issued', 'void']).optional(),
  customerId: z.string().uuid().optional(),
  outletId: z.string().uuid().optional(),
});
export type ListInvoicesQuery = z.infer<typeof listInvoicesQuery>;
