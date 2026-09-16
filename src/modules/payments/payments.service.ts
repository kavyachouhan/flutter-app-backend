import { withReadTransaction, withTransaction, type Tx } from '../../db/tx.js';
import { requireAuthContext } from '../../lib/context.js';
import { ErrorCode, NotFoundError, UnprocessableError, ValidationError } from '../../lib/errors.js';
import { buildPage, parsePage } from '../../lib/pagination.js';
import { assertOutletAccess } from '../../middleware/authorize.js';
import { recordAudit } from '../audit/audit.js';
import { customersRepository } from '../customers/customers.repository.js';
import { outletsRepository } from '../outlets/outlets.repository.js';
import { paymentsRepository } from './payments.repository.js';
import type { CreateReceiptBody, ListPaymentsQuery } from './payments.schemas.js';

async function loadPayment(tx: Tx, id: string) {
  const payment = await paymentsRepository.find(tx, id);
  if (!payment) throw new NotFoundError('Payment');
  return { ...payment, allocations: await paymentsRepository.findAllocations(tx, id) };
}

/** A khata collection: credits the customer's ledger and optionally settles specific invoices. */
export function createReceipt(body: CreateReceiptBody) {
  const auth = requireAuthContext();
  assertOutletAccess(body.outletId);

  return withTransaction(async (tx) => {
    if (await paymentsRepository.exists(tx, body.id)) return loadPayment(tx, body.id);

    if (!(await outletsRepository.findOutlet(tx, body.outletId))) throw new NotFoundError('Outlet');
    if (!(await customersRepository.find(tx, body.customerId, true)))
      throw new NotFoundError('Customer');

    const allocations = body.allocations ?? [];
    const invoiceIds = allocations.map((a) => a.invoiceId);
    if (new Set(invoiceIds).size !== invoiceIds.length) {
      throw new ValidationError('An invoice can appear only once in a receipt.');
    }
    if (allocations.reduce((acc, a) => acc + a.amount, 0) > body.amount) {
      throw new UnprocessableError(
        'Allocations exceed the amount received.',
        ErrorCode.OVERPAYMENT,
      );
    }

    if (invoiceIds.length > 0) {
      const invoices = new Map(
        (await paymentsRepository.lockInvoices(tx, invoiceIds)).map((i) => [i.id, i]),
      );
      const outstanding = await paymentsRepository.outstandingByInvoice(tx, invoiceIds);

      for (const allocation of allocations) {
        const invoice = invoices.get(allocation.invoiceId);
        if (!invoice) throw new NotFoundError('Invoice');
        if (invoice.customerId !== body.customerId) {
          throw new ValidationError('An allocated invoice belongs to a different customer.', {
            details: { invoiceId: allocation.invoiceId },
          });
        }
        if (invoice.status !== 'issued') {
          throw new UnprocessableError('Cannot allocate a receipt to a void invoice.', undefined, {
            details: { invoiceId: allocation.invoiceId },
          });
        }
        if (allocation.amount > (outstanding.get(allocation.invoiceId) ?? 0)) {
          throw new UnprocessableError(
            'An allocation exceeds what is outstanding on the invoice.',
            ErrorCode.OVERPAYMENT,
            {
              details: {
                invoiceId: allocation.invoiceId,
                outstanding: outstanding.get(allocation.invoiceId),
              },
            },
          );
        }
      }
    }

    await paymentsRepository.insertReceipt(tx, {
      id: body.id,
      outletId: body.outletId,
      customerId: body.customerId,
      mode: body.mode,
      amount: body.amount,
      reference: body.reference ?? null,
      receivedAt: body.receivedAt,
      receivedBy: auth.userId,
    });
    await paymentsRepository.insertAllocations(
      tx,
      allocations.map((a) => ({ paymentId: body.id, invoiceId: a.invoiceId, amount: a.amount })),
    );
    await customersRepository.insertLedgerEntries(tx, [
      {
        customerId: body.customerId,
        entryType: 'payment',
        debit: 0,
        credit: body.amount,
        referenceType: 'payment',
        referenceId: body.id,
        occurredAt: body.receivedAt,
        note: body.reference ?? null,
        createdBy: auth.userId,
      },
    ]);

    return loadPayment(tx, body.id);
  });
}

export function getPayment(id: string) {
  return withReadTransaction(async (tx) => {
    const payment = await loadPayment(tx, id);
    assertOutletAccess(payment.outletId);
    return payment;
  });
}

export async function listPayments(query: ListPaymentsQuery) {
  const page = parsePage(query);
  const rows = await withReadTransaction((tx) =>
    paymentsRepository.list(tx, query.customerId, page.limit, page.cursor),
  );
  return buildPage(rows, page.limit, (row) => ({ k: row.receivedAt.toISOString(), id: row.id }));
}

/** Tenders taken at billing are voided with their invoice, never on their own. */
export function voidReceipt(id: string, reason: string) {
  const auth = requireAuthContext();

  return withTransaction(async (tx) => {
    const payment = await paymentsRepository.find(tx, id, true);
    if (!payment) throw new NotFoundError('Payment');
    assertOutletAccess(payment.outletId);
    if (payment.kind !== 'receipt') {
      throw new UnprocessableError('Payments taken at billing are voided by voiding the invoice.');
    }
    if (payment.status === 'void') return loadPayment(tx, id);

    await paymentsRepository.markVoid(tx, id, reason, auth.userId);
    if (payment.customerId) {
      await customersRepository.insertLedgerEntries(tx, [
        {
          customerId: payment.customerId,
          entryType: 'payment_void',
          debit: payment.amount,
          credit: 0,
          referenceType: 'payment',
          referenceId: id,
          occurredAt: new Date().toISOString(),
          note: reason,
          createdBy: auth.userId,
        },
      ]);
    }
    await recordAudit(tx, {
      action: 'payment.voided',
      entityType: 'payment',
      entityId: id,
      metadata: { reason },
    });
    return loadPayment(tx, id);
  });
}
