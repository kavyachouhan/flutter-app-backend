import { z } from 'zod';
import { clientId } from '../../lib/ids.js';
import { nonEmpty } from '../../lib/validators.js';
import {
  createCategoryBody,
  createItemBody,
  updateCategoryBody,
  updateItemBody,
} from '../catalogue/catalogue.schemas.js';
import { createCreditNoteBody } from '../credit-notes/credit-notes.schemas.js';
import {
  cancelEstimateBody,
  convertEstimateOperation,
  createEstimateBody,
  updateEstimateBody,
} from '../estimates/estimates.schemas.js';
import {
  cancelProformaInvoiceBody,
  createProformaInvoiceBody,
  updateProformaInvoiceBody,
} from '../proforma-invoices/proforma-invoices.schemas.js';
import { createCustomerBody, updateCustomerBody } from '../customers/customers.schemas.js';
import { createInvoiceBody, voidInvoiceBody } from '../invoices/invoices.schemas.js';
import { createReceiptBody, voidPaymentBody } from '../payments/payments.schemas.js';
import {
  cancelPurchaseOrderBody,
  createPurchaseOrderBody,
  updatePurchaseOrderBody,
} from '../purchases/purchases.schemas.js';
import {
  cancelSaleOrderBody,
  createSaleOrderBody,
  deleteSaleOrderQuery,
  updateSaleOrderBody,
} from '../sales-orders/sales-orders.schemas.js';
import {
  createDayCloseBody,
  createExpenseBody,
  releaseHeldBillBody,
  upsertHeldBillBody,
  voidExpenseBody,
} from '../operations/operations.schemas.js';
import { createAdjustmentBody } from '../stock/stock.schemas.js';
import { createSupplierBody, updateSupplierBody } from '../suppliers/suppliers.schemas.js';
import { createTermsBody, updateTermsBody } from '../terms/terms.schemas.js';

export const pullQuery = z.object({
  /** The highest serverSeq the device has applied; 0 on first sync. */
  since: z.coerce.number().int().nonnegative(),
  limit: z.coerce.number().int().positive().optional(),
});
export type PullQuery = z.infer<typeof pullQuery>;

const withId = <T extends z.ZodRawShape>(shape: T) => z.object({ id: z.string().uuid(), ...shape });
const update = <T extends z.ZodTypeAny>(patch: T) => z.object({ id: z.string().uuid(), patch });

/**
 * Every operation a device may queue while offline, with the exact body the
 * matching REST endpoint validates. Adding a type means adding it here, in
 * OPERATION_PERMISSIONS and in the dispatcher — the type system enforces all
 * three.
 */
export const OPERATION_PAYLOADS = {
  'invoice.create': createInvoiceBody,
  'invoice.void': withId({ reason: nonEmpty }),
  'invoice.printed': withId({}),
  'credit_note.create': createCreditNoteBody,
  'credit_note.void': withId({ reason: nonEmpty }),
  'credit_note.printed': withId({}),
  'payment.create': createReceiptBody,
  'payment.void': withId(voidPaymentBody.shape),
  'customer.create': createCustomerBody,
  'customer.update': update(updateCustomerBody),
  'item.create': createItemBody,
  'item.update': update(updateItemBody),
  'category.create': createCategoryBody,
  'category.update': update(updateCategoryBody),
  'terms.create': createTermsBody,
  'terms.update': update(updateTermsBody),
  'terms.delete': withId({}),
  'stock.adjust': createAdjustmentBody,
  'held_bill.upsert': upsertHeldBillBody,
  'held_bill.release': z.object({ id: z.string().uuid(), ...releaseHeldBillBody.shape }),
  'expense.create': createExpenseBody,
  'expense.void': withId(voidExpenseBody.shape),
  'day_close.create': createDayCloseBody,
  'supplier.create': createSupplierBody,
  'supplier.update': update(updateSupplierBody),
  'supplier.delete': withId({}),
  // An edit sends the whole document, as the REST PUT does, plus the id of what it edits.
  'estimate.create': createEstimateBody,
  'estimate.update': updateEstimateBody.extend({ id: z.string().uuid() }),
  'estimate.delete': withId({}),
  'estimate.cancel': withId(cancelEstimateBody.shape),
  'estimate.close': withId({}),
  'estimate.convert': convertEstimateOperation,
  'proforma_invoice.create': createProformaInvoiceBody,
  'proforma_invoice.update': updateProformaInvoiceBody.extend({ id: z.string().uuid() }),
  'proforma_invoice.delete': withId({}),
  'proforma_invoice.cancel': withId(cancelProformaInvoiceBody.shape),
  'proforma_invoice.close': withId({}),
  'sale_order.create': createSaleOrderBody,
  'sale_order.update': updateSaleOrderBody.extend({ id: z.string().uuid() }),
  'sale_order.delete': withId(deleteSaleOrderQuery.shape),
  'sale_order.cancel': withId(cancelSaleOrderBody.shape),
  'sale_order.close': withId(deleteSaleOrderQuery.shape),
  'purchase_order.create': createPurchaseOrderBody,
  'purchase_order.update': updatePurchaseOrderBody.extend({ id: z.string().uuid() }),
  'purchase_order.delete': withId({}),
  'purchase_order.cancel': withId(cancelPurchaseOrderBody.shape),
} as const;
void voidInvoiceBody;

export type OperationType = keyof typeof OPERATION_PAYLOADS;
export const OPERATION_TYPES = Object.keys(OPERATION_PAYLOADS) as [
  OperationType,
  ...OperationType[],
];

export const pushOperation = z.object({
  /** Client-generated, unique per operation; the client's own retry key. */
  opId: clientId,
  type: z.enum(OPERATION_TYPES),
  /** Validated against the schema for `type` inside the service, so one bad operation rejects only itself. */
  payload: z.unknown(),
  /** For updates: the serverSeq of the row the device edited. A newer row on the server rejects with STALE_WRITE. */
  baseServerSeq: z.number().int().nonnegative().optional(),
});
export type PushOperation = z.infer<typeof pushOperation>;

export const pushBody = z.object({ operations: z.array(pushOperation).min(1) });
export type PushBody = z.infer<typeof pushBody>;
