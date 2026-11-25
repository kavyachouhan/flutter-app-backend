import { describe, expect, it } from 'vitest';
import { classifyEntry, NO_RULES, validateRuleSet, type LedgerRuleSet } from './classify.js';
import { parseGstnDate, parseLedger, parseReturnPeriod, toPaise } from './parse.js';
import { summariseLedgers } from './summary.js';

const head = (tx = 0, intr = 0, pen = 0, oth = 0, fee = 0) => ({ tx, intr, pen, oth, fee, tot: tx + intr + pen + oth + fee });
const zeroHeads = { igst: head(), cgst: head(), sgst: head(), cess: head() };

const cashDoc = {
  gstin: '27AAACG1395D1ZU',
  fr_dt: '01/04/2026',
  to_dt: '31/03/2027',
  tr: [
    {
      dpt_dt: '20/11/2026',
      desc: 'Debit entry payment of return liability',
      ref_no: 'DI2711260000001',
      tot_tr_amt: 15300.5,
      tot_rng_bal: 0,
      ret_period: '102026',
      tr_typ: 'Dr',
      ...zeroHeads,
      cgst: head(10000.5, 0, 0, 0, 0),
      sgst: head(5300, 0, 0, 0, 0),
    },
    { dpt_dt: '05/11/2026', desc: 'Deposit', tot_tr_amt: 20000, tr_typ: 'Cr', ...zeroHeads, cgst: head(10000) },
  ],
};

const liabilityDoc = {
  gstin: '27AAACG1395D1ZU',
  fr_dt: '01/04/2026',
  to_dt: '31/03/2027',
  tr: [
    {
      dt: '20/11/2026',
      desc: 'Return liability',
      ref_no: 'RL1',
      dschrg_typ: 'CASH',
      tr_typ: 'Cr',
      ret_period: '102026',
      ...zeroHeads,
      cgst: head(7000),
    },
  ],
};

const itcDoc = {
  gstin: '27AAACG1395D1ZU',
  frdt: '01/04/2026',
  todt: '31/03/2027',
  tr: [
    {
      trandt: '20/05/2026',
      rtnprd: '042026',
      desc: 'Reversal',
      refno: 'R1',
      itc4a5: { igst: 0, cgst: 0, sgst: 0, cess: 0 },
      itc4b2: { igst: 100, cgst: 250.25, sgst: 250.25, cess: 0 },
      itc4d1: { igst: 0, cgst: 0, sgst: 0, cess: 0 },
    },
    {
      trandt: '20/09/2026',
      rtnprd: '092026',
      desc: 'Reclaim',
      refno: 'R2',
      itc4a5: { igst: 0, cgst: 0, sgst: 0, cess: 0 },
      itc4b2: { igst: 0, cgst: 0, sgst: 0, cess: 0 },
      itc4d1: { igst: 0, cgst: 120.1, sgst: 120.1, cess: 5 },
    },
  ],
};

describe('GSTN value readers', () => {
  it('reads rupees as whole paise without float drift', () => {
    expect(toPaise(0.07)).toBe(7);
    expect(toPaise(1.15)).toBe(115);
    expect(toPaise('250.25')).toBe(25_025);
    expect(toPaise(undefined)).toBe(0);
  });

  it('reads the portal dates and refuses an impossible one', () => {
    expect(parseGstnDate('20/11/2026')).toBe('2026-11-20');
    expect(parseGstnDate('20-11-2026')).toBe('2026-11-20');
    expect(parseGstnDate('2026-11-20')).toBe('2026-11-20');
    expect(parseGstnDate('31/02/2026')).toBeNull();
    expect(parseGstnDate('soon')).toBeNull();
  });

  it('reads MMYYYY as a period', () => {
    expect(parseReturnPeriod('102026')).toBe('2026-10');
    expect(parseReturnPeriod('132026')).toBeNull();
  });
});

describe('ledger parsers', () => {
  it('reads the cash ledger into neutral entries', () => {
    const p = parseLedger('cash', cashDoc);
    expect(p.gstin).toBe('27AAACG1395D1ZU');
    expect([p.from, p.to]).toEqual(['2026-04-01', '2027-03-31']);
    expect(p.entries).toHaveLength(2);
    const e = p.entries[0]!;
    expect(e.direction).toBe('debit');
    expect(e.returnPeriod).toBe('2026-10');
    expect(e.refNo).toBe('DI2711260000001');
    expect(e.amounts?.cgst.tax).toBe(1_000_050);
    expect(p.entries[1]?.direction).toBe('credit');
  });

  it('reads the liability ledger with its discharge type', () => {
    const e = parseLedger('liability', liabilityDoc).entries[0]!;
    expect(e.dischargeType).toBe('CASH');
    expect(e.direction).toBe('credit');
    expect(e.amounts?.cgst.tax).toBe(700_000);
  });

  it('reads the credit reversal ledger by what its keys say', () => {
    const p = parseLedger('itc_reversal', itcDoc);
    expect(p.entries[0]?.itc?.reversed).toEqual({ igst: 10_000, cgst: 25_025, sgst: 25_025, cess: 0 });
    expect(p.entries[1]?.itc?.reclaimed).toEqual({ igst: 0, cgst: 12_010, sgst: 12_010, cess: 500 });
  });

  it('reports what it cannot read instead of guessing', () => {
    const p = parseLedger('cash', {
      gstin: '27AAACG1395D1ZU',
      fr_dt: 'x',
      to_dt: 'y',
      tr: [{ dpt_dt: 'nope', desc: 'x', tr_typ: 'Maybe', ...zeroHeads }],
    });
    const codes = p.issues.map((i) => i.code);
    expect(codes).toEqual(
      expect.arrayContaining(['ledger_window_unreadable', 'entry_date_unreadable', 'entry_direction_unknown']),
    );
    expect(p.entries[0]?.date).toBeNull();
    expect(p.entries[0]?.direction).toBeNull();
  });
});

describe('classification rules', () => {
  const rules: LedgerRuleSet = {
    version: 'test',
    rules: [
      {
        id: 'cash-debit-return',
        kind: 'cash',
        direction: 'debit',
        descriptionPattern: 'payment of return liability',
        effect: 'paid_cash',
        verifiedAgainst: 'test fixture',
      },
      {
        id: 'liability-itc',
        kind: 'liability',
        dischargeType: 'itc',
        effect: 'paid_itc',
        verifiedAgainst: 'test fixture',
      },
    ],
  };
  const cash = parseLedger('cash', cashDoc).entries;
  const liab = parseLedger('liability', liabilityDoc).entries;

  it('matches on every condition given, case-insensitively', () => {
    expect(classifyEntry(cash[0]!, rules)?.id).toBe('cash-debit-return');
    // Same words, wrong direction.
    expect(classifyEntry(cash[1]!, rules)).toBeNull();
    // A different discharge type.
    expect(classifyEntry(liab[0]!, rules)).toBeNull();
  });

  it('has no opinion without rules', () => {
    expect(classifyEntry(cash[0]!, NO_RULES)).toBeNull();
  });

  it('refuses a rule that says nothing about where it came from or matches on nothing', () => {
    const base = { version: 'v', rules: [{ id: 'a', kind: 'cash', direction: 'debit', effect: 'paid_cash' }] };
    expect(() => validateRuleSet(base)).toThrow(/verifiedAgainst/);
    const open = { version: 'v', rules: [{ id: 'a', kind: 'cash', effect: 'paid_cash', verifiedAgainst: 'x' }] };
    expect(() => validateRuleSet(open)).toThrow(/condition/);
    const bad = { version: 'v', rules: [{ id: 'a', kind: 'cash', descriptionPattern: '(', effect: 'ignore', verifiedAgainst: 'x' }] };
    expect(() => validateRuleSet(bad)).toThrow();
    expect(validateRuleSet({ version: 'v', rules: [] }).rules).toEqual([]);
  });
});

describe('ledger summary', () => {
  const itc = parseLedger('itc_reversal', itcDoc).entries;
  const cash = parseLedger('cash', cashDoc).entries;
  const rules: LedgerRuleSet = {
    version: 'test',
    rules: [
      { id: 'pay', kind: 'cash', direction: 'debit', effect: 'paid_cash', verifiedAgainst: 'test fixture' },
    ],
  };
  const months = ['2026-04', '2026-05'];

  it('sums credit reclaimed and reversed from the credit reversal ledger', () => {
    const s = summariseLedgers({ entries: itc, rules: NO_RULES, coveredByKind: { itc_reversal: months } });
    expect(s.itcReclaimed).toEqual({ igst: 0, cgst: 12_010, sgst: 12_010, cess: 500 });
    expect(s.itcReversed).toEqual({ igst: 10_000, cgst: 25_025, sgst: 25_025, cess: 0 });
  });

  it('leaves paid unknown while there is no rule, and says which ledgers are missing', () => {
    const s = summariseLedgers({
      entries: [...itc, ...cash],
      rules: NO_RULES,
      coveredByKind: { itc_reversal: months, cash: months },
    });
    expect(s.paid).toBeNull();
    expect(s.unclassifiedEntries).toBe(0);
    expect(s.missingKinds).toEqual(['liability']);
  });

  it('counts a month as covered only when every imported ledger covers it', () => {
    const s = summariseLedgers({
      entries: [],
      rules: NO_RULES,
      coveredByKind: { itc_reversal: ['2026-04', '2026-05', '2026-06'], cash: ['2026-05', '2026-06', '2026-07'] },
    });
    expect(s.coveredMonths).toEqual(['2026-05', '2026-06']);
  });

  it('sums paid by head and discharge, and counts what no rule matched', () => {
    const s = summariseLedgers({
      entries: cash,
      rules,
      coveredByKind: { cash: months },
    });
    expect(s.paid?.cgst).toEqual({ cash: 1_000_050, itc: 0 });
    expect(s.paid?.sgst).toEqual({ cash: 530_000, itc: 0 });
    expect(s.paid?.igst).toEqual({ cash: 0, itc: 0 });
    // The credit entry (a deposit) matched no rule: counted, not guessed into a head.
    expect(s.unclassifiedEntries).toBe(1);
  });

  it('puts interest, penalty, fee and other in their own heads', () => {
    const entry = {
      ...cash[0]!,
      amounts: {
        igst: { tax: 0, interest: 100, penalty: 0, other: 0, fee: 0 },
        cgst: { tax: 0, interest: 50, penalty: 30, other: 0, fee: 20 },
        sgst: { tax: 0, interest: 0, penalty: 0, other: 7, fee: 20 },
        cess: { tax: 0, interest: 0, penalty: 0, other: 0, fee: 0 },
      },
    };
    const s = summariseLedgers({ entries: [entry], rules, coveredByKind: { cash: months } });
    expect(s.paid?.interest.cash).toBe(150);
    expect(s.paid?.penalty.cash).toBe(30);
    expect(s.paid?.lateFee.cash).toBe(40);
    expect(s.paid?.other.cash).toBe(7);
  });
});
