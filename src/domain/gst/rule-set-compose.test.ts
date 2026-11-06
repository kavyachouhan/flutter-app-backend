import { describe, expect, it } from 'vitest';
import { checkRuleFiles, loadRuleFiles } from '../../db/gst/rule-files.js';
import {
  composeRuleSet,
  normaliseHsnMaster,
  ruleSetProblems,
  unverifiedRates,
  versionDates,
  type NotificationFile,
  type RuleBaseFile,
} from './rule-set-compose.js';
import { RULE_46_UNREGISTERED_TAXABLE_PAISE } from './invoice-rules.js';
import { ratesFor, selectRuleSet, type GstRuleSet } from './rule-set.js';

const base: RuleBaseFile = { stateCodes: [], uqc: [], gstr1aAmendableFields: {} };
const n = (over: Partial<NotificationFile> & Pick<NotificationFile, 'notification' | 'effectiveFrom'>): NotificationFile => ({
  issued: null,
  sourceFile: null,
  verificationStatus: 'secondary_only',
  treatment: 'encoded',
  cess: { allowedUntil: '2099-12-31' },
  ...over,
});

describe('composing rule files', () => {
  it('ends an earlier entry on the later notification, keeping its history', () => {
    const files = [
      n({ notification: 'A', effectiveFrom: '2020-01-01', add: { allowedRates: [{ id: 'r12', ratePercent: 12 }] } }),
      n({ notification: 'B', effectiveFrom: '2025-09-22', end: { allowedRates: ['r12'] } }),
    ];
    expect(composeRuleSet(base, files, '2020-06-01').allowedRates[0]).toMatchObject({ effectiveTo: null });
    expect(composeRuleSet(base, files, '2025-09-22').allowedRates[0]).toMatchObject({
      effectiveFrom: '2020-01-01',
      effectiveTo: '2025-09-22',
      notificationRef: 'A',
    });
  });

  it('leaves out notifications not yet in effect and those not encoded', () => {
    const files = [
      n({ notification: 'A', effectiveFrom: '2020-01-01' }),
      n({ notification: 'B', effectiveFrom: '2027-01-01', add: { allowedRates: [{ id: 'r5', ratePercent: 5 }] } }),
      n({ notification: 'C', effectiveFrom: '2020-02-01', treatment: 'deferred', reason: 'x', add: { allowedRates: [{ id: 'r9', ratePercent: 9 }] } }),
    ];
    expect(composeRuleSet(base, files, '2026-01-01').allowedRates).toEqual([]);
    expect(versionDates(files)).toEqual(['2020-01-01', '2027-01-01']);
  });

  it('refuses a duplicate id and ending something unknown', () => {
    const dup = [
      n({ notification: 'A', effectiveFrom: '2020-01-01', add: { allowedRates: [{ id: 'x', ratePercent: 5 }] } }),
      n({ notification: 'B', effectiveFrom: '2021-01-01', add: { allowedRates: [{ id: 'x', ratePercent: 5 }] } }),
    ];
    expect(() => composeRuleSet(base, dup, '2021-01-01')).toThrow(/already exists/);
    const unknown = [n({ notification: 'A', effectiveFrom: '2020-01-01', end: { taxRates: ['nope'] } })];
    expect(() => composeRuleSet(base, unknown, '2020-01-01')).toThrow(/unknown taxRates/);
  });

  it('reports contradictory entries and overlapping thresholds', () => {
    const content = composeRuleSet(
      base,
      [
        n({
          notification: 'A',
          effectiveFrom: '2020-01-01',
          add: {
            taxRates: [
              { id: 'no-rate', scope: { kind: 'hsn', codePrefixes: ['12'] }, taxability: 'taxable', ratePercent: null, condition: null, exemptionBasis: null, rcmCategoryCode: null },
              { id: 'no-basis', scope: { kind: 'hsn', codePrefixes: ['13'] }, taxability: 'exempt', ratePercent: null, condition: null, exemptionBasis: null, rcmCategoryCode: null },
            ],
            thresholds: [
              { id: 't1', key: 'b2cl_invoice_value', value: 1 },
              { id: 't2', key: 'b2cl_invoice_value', value: 2, effectiveFrom: '2021-01-01' },
            ],
          },
        }),
      ],
      '2021-06-01',
    );
    const problems = ruleSetProblems(content).join('\n');
    expect(problems).toMatch(/no-rate/);
    expect(problems).toMatch(/no-basis/);
    expect(problems).toMatch(/b2cl_invoice_value" overlaps/);
  });

  it('holds back publication while an in-force rate rests on secondary sources', () => {
    const content = composeRuleSet(
      base,
      [
        n({ notification: 'A', effectiveFrom: '2020-01-01', add: { allowedRates: [{ id: 'r5', ratePercent: 5 }, { id: 'old', ratePercent: 12, effectiveTo: '2021-01-01' }] } }),
      ],
      '2022-01-01',
    );
    expect(unverifiedRates(content, '2022-01-01')).toEqual(['allowed rate 5% (A)']);
  });
});

describe('the rule files in this repository', () => {
  const files = loadRuleFiles();

  it('account for every notification in data/CBIC, and stay unpublishable until the verified foundation exists', () => {
    // Slabs, thresholds and the cess rule were removed until their primary text is verified.
    // When they return, this becomes `toEqual([])`.
    expect(checkRuleFiles(files)).toEqual([
      '2017-07-01: No cess rule in force on 2017-07-01',
      '2026-11-01: No cess rule in force on 2026-11-01',
    ]);
  });

  it('record the same Rule 46 limit the invoice check uses', () => {
    const rule46 = files.notifications.find((f) => f.notification === 'CGST Rule 46');
    expect(rule46?.add?.thresholds?.[0]?.['value']).toBe(RULE_46_UNREGISTERED_TAXABLE_PAISE);
  });

  it('evaluate the verified 2026 notifications from the date they take effect', () => {
    // Test-only stand-in for the foundation; it carries no rates.
    const notifications = [n({ notification: 'test foundation', effectiveFrom: '2017-07-01' }), ...files.notifications];
    const versions = versionDates(notifications).map(
      (date): GstRuleSet => ({
        version: `${date}.1`,
        effectiveFrom: date,
        revision: 1,
        supersedes: null,
        status: 'published',
        content: composeRuleSet(files.base, notifications, date),
      }),
    );
    const on = (date: string): GstRuleSet => selectRuleSet(date, versions);

    // 02/2026: retreaded tractor tyres move to 5%, everything else in 4012 stays 18%.
    expect(ratesFor(on('2026-10-31'), 'hsn', '40121010', '2026-10-31')).toEqual([]);
    expect(ratesFor(on('2026-11-01'), 'hsn', '40121010', '2026-11-01').map((r) => r.ratePercent).sort()).toEqual([18, 5]);
    // 03/2026: psyllium seeds are exempt.
    expect(ratesFor(on('2026-11-01'), 'hsn', '12119013', '2026-11-01')[0]).toMatchObject({ taxability: 'exempt' });
    // 04/2026: four reverse-charge goods.
    expect(on('2026-11-01').content.rcmCategories.map((c) => c.codePrefixes[0]).sort()).toEqual(['1518', '3915', '4004', '8549']);
  });
});

describe('preparing the HSN/SAC master', () => {
  it('keeps the properly formed code and reports every row it changes or leaves out', () => {
    const { rows, corrections, errors } = normaliseHsnMaster([
      { code: '04', description: 'DAIRY', kind: 'goods' },
      { code: '0402', description: 'MILK', kind: 'goods' },
      { code: '40210', description: ' MILK   POWDER ', kind: 'goods' },
      { code: '2307 00', description: 'WINE LEES', kind: 'goods' },
      { code: 9954, description: 'Construction', kind: 'service' },
      { code: '090121', description: 'NOT DECAFFEINATED', kind: 'goods' },
      { code: '90121', description: 'COFFEE~Not decaffeinated', kind: 'goods' },
    ]);
    expect(errors).toEqual([]);
    expect(corrections).toEqual([
      { raw: '40210', code: '040210', fix: 'leading_zero_restored' },
      { raw: '2307 00', code: '230700', fix: 'spaces_removed' },
      { raw: '90121', code: '090121', fix: 'left_out_for_proper_code' },
    ]);
    expect(rows.find((r) => r.code === '090121')?.description).toBe('NOT DECAFFEINATED');
    expect(rows.find((r) => r.code === '040210')).toEqual({
      code: '040210',
      kind: 'goods',
      description: 'MILK POWDER',
      parentCode: '0402',
    });
    expect(rows.find((r) => r.code === '9954')).toMatchObject({ kind: 'service', parentCode: null });
  });

  it('reports what it cannot repair rather than guessing', () => {
    const { errors } = normaliseHsnMaster([
      { code: 'ABC', description: 'x', kind: 'goods' },
      { code: '12', description: '', kind: 'goods' },
      { code: '13', description: 'a', kind: 'goods' },
      { code: '13', description: 'b', kind: 'goods' },
    ]);
    expect(errors).toEqual(['Unusable code "ABC"', 'Code 12 has no description', 'Duplicate code 13']);
  });
});
