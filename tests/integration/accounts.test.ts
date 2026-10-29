/**
 * Cash & Bank. The two things worth proving end to end: the IFSC/account
 * number format checks actually reach the route (not just the validator in
 * isolation), and a brand new tenant's very first call does not 500 — it
 * once did, because listing accounts can lazily create Cash In-Hand, and
 * that insert was running inside a READ ONLY transaction.
 *
 * Further down: Phase 2, where a sale, an expense and a supplier payment
 * actually move money in this same ledger — the thing worth proving is the
 * round trip (forward write, then its void reverses exactly it, replay-safe
 * both ways), not every call site, since they all go through the one shared
 * recordDocumentMoney/voidDocumentMoney pair.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closeOwnerClient } from './setup/database.js';
import { createTenant, type TenantFixture } from './setup/tenant.js';
import { createItem, createSeries, invoicePayload, leaseBlock } from './setup/fixtures.js';
import { data, error, rows } from './setup/body.js';
import { closePool } from '../../src/db/pool.js';

interface Account {
  id: string;
  type: 'cash' | 'bank';
  name: string;
  bankName: string | null;
  accountNumber: string | null;
  ifsc: string | null;
  isDefaultCash: boolean;
  balance: number;
}

describe('accounts', () => {
  let t: TenantFixture;

  afterAll(async () => {
    await closeOwnerClient();
    await closePool();
  });

  it('a brand new tenant can list accounts on its very first call, and gets Cash In-Hand for free', async () => {
    t = await createTenant({ name: 'Cash Bank Shop' });
    const accounts = rows<Account>(await t.get('/v1/accounts').expect(200));
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ type: 'cash', isDefaultCash: true, balance: 0 });
  });

  it('accepts a real IFSC in any case, and normalizes it to upper case', async () => {
    const account = data<Account>(
      await t
        .post('/v1/accounts')
        .send({
          id: randomUUID(),
          name: 'HDFC Current',
          bankName: 'HDFC Bank',
          accountNumber: '123456789012',
          ifsc: 'hdfc0001234',
        })
        .expect(201),
    );
    expect(account.ifsc).toBe('HDFC0001234');
    expect(account.accountNumber).toBe('123456789012');
  });

  it('rejects an IFSC that is not 4 letters + 0 + 6 alphanumerics', async () => {
    const res = await t
      .post('/v1/accounts')
      .send({ id: randomUUID(), name: 'Bad IFSC Bank', ifsc: 'HDFC1001234' })
      .expect(400);
    expect(error(res).code).toBe('VALIDATION_FAILED');
  });

  it('rejects an account number outside the 9-18 digit sanity range', async () => {
    const tooShort = await t
      .post('/v1/accounts')
      .send({ id: randomUUID(), name: 'Too Short', accountNumber: '12345678' })
      .expect(400);
    expect(error(tooShort).code).toBe('VALIDATION_FAILED');

    const notDigits = await t
      .post('/v1/accounts')
      .send({ id: randomUUID(), name: 'Not Digits', accountNumber: '1234ABCD9012' })
      .expect(400);
    expect(error(notDigits).code).toBe('VALIDATION_FAILED');
  });

  async function cashAccountId(): Promise<string> {
    const accounts = rows<Account>(await t.get('/v1/accounts').expect(200));
    return accounts.find((a) => a.isDefaultCash)!.id;
  }

  async function balanceOf(accountId: string): Promise<number> {
    return data<Account>(await t.get(`/v1/accounts/${accountId}`).expect(200)).balance;
  }

  // Shared by both money-movement tests below: a tenant has only one invoice
  // series per outlet+counter+financial-year, so they cannot each create their own.
  let sharedSeriesId: string;

  it('a cash sale moves money into Cash In-Hand, replays without double-counting, and a void takes it back out', async () => {
    const item = await createItem(t);
    const series = await createSeries(t, { prefix: 'CA' });
    sharedSeriesId = series.id;
    await leaseBlock(t, series.id, 10);
    const cashId = await cashAccountId();
    const before = await balanceOf(cashId);

    const lines = [{ itemId: item.id, quantity: 1000, unitPrice: item.salePrice, taxRatePercent: item.taxRatePercent }];
    const paymentId = randomUUID();
    const body = invoicePayload(t, {
      seriesId: series.id,
      sequenceNo: 1,
      lines,
      payments: [{ id: paymentId, mode: 'cash', amount: 11800 }],
    });

    const invoice = data<{ id: string }>(await t.post('/v1/invoices').send(body).expect(201));
    expect(await balanceOf(cashId)).toBe(before + 11800);

    // A replayed create (same invoice id, same tender id) must not move the money twice.
    await t.post('/v1/invoices').send(body).expect(200);
    expect(await balanceOf(cashId)).toBe(before + 11800);

    await t.post(`/v1/invoices/${invoice.id}/void`).send({ reason: 'test cleanup' }).expect(200);
    expect(await balanceOf(cashId)).toBe(before);

    // Voiding twice must not reverse it twice either.
    await t.post(`/v1/invoices/${invoice.id}/void`).send({ reason: 'test cleanup again' }).expect(200);
    expect(await balanceOf(cashId)).toBe(before);
  });

  it('a cheque sale needs an account, and once given shows up in Cheques', async () => {
    const bank = data<Account>(
      await t
        .post('/v1/accounts')
        .send({ id: randomUUID(), name: 'Cheque Test Bank', ifsc: 'HDFC0001234' })
        .expect(201),
    );
    const item = await createItem(t);
    const lines = [{ itemId: item.id, quantity: 1000, unitPrice: item.salePrice, taxRatePercent: item.taxRatePercent }];

    const noAccount = invoicePayload(t, {
      seriesId: sharedSeriesId,
      sequenceNo: 2,
      lines,
      payments: [{ id: randomUUID(), mode: 'cheque', amount: 11800, reference: '000999' }],
    });
    const rejected = await t.post('/v1/invoices').send(noAccount).expect(400);
    expect(error(rejected).code).toBe('VALIDATION_FAILED');

    const before = await balanceOf(bank.id);
    const withAccount = invoicePayload(t, {
      seriesId: sharedSeriesId,
      sequenceNo: 2,
      lines,
      payments: [
        { id: randomUUID(), mode: 'cheque', amount: 11800, accountId: bank.id, reference: '000999' },
      ],
    });
    await t.post('/v1/invoices').send(withAccount).expect(201);
    expect(await balanceOf(bank.id)).toBe(before + 11800);

    const cheques = rows<{ accountName: string; chequeNumber: string; amount: number }>(
      await t.get('/v1/accounts/cheques').expect(200),
    );
    const mine = cheques.find((c) => c.chequeNumber === '000999');
    expect(mine).toMatchObject({ accountName: 'Cheque Test Bank', amount: 11800 });
  });

  it('an expense takes money out of Cash In-Hand, and a void gives it back', async () => {
    const cashId = await cashAccountId();
    const before = await balanceOf(cashId);

    const expense = data<{ id: string }>(
      await t
        .post('/v1/expenses')
        .send({
          id: randomUUID(),
          outletId: t.outletId,
          amount: 5000,
          mode: 'cash',
          note: 'Tea for the shop',
          spentAt: new Date().toISOString(),
        })
        .expect(201),
    );
    expect(await balanceOf(cashId)).toBe(before - 5000);

    await t.post(`/v1/expenses/${expense.id}/void`).send({ reason: 'test cleanup' }).expect(200);
    expect(await balanceOf(cashId)).toBe(before);
  });
});
