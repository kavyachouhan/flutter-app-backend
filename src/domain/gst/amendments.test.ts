import { describe, expect, it } from 'vitest';
import {
  amendmentDifference,
  amendmentRefusals,
  lastAmendmentPeriod,
  matchHeads,
  type AmendableDocument,
  type AmendmentContext,
} from './amendments.js';
import { gstinCheckCharacter } from './gstin.js';

const OTHER_GSTIN = '29AABCU9603R1Z' + gstinCheckCharacter('29AABCU9603R1Z');

const v = (taxable: number, cgst: number) => ({ taxable, igst: 0, cgst, sgst: cgst, cess: 0 });
const inv = (over: Partial<AmendableDocument> = {}): AmendableDocument => ({
  number: 'INV/1',
  date: '2026-05-10',
  value: 11_800,
  placeOfSupply: '27',
  recipientGstin: '27AAPFU0939F1ZV',
  lines: [{ ratePercent: 18, value: v(10_000, 900) }],
  ...over,
});
const ctx = (over: Partial<AmendmentContext> = {}): AmendmentContext => ({
  section: 'b2b',
  route: 'later_gstr1',
  originalPeriod: '2026-05',
  reportPeriod: '2026-07',
  gstr1FiledForOriginal: true,
  gstr3bFiledForOriginal: true,
  reportReturnFiled: false,
  today: '2026-08-01',
  ...over,
});
const codes = (c: AmendmentContext, o: AmendableDocument, r: AmendableDocument) =>
  amendmentRefusals(c, o, r).map((x) => x.code);

describe('amendments: routes and limits', () => {
  it('allows a value correction in a later GSTR-1 and charges only the difference', () => {
    const revised = inv({ value: 23_600, lines: [{ ratePercent: 18, value: v(20_000, 1_800) }] });
    expect(codes(ctx(), inv(), revised)).toEqual([]);
    expect(amendmentDifference('b2b', inv(), revised)).toEqual(v(10_000, 900));
  });

  it('negates the difference for a credit note', () => {
    const o = inv({ noteKind: 'credit' });
    const r = inv({ noteKind: 'credit', lines: [{ ratePercent: 18, value: v(5_000, 450) }] });
    expect(amendmentDifference('cdnr', o, r).taxable).toBe(5_000);
  });

  it('refuses a GSTIN change in GSTR-1A and after GSTR-3B is filed', () => {
    const r = inv({ recipientGstin: OTHER_GSTIN });
    const one = ctx({ route: 'gstr1a', reportPeriod: '2026-05', gstr3bFiledForOriginal: false });
    expect(codes(one, inv(), r)).toContain('gstin_change_not_in_1a');
    expect(codes(ctx({ route: 'gstr1a', reportPeriod: '2026-05' }), inv(), inv({ value: 1 }))).toContain('gstr1a_after_3b');
    expect(codes(ctx(), inv(), r)).toEqual([]);
  });

  it('stops at the GSTR-1 for October after the financial year (s.37(3))', () => {
    expect(lastAmendmentPeriod('2026-05')).toBe('2027-10');
    expect(codes(ctx({ reportPeriod: '2027-11' }), inv(), inv({ value: 1 }))).toContain('past_s37_3_limit');
  });

  it('refuses moving a B2CL invoice to B2B, a B2CL POS change and a no-op', () => {
    const b2cl = inv({ recipientGstin: null, value: 20_000_000, placeOfSupply: '29' });
    expect(codes(ctx({ section: 'b2cl' }), b2cl, { ...b2cl, recipientGstin: '27AAPFU0939F1ZV' })).toContain('section_change');
    expect(codes(ctx({ section: 'b2cl' }), b2cl, { ...b2cl, placeOfSupply: '24' })).toContain('pos_not_amendable');
    expect(codes(ctx(), inv(), inv())).toContain('no_change');
  });
});

describe('amendments: tax heads', () => {
  const line = (igst: number, cgst: number, sgst: number) => ({
    ratePercent: 18,
    value: { taxable: 10_000, igst, cgst, sgst, cess: 0 },
  });
  it('moves revised tax to IGST when the original was inter-State', () => {
    expect(matchHeads([line(0, 900, 900)], [line(1_800, 0, 0)], '29', '29')[0]?.value).toMatchObject({
      igst: 1_800,
      cgst: 0,
      sgst: 0,
    });
  });
  it('splits revised tax into CGST and SGST when the original was intra-State', () => {
    expect(matchHeads([line(1_801, 0, 0)], [line(0, 900, 900)], '27', '27')[0]?.value).toMatchObject({
      igst: 0,
      cgst: 901,
      sgst: 900,
    });
  });
  it('keeps the sent split when the place of supply changes', () => {
    expect(matchHeads([line(0, 900, 900)], [line(1_800, 0, 0)], '27', '29')[0]?.value.cgst).toBe(900);
  });
});
