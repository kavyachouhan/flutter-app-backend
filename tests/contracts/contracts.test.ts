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
  buildNumberingVectors,
  buildTaxVectors,
  evaluateNumberingCase,
  evaluateTaxCase,
  type AccessVectorsFile,
  type NumberingVectorsFile,
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
      const lineTax = r.lines.reduce((acc, l) => acc + l.cgst + l.sgst + l.igst + l.cess, 0);
      const chargeTax = r.totalTax - lineTax;
      expect(
        lineSum + r.taxableCharges + chargeTax + r.nonTaxableCharges + r.roundOff,
        c.name,
      ).toBe(r.grandTotal);
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
