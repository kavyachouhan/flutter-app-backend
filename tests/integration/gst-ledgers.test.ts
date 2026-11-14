/* eslint-disable @typescript-eslint/no-explicit-any -- the API bodies are walked untyped */
/**
 * GSTN ledger import through the real API, and GSTR-9 reading it back: credit reclaimed (6H) comes
 * from the credit reversal ledger, tax paid stays unknown while no classification rule is checked.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeOwnerClient } from './setup/database.js';
import { createTenant, type TenantFixture } from './setup/tenant.js';
import { fyStartYear } from './setup/fixtures.js';
import { data } from './setup/body.js';
import { closePool } from '../../src/db/pool.js';
import { gstinCheckCharacter } from '../../src/domain/gst/gstin.js';

function validGstin(state: string): string {
  const letters = randomUUID()
    .replace(/[^a-f]/g, '')
    .toUpperCase()
    .padEnd(5, 'A')
    .slice(0, 5);
  const digits = String(Math.floor(Math.random() * 10_000)).padStart(4, '0');
  const first14 = `${state}${letters}${digits}B1Z`;
  return first14 + gstinCheckCharacter(first14);
}

const four = (cgst = 0, sgst = 0, igst = 0, cess = 0) => ({ igst, cgst, sgst, cess });

interface LedgerImport {
  id: string;
  kind: string;
  entryCount: number;
  newEntryCount: number;
  periodFrom: string;
  periodTo: string;
}

describe('GSTN ledgers', () => {
  let shop: TenantFixture;
  let gstin: string;
  const start = fyStartYear();

  // A credit reversal and re-claim ledger, shaped as the official response schema.
  const itcLedger = (gst: string, rows: Record<string, unknown>[]) => ({
    gstin: gst,
    frdt: `01/04/${start}`,
    todt: `31/03/${start + 1}`,
    opnbal: four(),
    tr: rows,
    clsbal: four(),
  });
  const itcRow = (
    ref: string,
    rtnprd: string,
    date: string,
    over: { reversed?: ReturnType<typeof four>; reclaimed?: ReturnType<typeof four> } = {},
  ) => ({
    trandt: date,
    rtnprd,
    desc: `Entry ${ref}`,
    refno: ref,
    itc4a5: four(),
    itc4b2: over.reversed ?? four(),
    itc4d1: over.reclaimed ?? four(),
    clsbal: four(),
  });

  const rowA = itcRow('R1', `04${start}`, `20/05/${start}`, { reversed: four(250.25, 250.25, 100) });
  const rowB = itcRow('R2', `09${start}`, `20/10/${start}`, { reclaimed: four(120.1, 120.1, 0, 5) });
  const rowC = itcRow('R3', `12${start}`, `15/01/${start + 1}`, { reclaimed: four(10, 10) });


  // Cash and liability ledgers, shaped as the official response schemas.
  const head = (tx = 0, intr = 0) => ({ tx, intr, pen: 0, oth: 0, fee: 0, tot: tx + intr });
  const heads = (tx = 0, intr = 0) => ({ igst: head(), cgst: head(tx, intr), sgst: head(tx), cess: head() });
  const noBal = { igstbal: head(), cgstbal: head(), sgstbal: head(), cessbal: head() };
  const cashLedger = (gst: string) => ({
    gstin: gst,
    fr_dt: `01/04/${start}`,
    to_dt: `31/03/${start + 1}`,
    op_bal: { desc: 'Opening Balance', tot_rng_bal: 0, ...heads() },
    cl_bal: { desc: 'Closing Balance', tot_rng_bal: 0, ...heads() },
    tr: [
      {
        dpt_dt: `20/10/${start}`,
        desc: 'Debit entry payment of return liability',
        ref_no: 'DI0001',
        tot_tr_amt: 200,
        tot_rng_bal: 0,
        ret_period: `09${start}`,
        tr_typ: 'Dr',
        ...heads(100, 3.5),
        ...noBal,
      },
    ],
  });
  const liabilityLedger = (gst: string) => ({
    gstin: gst,
    fr_dt: `01/04/${start}`,
    to_dt: `31/03/${start + 1}`,
    cl_bal: { tot_rng_bal: 0, desc: 'Closing Balance', cessbal: head(), cgstbal: head(), igstbal: head(), sgstbal: head() },
    tr: [
      {
        dschrg_typ: 'cash',
        tot_tr_amt: 200,
        tot_rng_bal: 0,
        ref_no: 'RL0001',
        dt: `20/10/${start}`,
        tr_typ: 'Cr',
        desc: 'Return liability',
        ...heads(100),
        ...noBal,
      },
    ],
  });

  const post = (body: Record<string, unknown>) => shop.post('/v1/gst/ledger-imports').send(body);

  beforeAll(async () => {
    gstin = validGstin('27');
    shop = await createTenant({ stateCode: '27', gstin });
  }, 120_000);

  afterAll(async () => {
    await closeOwnerClient();
    await closePool();
  });

  let firstId: string;

  it('imports a credit reversal ledger and keeps its entries', async () => {
    firstId = randomUUID();
    const res = await post({
      id: firstId,
      kind: 'itc_reversal',
      document: itcLedger(gstin, [rowA, rowB]),
    }).expect(201);
    const imp = data<LedgerImport>(res);
    expect(imp.kind).toBe('itc_reversal');
    expect(imp.entryCount).toBe(2);
    expect(imp.newEntryCount).toBe(2);
    expect(imp.periodFrom).toBe(`${start}-04-01`);
    expect(imp.periodTo).toBe(`${start + 1}-03-31`);
  }, 60_000);

  it('takes the same document once, whatever id it arrives under', async () => {
    const res = await post({
      id: randomUUID(),
      kind: 'itc_reversal',
      document: itcLedger(gstin, [rowA, rowB]),
    }).expect(201);
    expect(data<LedgerImport>(res).id).toBe(firstId);
  }, 60_000);

  it('keeps an entry once when an overlapping file carries it again', async () => {
    const res = await post({
      id: randomUUID(),
      kind: 'itc_reversal',
      document: itcLedger(gstin, [rowB, rowC]),
    }).expect(201);
    const imp = data<LedgerImport>(res);
    expect(imp.entryCount).toBe(2);
    // R2 was already held; only R3 is new.
    expect(imp.newEntryCount).toBe(1);
  }, 60_000);

  it('imports a cash ledger and a liability ledger as the portal publishes them', async () => {
    const cash = await post({ id: randomUUID(), kind: 'cash', document: cashLedger(gstin) }).expect(201);
    expect(data<LedgerImport>(cash)).toMatchObject({ kind: 'cash', entryCount: 1, newEntryCount: 1 });
    const liab = await post({ id: randomUUID(), kind: 'liability', document: liabilityLedger(gstin) }).expect(201);
    expect(data<LedgerImport>(liab)).toMatchObject({ kind: 'liability', entryCount: 1, newEntryCount: 1 });
  }, 60_000);

  it('refuses a ledger for another GSTIN', async () => {
    const res = await post({
      id: randomUUID(),
      kind: 'itc_reversal',
      document: itcLedger(validGstin('27'), [rowA]),
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain('different GSTIN');
  }, 60_000);

  it('refuses a file that is not that ledger', async () => {
    const res = await post({
      id: randomUUID(),
      kind: 'cash',
      document: itcLedger(gstin, [rowA]),
    });
    expect(res.status).toBe(422);
    const res2 = await post({ id: randomUUID(), kind: 'itc_reversal', document: { gstin } });
    expect(res2.status).toBe(422);
  }, 60_000);

  it('refuses a file whose dates cannot be read', async () => {
    const doc = { ...itcLedger(gstin, [rowA]), frdt: 'sometime', todt: 'later' };
    const res = await post({ id: randomUUID(), kind: 'itc_reversal', document: doc });
    expect(res.status).toBe(422);
  }, 60_000);

  it('lists what was imported', async () => {
    const res = await shop.get('/v1/gst/ledger-imports').expect(200);
    const list = data<LedgerImport[]>(res);
    expect(list.filter((i) => i.kind === 'itc_reversal')).toHaveLength(2);
    expect(list.map((i) => i.kind)).toEqual(expect.arrayContaining(['cash', 'liability']));
  }, 60_000);

  it('feeds GSTR-9: credit reclaimed (6H) from the ledger, tax paid still unknown', async () => {
    const created = await shop
      .post('/v1/gst/periods')
      .send({ id: randomUUID(), gstin, returnType: 'gstr9', periodYear: start, periodMonth: 3 })
      .expect(201);
    const periodId = data<{ id: string }>(created).id;
    const res = await shop.post(`/v1/gst/periods/${periodId}/prepare`).send({}).expect(200);
    const w = data<{
      workings: {
        sheets: { id: string; rows: Record<string, any>[] }[];
        issues: { code: string }[];
      };
    }>(res).workings;
    const six = w.sheets.find((s) => s.id === 'pt3_itc')!.rows;
    const h = six.find((r) => r['ref'] === '6H')!;
    // R2 and R3 reclaimed: 120.10 + 10.00 central and state, 5.00 cess. R1 only reversed credit.
    expect(h['cgst']).toBe(13_010);
    expect(h['sgst']).toBe(13_010);
    expect(h['cess']).toBe(500);
    const codes = w.issues.map((i) => i.code);
    expect(codes).not.toContain('ledger_not_imported');
    expect(codes).toContain('ledger_paid_not_classified');
    // All three ledgers are imported now, so none is missing.
    expect(codes).not.toContain('ledger_kind_missing');
    const nine = w.sheets.find((s) => s.id === 'pt4_tax')!.rows;
    expect(nine.find((r) => r['ref'] === '9B')!['paid']).toBeNull();
  }, 240_000);
});
