import { z } from 'zod';
import { clientId } from '../../lib/ids.js';
import { pageQuery } from '../../lib/pagination.js';
import { isoDate, nonEmpty } from '../../lib/validators.js';
import { saleOrderBody } from '../sales-orders/sales-orders.schemas.js';

export const PROFORMA_INVOICE_STATUSES = ['open', 'converted', 'closed', 'cancelled'] as const;
export type ProformaInvoiceStatus = (typeof PROFORMA_INVOICE_STATUSES)[number];

/**
 * A proforma invoice has the same shape as a sales order, minus everything about money received
 * and stock promised: no advance, no payment mode, and no discount approvals (the shop's
 * discount policy is enforced when the proforma invoice becomes an order). `validUntil` takes the
 * place of the order's due date.
 */
export const proformaInvoiceBody = saleOrderBody
  .omit({
    dueDate: true,
    advanceAmount: true,
    paymentMode: true,
    discountApprovals: true,
    customFields: true,
  })
  .extend({
    /** The last day the quoted prices hold. */
    validUntil: isoDate.nullable().optional(),
  });

export const createProformaInvoiceBody = proformaInvoiceBody.extend({
  id: clientId,
  /**
   * A device that made this offline numbers it from a block leased to it, as an invoice does:
   * the series and sequence it used. Omitted, the server takes the next number.
   */
  seriesId: z.string().uuid().optional(),
  sequenceNo: z.number().int().positive().optional(),
});
export type CreateProformaInvoiceBody = z.infer<typeof createProformaInvoiceBody>;

export const updateProformaInvoiceBody = proformaInvoiceBody;
export type UpdateProformaInvoiceBody = z.infer<typeof updateProformaInvoiceBody>;

export const listProformaInvoicesQuery = pageQuery.extend({
  /** `closed` covers everything no longer open: converted, closed by hand and cancelled. */
  status: z.enum(['all', 'open', 'closed']).optional(),
  customerId: z.string().uuid().optional(),
  outletId: z.string().uuid().optional(),
  /** Matches the proforma invoice number, customer name or phone. */
  q: nonEmpty.max(80).optional(),
});
export type ListProformaInvoicesQuery = z.infer<typeof listProformaInvoicesQuery>;

export const summaryProformaInvoicesQuery = z.object({ outletId: z.string().uuid().optional() });
export type SummaryProformaInvoicesQuery = z.infer<typeof summaryProformaInvoicesQuery>;

export const cancelProformaInvoiceBody = z.object({ reason: nonEmpty.max(200) });
export type CancelProformaInvoiceBody = z.infer<typeof cancelProformaInvoiceBody>;
