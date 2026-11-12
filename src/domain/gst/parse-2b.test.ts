import { describe, expect, it } from 'vitest';
import { parseGstr2b } from './parse-2b.js';

/** Shaped like the official "GSTR2B - Get All Details" response (data/gstn-schemas/GSTR2B). */
const statement = {
  chksum: 'abc',
  data: {
    gstin: '27AAPFU0939F1ZV',
    rtnprd: '112026',
    version: '1.0',
    gendt: '14-12-2026',
    docdata: {
      b2b: [
        {
          ctin: '29AABCU9603R1ZX',
          trdnm: 'Acme Supplies',
          supfildt: '11-12-2026',
          supprd: '112026',
          inv: [
            {
              inum: 'AC/101',
              typ: 'R',
              dt: '05-11-2026',
              val: 11800.5,
              pos: '27',
              rev: 'N',
              itcavl: 'Y',
              txval: 10000,
              igst: 1800,
              cgst: 0,
              sgst: 0,
              cess: 0.5,
              imsStatus: 'A',
              items: [{ num: 1, rt: 18, txval: 10000, igst: 1800, cgst: 0, sgst: 0, cess: 0.5 }],
            },
            {
              inum: 'AC/102',
              typ: 'R',
              dt: '06-11-2026',
              val: 5000,
              pos: '27',
              rev: 'N',
              itcavl: 'T',
              rsn: 'Supplier GSTR-3B not filed',
              txval: 4237.29,
              igst: 0,
              cgst: 381.36,
              sgst: 381.35,
              cess: 0,
            },
          ],
        },
      ],
      cdnr: [
        {
          ctin: '29AABCU9603R1ZX',
          nt: [
            {
              ntnum: 'DN/7',
              typ: 'D',
              suptyp: 'R',
              dt: '20-11-2026',
              val: 118,
              pos: '27',
              rev: 'N',
              itcavl: 'Y',
              txval: 100,
              igst: 18,
              cgst: 0,
              sgst: 0,
              cess: 0,
            },
            {
              ntnum: 'CN/3',
              typ: 'C',
              suptyp: 'R',
              dt: '21-11-2026',
              val: 59,
              pos: '27',
              rev: 'N',
              itcavl: 'Y',
              txval: 50,
              igst: 9,
              cgst: 0,
              sgst: 0,
              cess: 0,
            },
          ],
        },
      ],
      impg: [
        {
          refdt: '02-11-2026',
          recdt: '03-11-2026',
          portcode: 'INMAA1',
          boenum: '4455667',
          boedt: '01-11-2026',
          isamd: 'N',
          txval: 20000,
          igst: 3600,
          cess: 0,
        },
      ],
      isd: [
        {
          ctin: '29AABCU9603R1ZX',
          doclist: [
            {
              doctyp: 'ISDI',
              docnum: 'ISD/1',
              docdt: '10-11-2026',
              igst: 100,
              cgst: 0,
              sgst: 0,
              cess: 0,
              itcelg: 'Y',
            },
          ],
        },
      ],
      itcrev: { b2b: [] },
    },
  },
};

describe('parsing a GSTR-2B statement in the official shape', () => {
  const result = parseGstr2b(statement);
  const byNo = (n: string) => result.invoices.find((i) => i.invoiceNo === n);

  it('reads invoices with dt and flat tax fields (regression: tax was read as zero)', () => {
    expect(byNo('AC/101')).toMatchObject({
      supplierGstin: '29AABCU9603R1ZX',
      invoiceDate: '2026-11-05',
      invoiceValue: 1_180_050,
      taxableAmount: 1_000_000,
      igst: 180_000,
      cess: 50,
      itcAvailable: true,
      filedPeriod: '112026',
    });
  });

  it('treats T (temporarily unavailable) as unknown, not as a refusal', () => {
    const t = byNo('AC/102');
    expect(t?.itcAvailable).toBe(null);
    expect(t?.itcUnavailableReason).toBe('Supplier GSTR-3B not filed');
    expect(t?.cgst).toBe(38_136);
    expect(t?.sgst).toBe(38_135);
  });

  it('separates debit notes from credit notes', () => {
    expect(byNo('DN/7')?.documentType).toBe('debit_note');
    expect(byNo('CN/3')?.documentType).toBe('credit_note');
  });

  it('reads imports and ISD documents, which have no invoice number or taxable value', () => {
    expect(byNo('4455667')).toMatchObject({
      documentType: 'import_goods',
      supplierGstin: 'CUSTOMS',
      igst: 360_000,
    });
    expect(byNo('ISD/1')).toMatchObject({ documentType: 'isd', igst: 10_000, itcAvailable: true });
  });

  it('reports a block it does not read instead of treating it as empty', () => {
    expect(result.errors).toEqual([
      { path: 'itcrev', reason: 'this block is present but is not read yet' },
    ]);
    expect(result.statementPeriod).toBe('112026');
  });
});
