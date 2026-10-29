import { z } from 'zod';
import { clientId } from '../../lib/ids.js';
import { pageQuery } from '../../lib/pagination.js';
import {
  nonEmpty,
  positivePaise,
  requireAccountForNonCashMode,
  timestamp,
} from '../../lib/validators.js';
import { TENDER_MODES } from '../invoices/invoices.schemas.js';

export const createReceiptBody = z
  .object({
    id: clientId,
    outletId: z.string().uuid(),
    customerId: z.string().uuid(),
    mode: z.enum(TENDER_MODES),
    amount: positivePaise,
    reference: nonEmpty.max(100).optional(),
    receivedAt: timestamp,
    /** Any unallocated remainder stays on the khata as an advance. */
    allocations: z
      .array(z.object({ invoiceId: z.string().uuid(), amount: positivePaise }))
      .optional(),
    /** Which Cash & Bank account this payment moved through; required unless mode is 'cash'. */
    accountId: z.string().uuid().optional(),
  })
  .superRefine(requireAccountForNonCashMode);
export type CreateReceiptBody = z.infer<typeof createReceiptBody>;

export const voidPaymentBody = z.object({ reason: nonEmpty });

export const listPaymentsQuery = pageQuery.extend({ customerId: z.string().uuid().optional() });
export type ListPaymentsQuery = z.infer<typeof listPaymentsQuery>;
