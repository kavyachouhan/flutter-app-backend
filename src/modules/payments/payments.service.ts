import { recordDocumentMoney, voidDocumentMoney } from '../accounts/accounts.service.js';
import { withReadTransaction, withTransaction, type Tx } from '../../db/tx.js';
import { requireAuthContext } from '../../lib/context.js';
import { ErrorCode, NotFoundError, UnprocessableError, ValidationError } from '../../lib/errors.js';
import { buildPage, parsePage } from '../../lib/pagination.js';
import { assertOutletAccess } from '../../middleware/authorize.js';
import { recordAudit } from '../audit/audit.js';
import { customersRepository } from '../customers/customers.repository.js';
import { outletsRepository } from '../outlets/outlets.repository.js';
import { paymentsRepository } from './payments.repository.js';
import type {
  AllocateReceiptBody,
  CreateReceiptBody,
  ListPaymentsQuery,
} from './payments.schemas.js';

async function loadPayment(tx: Tx, id: string) {
  const payment = await paymentsRepository.find(tx, id);
  if (!payment) throw new NotFoundError('Payment');
  return { ...payment, allocations: await paymentsRepository.findAllocations(tx, id) };
}

/**
 * Checks allocations of a customer's money to invoices: each invoice once, the customer's own,
 * not void, not more than is outstanding, and the total within `available`. Invoices are locked
 * (in id order) so two allocations to the same invoice cannot both pass.
 */
async function checkAllocations(
  tx: Tx,
  customerId: string,
  allocations: readonly { invoiceId: string; amount: number }[],
  available: number,
): Promise<void> {
  const invoiceIds = allocations.map((a) => a.invoiceId);
  if (new Set(invoiceIds).size !== invoiceIds.length) {
    throw new ValidationError('An invoice can appear only once in a receipt.');
  }
  if (allocations.reduce((acc, a) => acc + a.amount, 0) > available) {
    throw new UnprocessableError('Allocations exceed the amount received.', ErrorCode.OVERPAYMENT, {
      details: { available },
    });
  }
  if (invoiceIds.length === 0) return;

  const invoices = new Map(
    (await paymentsRepository.lockInvoices(tx, invoiceIds)).map((i) => [i.id, i]),
  );
  const outstanding = await paymentsRepository.outstandingByInvoice(tx, invoiceIds);
  for (const allocation of allocations) {
    const invoice = invoices.get(allocation.invoiceId);
    if (!invoice) throw new NotFoundError('Invoice');
    if (invoice.customerId !== customerId) {
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

/**
 * Settles invoices from the unallocated part of an existing receipt: money taken as an advance
 * (or more than was owed at the time) and kept on the khata. Only the link to the invoices is
 * added. The receipt and the customer's ledger already hold the money, so no ledger entry or
 * account movement is written. An invoice already settled from this receipt cannot be added
 * again; a receipt's allocations are never edited.
 */
export function allocateReceipt(id: string, body: AllocateReceiptBody) {
  return withTransaction(async (tx) => {
    const payment = await paymentsRepository.find(tx, id, true);
    if (!payment) throw new NotFoundError('Payment');
    assertOutletAccess(payment.outletId);
    if (payment.kind !== 'receipt' || payment.customerId === null) {
      throw new UnprocessableError(
        'Only a khata receipt can be allocated to invoices later.',
        ErrorCode.UNPROCESSABLE,
      );
    }
    if (payment.status !== 'issued') {
      throw new UnprocessableError('This receipt is void.', ErrorCode.UNPROCESSABLE);
    }
    const existing = await paymentsRepository.findAllocations(tx, id);
    const already = new Set(existing.map((a) => a.invoiceId));
    const repeated = body.allocations.find((a) => already.has(a.invoiceId));
    if (repeated) {
      throw new UnprocessableError(
        'This receipt is already allocated to that invoice.',
        ErrorCode.UNPROCESSABLE,
        { details: { invoiceId: repeated.invoiceId } },
      );
    }
    const unallocated =
      Number(payment.amount) - existing.reduce((s, a) => s + Number(a.amount), 0);
    await checkAllocations(tx, payment.customerId, body.allocations, unallocated);

    await paymentsRepository.insertAllocations(
      tx,
      body.allocations.map((a) => ({ paymentId: id, invoiceId: a.invoiceId, amount: a.amount })),
    );
    await recordAudit(tx, {
      action: 'payment.allocated',
      entityType: 'payment',
      entityId: id,
      metadata: {
        customerId: payment.customerId,
        allocations: body.allocations.map((a) => ({ invoiceId: a.invoiceId, amount: a.amount })),
        unallocatedBefore: unallocated,
      },
    });
    return loadPayment(tx, id);
  });
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
    await checkAllocations(tx, body.customerId, allocations, body.amount);

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
    await recordDocumentMoney(tx, {
      accountId: body.mode === 'cash' ? null : (body.accountId ?? null),
      amount: body.amount,
      transactionType: 'receipt',
      sourceType: 'receipt',
      sourceId: body.id,
      chequeNumber: body.mode === 'cheque' ? (body.reference ?? null) : null,
      chequeDate: body.mode === 'cheque' ? body.receivedAt.slice(0, 10) : null,
      note: body.reference ?? null,
      occurredAt: body.receivedAt,
    });
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

    await recordAudit(tx, {
      action: 'payment.received',
      entityType: 'payment',
      entityId: body.id,
      metadata: { amount: body.amount, mode: body.mode, customerId: body.customerId },
    });

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
      throw new UnprocessableError(
        'Tenders and refunds are voided by voiding the invoice or credit note they belong to.',
      );
    }
    if (payment.status === 'void') return loadPayment(tx, id);

    await paymentsRepository.markVoid(tx, id, reason, auth.userId);
    await voidDocumentMoney(tx, 'receipt', id, 'receipt');
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
