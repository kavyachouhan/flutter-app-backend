import { z } from 'zod';
import { clientId } from '../../lib/ids.js';
import { nonEmpty } from '../../lib/validators.js';
import {
  createCategoryBody,
  createItemBody,
  updateCategoryBody,
  updateItemBody,
} from '../catalogue/catalogue.schemas.js';
import { createCustomerBody, updateCustomerBody } from '../customers/customers.schemas.js';
import { createInvoiceBody, voidInvoiceBody } from '../invoices/invoices.schemas.js';
import { createReceiptBody, voidPaymentBody } from '../payments/payments.schemas.js';
import { createAdjustmentBody } from '../stock/stock.schemas.js';

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
  'payment.create': createReceiptBody,
  'payment.void': withId(voidPaymentBody.shape),
  'customer.create': createCustomerBody,
  'customer.update': update(updateCustomerBody),
  'item.create': createItemBody,
  'item.update': update(updateItemBody),
  'category.create': createCategoryBody,
  'category.update': update(updateCategoryBody),
  'stock.adjust': createAdjustmentBody,
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
