/**
 * The committed vector files are the contract the Dart port is tested
 * against. This proves they still describe this engine: every case
 * re-evaluates to what the file says, and regenerating would change nothing.
 *
 * If this fails after an intentional engine change, run
 * `npm run contracts:generate`, review the diff, and update the Dart port.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { TaxInvoiceResult } from '../../src/domain/tax/types.js';
import {
  buildAccessVectors,
  buildEntityVectors,
  buildGstinVectors,
  buildRegistrationVectors,
  buildRuleSetVectors,
  buildTosVectors,
  evaluateTosCase,
  buildPosVectors,
  buildInvoiceRulesVectors,
  evaluatePosCase,
  evaluateInvoiceRulesCase,
  buildCorrectionsVectors,
  evaluateCorrectionsCase,
  type CorrectionsVectorsFile,
  type PosVectorsFile,
  type InvoiceRulesVectorsFile,
  type TosVectorsFile,
  evaluateEntityCase,
  evaluateGstinCase,
  evaluateRegistrationCase,
  evaluateRuleSetCase,
  type EntityVectorsFile,
  type GstinVectorsFile,
  type RegistrationVectorsFile,
  type RuleSetVectorsFile,
  buildCostingVectors,
  buildNumberingVectors,
  buildReturnsVectors,
  buildTaxVectors,
  evaluateCostingCase,
  evaluateNumberingCase,
  evaluateReturnsCase,
  evaluateTaxCase,
  type AccessVectorsFile,
  type CostingVectorsFile,
  type NumberingVectorsFile,
  type ReturnsVectorsFile,
  type TaxVectorsFile,
} from './build.js';

const contractsDir = fileURLToPath(new URL('../../contracts/', import.meta.url));

function load<T>(name: string): T {
  return JSON.parse(readFileSync(`${contractsDir}${name}`, 'utf8')) as T;
}

describe('tax-engine contract vectors', () => {
  const file = load<TaxVectorsFile>('tax-vectors.json');

  it('covers the hand-written rules and a large random sweep', () => {
    expect(file.contract).toBe('tax-engine');
    expect(file.cases.length).toBeGreaterThan(300);
    expect(file.cases.filter((c) => 'error' in c.expected).length).toBeGreaterThan(5);
  });

  it('re-evaluates every case to the committed expectation', () => {
    for (const c of file.cases) {
      expect(evaluateTaxCase(c.input), c.name).toEqual(c.expected);
    }
  });

  it('is byte-for-byte what the generator would write now', () => {
    expect(buildTaxVectors()).toEqual(file);
  });

  // The invariant a printed bill relies on: what the lines say, plus the
  // charges and their tax, plus the round-off, is what the customer pays.
  it('never lets rounded lines disagree with the grand total', () => {
    for (const c of file.cases) {
      if (!('result' in c.expected)) continue;
      const r = c.expected.result as TaxInvoiceResult;
      const lineSum = r.lines.reduce((acc, l) => acc + l.lineTotal, 0);
      if (r.taxPayableBy === 'recipient') {
        // The tax is the recipient's: the document is its value and nothing more.
        expect(lineSum + r.taxableCharges + r.nonTaxableCharges + r.roundOff, c.name).toBe(r.grandTotal);
        continue;
      }
      const lineTax = r.lines.reduce((acc, l) => acc + l.cgst + l.sgst + l.igst + l.cess, 0);
      const chargeTax = r.totalTax - lineTax;
      expect(
        lineSum + r.taxableCharges + chargeTax + r.nonTaxableCharges + r.roundOff,
        c.name,
      ).toBe(r.grandTotal);
    }
  });
});

describe('rounding policy (D4), on every tax vector', () => {
  const file = load<TaxVectorsFile>('tax-vectors.json');
  const results = file.cases.flatMap((c) =>
    'result' in c.expected ? [{ name: c.name, input: c.input, r: c.expected.result as TaxInvoiceResult }] : [],
  );

  it('always splits intra-state tax into equal halves and IGST into two of them', () => {
    for (const { name, r } of results) {
      for (const l of r.lines) {
        expect(l.cgst, name).toBe(l.sgst);
        expect(l.igst % 2, name).toBe(0);
        expect(l.igst > 0 && l.cgst > 0, name).toBe(false);
      }
    }
  });

  it('makes every tax-inclusive line total exactly what the customer was quoted', () => {
    for (const { name, input, r } of results) {
      if (!input.pricesIncludeTax || r.taxPayableBy === 'recipient' || r.mode !== 'gst') continue;
      for (const l of r.lines) {
        expect(l.lineTotal, name).toBe(l.grossAmount - l.lineDiscount - l.apportionedBillDiscount);
        expect(l.taxableAmount, name).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('numbering contract vectors', () => {
  const file = load<NumberingVectorsFile>('numbering-vectors.json');

  it('re-evaluates every case to the committed expectation', () => {
    for (const c of file.cases) {
      expect(evaluateNumberingCase(c), c.name).toEqual(c.expected);
    }
  });

  it('is byte-for-byte what the generator would write now', () => {
    expect(buildNumberingVectors()).toEqual(file);
  });
});

describe('costing contract vectors', () => {
  const file = load<CostingVectorsFile>('costing-vectors.json');

  it('covers every operation, including the doubles-above-2^53 cases', () => {
    const ops = new Set(file.cases.map((c) => c.op));
    expect([...ops].sort()).toEqual(
      ['apportionLandedCost', 'applyReceipt', 'costOfGoodsSold', 'dueDateFor', 'reverseReceipt'].sort(),
    );
    expect(file.cases.length).toBeGreaterThan(300);
    expect(file.cases.some((c) => c.name.includes('2^53'))).toBe(true);
  });

  it('re-evaluates every case to the committed expectation', () => {
    for (const c of file.cases) expect(evaluateCostingCase(c), c.name).toEqual(c.expected);
  });

  it('is byte-for-byte what the generator would write now', () => {
    expect(buildCostingVectors()).toEqual(file);
  });

  // Freight is split across the lines; whatever the basis, the shares must add up to it.
  it('apportions exactly the freight it was given', () => {
    for (const c of file.cases) {
      if (c.op !== 'apportionLandedCost' || !('result' in c.expected)) continue;
      if (c.input.lines.length === 0) continue;
      const shares = (c.expected.result as { landedCostShare: number }[]).reduce(
        (sum, l) => sum + l.landedCostShare,
        0,
      );
      expect(shares, c.name).toBe(c.input.basis === 'none' ? 0 : c.input.additionalCost);
    }
  });
});

describe('returns contract vectors', () => {
  const file = load<ReturnsVectorsFile>('returns-vectors.json');

  it('covers refusals and every supply category', () => {
    expect(file.cases.length).toBeGreaterThan(150);
    expect(file.cases.filter((c) => 'error' in c.expected).length).toBeGreaterThanOrEqual(3);
    const categories = new Set(file.cases.map((c) => c.input.sold.supplyCategory));
    expect([...categories].sort()).toEqual(['exempt', 'nil_rated', 'non_gst', 'taxable']);
  });

  it('re-evaluates every case to the committed expectation', () => {
    for (const c of file.cases) expect(evaluateReturnsCase(c), c.name).toEqual(c.expected);
  });

  it('is byte-for-byte what the generator would write now', () => {
    expect(buildReturnsVectors()).toEqual(file);
  });

  it('never loses the supply category of the line it reverses', () => {
    for (const c of file.cases) {
      if (!('result' in c.expected)) continue;
      expect((c.expected.result as { supplyCategory: string }).supplyCategory, c.name).toBe(
        c.input.sold.supplyCategory,
      );
    }
  });
});

describe('access contract vectors', () => {
  const file = load<AccessVectorsFile>('access-vectors.json');

  it('is byte-for-byte what the generator would write now', () => {
    // Fails when a permission, role grant, plan feature or document type changes without
    // `npm run contracts:generate` and a matching change in the app.
    expect(buildAccessVectors()).toEqual(file);
  });

  it('gives the owner every permission and holds no unknown ones', () => {
    expect(file.roles.owner).toEqual(file.permissions);
    for (const granted of Object.values(file.roles)) {
      for (const permission of granted) expect(file.permissions).toContain(permission);
    }
  });
});

describe('gstin contract vectors', () => {
  const file = load<GstinVectorsFile>('gstin-vectors.json');

  it('covers valid, invalid and swept GSTINs', () => {
    expect(file.cases.length).toBeGreaterThan(100);
    const results = file.cases.filter((c) => c.op === 'gstinProblem').map((c) => (c.expected as { result: unknown }).result);
    for (const problem of [null, 'format', 'state_code', 'checksum']) expect(results).toContain(problem);
  });

  it('re-evaluates every case to the committed expectation', () => {
    for (const c of file.cases) expect(evaluateGstinCase(c), c.name).toEqual(c.expected);
  });

  it('is byte-for-byte what the generator would write now', () => {
    expect(buildGstinVectors()).toEqual(file);
  });
});

describe('gst rule-set contract vectors', () => {
  const file = load<RuleSetVectorsFile>('ruleset-vectors.json');

  it('re-evaluates every case to the committed expectation', () => {
    for (const c of file.cases) expect(evaluateRuleSetCase(c), c.name).toEqual(c.expected);
  });

  it('is byte-for-byte what the generator would write now', () => {
    expect(buildRuleSetVectors()).toEqual(file);
  });
});

describe('gst registration contract vectors', () => {
  const file = load<RegistrationVectorsFile>('registration-vectors.json');

  it('re-evaluates every case to the committed expectation', () => {
    for (const c of file.cases) expect(evaluateRegistrationCase(c), c.name).toEqual(c.expected);
  });

  it('is byte-for-byte what the generator would write now', () => {
    expect(buildRegistrationVectors()).toEqual(file);
  });
});

describe('gst entity contract vectors', () => {
  const file = load<EntityVectorsFile>('entity-vectors.json');

  it('re-evaluates every case to the committed expectation', () => {
    for (const c of file.cases) expect(evaluateEntityCase(c), c.name).toEqual(c.expected);
  });

  it('is byte-for-byte what the generator would write now', () => {
    expect(buildEntityVectors()).toEqual(file);
  });
});

describe('gst time-of-supply contract vectors', () => {
  const file = load<TosVectorsFile>('tos-vectors.json');

  it('re-evaluates every case to the committed expectation', () => {
    for (const c of file.cases) expect(evaluateTosCase(c), c.name).toEqual(c.expected);
  });

  it('is byte-for-byte what the generator would write now', () => {
    expect(buildTosVectors()).toEqual(file);
  });
});

describe('gst place-of-supply contract vectors', () => {
  const file = load<PosVectorsFile>('pos-vectors.json');

  it('re-evaluates every case to the committed expectation', () => {
    for (const c of file.cases) expect(evaluatePosCase(c), c.name).toEqual(c.expected);
  });

  it('is byte-for-byte what the generator would write now', () => {
    expect(buildPosVectors()).toEqual(file);
  });
});

describe('gst invoice-rules contract vectors', () => {
  const file = load<InvoiceRulesVectorsFile>('invoice-rules-vectors.json');

  it('re-evaluates every case to the committed expectation', () => {
    for (const c of file.cases) expect(evaluateInvoiceRulesCase(c), c.name).toEqual(c.expected);
  });

  it('is byte-for-byte what the generator would write now', () => {
    expect(buildInvoiceRulesVectors()).toEqual(file);
  });
});

describe('gst corrections contract vectors', () => {
  const file = load<CorrectionsVectorsFile>('corrections-vectors.json');

  it('re-evaluates every case to the committed expectation', () => {
    for (const c of file.cases) expect(evaluateCorrectionsCase(c), c.name).toEqual(c.expected);
  });

  it('is byte-for-byte what the generator would write now', () => {
    expect(buildCorrectionsVectors()).toEqual(file);
  });
});
