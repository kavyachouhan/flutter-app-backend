/**
 * Computes GSTR-1 and GSTR-3B workings for a registration and period.
 *
 * Read-only: the caller (`preparePeriod`) stores the result as the period's snapshot, and exports
 * read that snapshot, so what an accountant is given is what was on screen.
 */
import type { Tx } from '../../../db/tx.js';
import { buildDocsIssued } from '../../../domain/gst/returns/docs-issued.js';
import {
  buildGstr1,
  type EngineDoc,
  type Gstr1Workings,
} from '../../../domain/gst/returns/gstr1-engine.js';
import { buildGstr3b, type Gstr3bWorkings } from '../../../domain/gst/returns/gstr3b-engine.js';
import type { Gstr9Workings } from '../../../domain/gst/returns/gstr9-engine.js';
import type { ReturnPeriod, TaxAmounts, TaxedValue } from '../../../domain/gst/returns/model.js';
import { col, makeSheet, type WorkingIssue } from '../../../domain/gst/returns/sheets.js';
import { returnsRepository } from './returns.repository.js';
import {
  runItcPeriodAfter,
  type ItcDocument,
  type ItcMovement,
  type ItcPending,
} from '../../../domain/gst/itc-engine.js';
import { itcEngineRepository } from '../itc/itc-engine.repository.js';
import { buildTable11, table11Total } from '../../../domain/gst/advances.js';
import { advancesFor } from '../advances/advances.service.js';
import {
  splitEcommerce,
  tcsByOperator,
  type Gstr1Ecommerce,
} from '../../../domain/gst/returns/ecommerce.js';
import { amendmentDifference } from '../../../domain/gst/amendments.js';
import {
  activeAmendments,
  toGstr1Amendments,
  type ActiveAmendment,
} from '../amendments/amendments.service.js';

/** What a prepared GSTR-3B proposes for credit; written as movements when the return is filed. */
export interface ItcProposal {
  readonly engine: 'v1';
  readonly movements: readonly ItcMovement[];
  readonly pending: readonly ItcPending[];
}

export interface PeriodBounds {
  readonly gstin: string;
  readonly period: ReturnPeriod;
  readonly from: string;
  readonly to: string;
}

const ZERO: TaxAmounts = { igst: 0, cgst: 0, sgst: 0, cess: 0 };

export async function computeGstr1(
  tx: Tx,
  p: PeriodBounds,
  options: {
    excludeEinvoiceFromPortal?: boolean;
    includeNonTax?: boolean;
    /** Documents already loaded for (a superset of) the window; the caller has filtered them. */
    documents?: readonly EngineDoc[];
    /** Leave out the documents-issued table, for callers that do not use it. */
    skipDocsIssued?: boolean;
  } = {},
): Promise<Gstr1Workings> {
  const all = options.documents ?? (await returnsRepository.outwardDocuments(tx, p.gstin, p.from, p.to));
  // "Don't consider non tax transactions": a document with no taxable line is not part of the
  // report. Applied before the engine so every table and total agrees.
  const documents =
    options.includeNonTax === false
      ? all.filter((d) => d.lines.some((l) => l.category === 'taxable'))
      : all;
  // Table 14: s.9(5) supplies leave tables 4-8 and are reported only there.
  const { forTables, ecommerce } = splitEcommerce(documents);
  const engine = buildGstr1({
    gstin: p.gstin,
    period: p.period,
    documents: forTables,
    options: { excludeEinvoiceFromPortal: options.excludeEinvoiceFromPortal ?? true },
  });
  const base = withEcommerce(engine, ecommerce);

  const withAmendments = await addAdvances(tx, p, await addAmendments(tx, p, base));
  if (options.skipDocsIssued) return withAmendments;
  const numbers = await returnsRepository.issuedNumbers(tx, p.gstin, p.from, p.to);
  const docs = buildDocsIssued(numbers);
  return {
    ...withAmendments,
    sheets: [...withAmendments.sheets, docs.sheet],
    issues: [...withAmendments.issues, ...docs.issues],
    model: { ...withAmendments.model, documentsIssued: docs.rows },
  };
}

/** Adds table 14 to the GSTR-1 model and sheets (see domain/gst/returns/ecommerce.ts). */
function withEcommerce(w: Gstr1Workings, e: Gstr1Ecommerce): Gstr1Workings {
  const issues = w.issues.filter((i) => i.code !== 'ecommerce_operator_not_reported');
  if (e.tcs.length === 0 && e.s9_5.length === 0) return { ...w, issues };
  const row = (nature: string, gstin: string, v: TaxedValue) => ({
    nature,
    gstin,
    taxable: v.taxable,
    igst: v.igst,
    cgst: v.cgst,
    sgst: v.sgst,
    cess: v.cess,
  });
  const sheet = makeSheet(
    'table14',
    'Supplies through e-commerce operators (table 14)',
    [
      col('nature', 'Nature of supply'),
      col('gstin', 'Operator GSTIN'),
      col('taxable', 'Net value of supplies', 'money', true),
      col('igst', 'IGST', 'money', true),
      col('cgst', 'CGST', 'money', true),
      col('sgst', 'SGST', 'money', true),
      col('cess', 'Cess', 'money', true),
    ],
    [
      ...tcsByOperator(e).map((r) => row('14(a) Operator collects TCS u/s 52', r.operatorGstin, r.value)),
      ...e.s9_5.map((r) => row('14(b) Operator pays tax u/s 9(5)', r.operatorGstin, r.value)),
    ],
    {
      note: '14(a) sales are also in tables 4-10. 14(b) sales are reported only here; the operator pays their tax.',
    },
  );
  return {
    ...w,
    issues,
    sheets: [...w.sheets, sheet],
    model: { ...w.model, ecommerce: e },
  };
}

/**
 * Table 11 (see domain/gst/advances.ts). The portal JSON layout for advances conflicts between the
 * Save schema and the manual / Offline Tool (GST_PENDING §1), so `at` / `txpd` are not written to
 * the JSON: the sheets use the Offline Tool's at.csv / atadj.csv columns for import there, and
 * the JSON export reports the section as not written.
 */
async function addAdvances(tx: Tx, p: PeriodBounds, w: Gstr1Workings): Promise<Gstr1Workings> {
  const facts = await advancesFor(tx, p.gstin, p.from, p.to);
  const t11 = buildTable11(periodKeyOf(p), facts.vouchers, facts.adjustments, facts.refunds);
  const issues = w.issues.filter((i) => i.code !== 'advances_not_computed');
  if (t11.received.length === 0 && t11.adjusted.length === 0) return { ...w, issues };
  const sheet = (id: string, title: string, label: string, rows: typeof t11.received) =>
    makeSheet(
      id,
      title,
      [
        col('pos', 'Place Of Supply'),
        col('applicable', 'Applicable % of Tax Rate'),
        col('rate', 'Rate'),
        col('taxable', label, 'money', true),
        col('igst', 'IGST', 'money', true),
        col('cgst', 'CGST', 'money', true),
        col('sgst', 'SGST', 'money', true),
        col('cess', 'Cess Amount', 'money', true),
      ],
      rows.map((r) => ({
        pos: r.placeOfSupply,
        applicable: null,
        rate: r.ratePercent,
        taxable: r.value.taxable,
        igst: r.value.igst,
        cgst: r.value.cgst,
        sgst: r.value.sgst,
        cess: r.value.cess,
      })),
      { note: 'Columns as in the Offline Tool CSV templates (at.csv / atadj.csv). Values exclude tax.' },
    );
  const sheets = [...w.sheets];
  if (t11.received.length > 0) sheets.push(sheet('at', 'Advances received (11A)', 'Gross Advance Received', t11.received));
  if (t11.adjusted.length > 0) sheets.push(sheet('atadj', 'Advances adjusted (11B)', 'Gross Advance Adjusted', t11.adjusted));
  const extra = [...issues];
  if (t11.refundsOfEarlierAdvances > 0) {
    extra.push({
      severity: 'info',
      code: 'advance_refunds_in_11b',
      count: t11.refundsOfEarlierAdvances,
      message:
        'Refunds of advances received in an earlier period are shown with 11B (the tax on them was paid then); check the treatment with your accountant.',
    });
  }
  return {
    ...w,
    sheets,
    issues: extra,
    model: {
      ...w.model,
      advances: { received: t11.received, adjusted: t11.adjusted },
      otherSections: {
        ...w.model.otherSections,
        ...(t11.received.length > 0 ? { at: t11.received.length } : {}),
        ...(t11.adjusted.length > 0 ? { txpd: t11.adjusted.length } : {}),
      },
    },
  };
}

const periodKeyOf = (p: PeriodBounds) =>
  `${p.period.year}-${String(p.period.month).padStart(2, '0')}`;

/**
 * Tables 9A / 9C / 10: amendments of earlier filed GSTR-1s reported in this one (route
 * 'later_gstr1'). GSTR-1A amendments are not here: they go in that period's GSTR-1A.
 */
async function addAmendments(tx: Tx, p: PeriodBounds, base: Gstr1Workings): Promise<Gstr1Workings> {
  const list = await activeAmendments(tx, p.gstin, periodKeyOf(p), 'later_gstr1');
  if (list.length === 0) return base;
  return {
    ...base,
    sheets: [...base.sheets, amendmentSheet(list, 'amendments', 'Amendments of earlier returns (9A, 9C, 10)')],
    model: { ...base.model, amendments: toGstr1Amendments(list) },
  };
}

const SECTION_LABEL: Readonly<Record<string, string>> = {
  b2b: '9A B2B',
  b2cl: '9A B2CL',
  exp: '9A Exports',
  cdnr: '9C CDNR',
  cdnur: '9C CDNUR',
  b2cs: '10 B2CS',
};

export function amendmentSheet(list: readonly ActiveAmendment[], id: string, title: string) {
  return makeSheet(
    id,
    title,
    [
      col('table', 'Table'),
      col('original', 'Original'),
      col('originalPeriod', 'Reported in'),
      col('reason', 'Reason'),
      col('taxable', 'Taxable difference', 'money', true),
      col('igst', 'IGST difference', 'money', true),
      col('cgst', 'CGST difference', 'money', true),
      col('sgst', 'SGST difference', 'money', true),
      col('cess', 'Cess difference', 'money', true),
    ],
    list.map((a) => {
      const d = amendmentDifference(a.section, a.original, a.revised);
      return {
        table: SECTION_LABEL[a.section] ?? a.section,
        original: a.documentKey,
        originalPeriod: a.originalPeriod,
        reason: a.reason,
        taxable: d.taxable,
        igst: d.igst,
        cgst: d.cgst,
        sgst: d.sgst,
        cess: d.cess,
      };
    }),
    { note: 'The tax on an amendment is the difference from what was reported.' },
  );
}

export async function computeGstr3b(
  tx: Tx,
  p: PeriodBounds,
  /** A GSTR-1 already worked out for the same window: its net totals do not depend on options. */
  precomputed?: Gstr1Workings,
): Promise<Gstr3bWorkings & { itc: ItcProposal }> {
  const computed = precomputed ?? (await computeGstr1(tx, p));
  // Amendments reported in this period (GSTR-1A of this period, or tables 9A/9C/10 of this
  // period's GSTR-1) change the liability by their difference; 3.1 follows GSTR-1 and 1A.
  const amendments = await activeAmendments(tx, p.gstin, periodKeyOf(p));
  const amended = amendments.length === 0 ? computed : withAmendmentDifferences(computed, amendments);
  // Tax on advances (11A) is payable in this period; tax on advances adjusted (11B) was paid earlier
  // and comes off, since the invoice now carries it.
  const adv = amended.model.advances;
  const gstr1 = adv ? withAdvanceTax(amended, adv) : amended;
  const rcm = await returnsRepository.inwardReverseCharge(tx, p.gstin, p.from, p.to);
  const credit = await returnsRepository.inwardCredit(tx, p.gstin, p.from, p.to);
  const exempt = await returnsRepository.inwardExempt(tx, p.gstin, p.from, p.to);

  const tax = (v: TaxedValue): TaxAmounts => ({
    igst: v.igst,
    cgst: v.cgst,
    sgst: v.sgst,
    cess: v.cess,
  });

  const inwardReverseCharge: TaxedValue = {
    taxable: rcm.domestic.taxable + rcm.importOfServices.taxable,
    igst: rcm.domestic.igst + rcm.importOfServices.igst,
    cgst: rcm.domestic.cgst + rcm.importOfServices.cgst,
    sgst: rcm.domestic.sgst + rcm.importOfServices.sgst,
    cess: rcm.domestic.cess + rcm.importOfServices.cess,
  };

  const outwardRcm = gstr1.model.b2b.reduce(
    (s, party) => s + party.invoices.filter((i) => i.reverseCharge).length,
    0,
  );

  // Table 4 from the ITC engine: credit claimed only to the extent conditions are met (2B,
  // goods received, s.16(4)), blocked and Rule 42/43 credit reversed, Rule 37 applied, with what
  // earlier filed returns already did (itc_movements) taken into account.
  const exemptTurnover = gstr1.net.nilExempt + gstr1.net.nonGst;
  const documents = await itcEngineRepository.documents(tx, p.gstin, p.to);
  const itc = runItcPeriodAfter(
    {
      period: p.period,
      documents,
      commonCapitalGoods: await itcEngineRepository.commonCapitalGoods(tx, p.gstin),
      turnover: {
        exempt: exemptTurnover,
        total: gstr1.net.taxable.taxable + gstr1.net.zeroRated.taxable + exemptTurnover,
      },
    },
    unfiledEarlierPeriods(
      p,
      await itcEngineRepository.lastFiledPeriod(tx, p.gstin),
      documents,
    ),
  );
  void tax;
  void ZERO;

  const result = buildGstr3b({
    gstin: p.gstin,
    period: p.period,
    gstr1: gstr1.net,
    inwardReverseCharge,
    itc: itc.table4,
    inwardExempt: {
      gst: { interState: exempt.gst.inter, intraState: exempt.gst.intra },
      nonGst: { interState: exempt.nonGst.inter, intraState: exempt.nonGst.intra },
    },
    outwardReverseChargeDocs: outwardRcm,
    pendingItcRows: 0,
  });

  const extra: WorkingIssue[] = [
    ...itc.issues.map((i) => ({ ...i })),
    {
      severity: 'info',
      code: 'rcm_time_of_supply',
      message:
        'Reverse-charge purchases are placed in the month of the bill date. From 01.11.2024 the time of supply for reverse charge is the date of the self-invoice you issue (s.13(3)(c), within 30 days of receipt under Rule 47A); check bills near a month end.',
    },
    ...gstr1.issues
      .filter((i) => i.severity === 'error')
      .map((i) => ({ ...i, message: `GSTR-1 data: ${i.message}` })),
  ];
  // Credit per the books against the latest imported GSTR-2B for the month.
  const twoB = await returnsRepository.gstr2bCredit(tx, p.gstin, p.period.year, p.period.month);
  const sheets = [...result.sheets];
  if (amendments.length > 0) {
    sheets.push(amendmentSheet(amendments, 'amendments_3b', 'Amendments reported this period'));
  }
  if (twoB) {
    const books = {
      igst: credit.importGoods.igst + credit.other.igst - credit.ineligible.igst,
      cgst: credit.importGoods.cgst + credit.other.cgst - credit.ineligible.cgst,
      sgst: credit.importGoods.sgst + credit.other.sgst - credit.ineligible.sgst,
      cess: credit.importGoods.cess + credit.other.cess - credit.ineligible.cess,
    };
    const heads = ['igst', 'cgst', 'sgst', 'cess'] as const;
    const rows = heads.map((h) => ({
      head: h.toUpperCase(),
      books: books[h],
      gstr2b: twoB.other[h],
      difference: books[h] - twoB.other[h],
    }));
    sheets.push(
      makeSheet(
        '2b_vs_books',
        'Eligible credit: books vs GSTR-2B',
        [
          col('head', 'Tax'),
          col('books', 'Per books (eligible, net of returns)', 'money', true),
          col('gstr2b', 'Per GSTR-2B (ITC available)', 'money', true),
          col('difference', 'Difference', 'money', true),
        ],
        rows,
        {
          note: 'Non-reverse-charge credit. Rows the portal marks unavailable or temporarily unavailable are not counted as 2B credit.',
        },
      ),
    );
    // Above 2B is the case the law acts on: credit can be taken only to the extent it is in
    // GSTR-2B (s.16(2)(aa), from 01.01.2022), and a 3B claim above 2B is intimated in
    // DRC-01C under Rule 88D. Below 2B is usually timing (a bill not yet entered, goods in
    // transit) and stays a note.
    const excess = rows.filter((r) => r.difference > 0);
    const short = rows.filter((r) => r.difference < 0);
    if (excess.length > 0) {
      const rupees = (paise: number) => (paise / 100).toFixed(2);
      extra.push({
        severity: 'info',
        code: 'itc_exceeds_2b',
        count: excess.length,
        message: `Credit per books is more than GSTR-2B shows (${excess
          .map((r) => `${r.head} ₹${rupees(r.difference)}`)
          .join(', ')}). Table 4 claims only what is in GSTR-2B (s.16(2)(aa)); the rest is listed under "Credit not claimable yet" and carries forward. Claiming more in GSTR-3B would bring a DRC-01C intimation (Rule 88D).`,
        ref: '2b_vs_books',
      });
    }
    if (short.length > 0) {
      extra.push({
        severity: 'info',
        code: 'itc_below_2b',
        count: short.length,
        message: `GSTR-2B shows more credit than the books in ${short.map((r) => r.head).join(', ')}. Usually a supplier bill not yet entered; review the reconciliation.`,
        ref: '2b_vs_books',
      });
    }
  } else {
    extra.push({
      severity: 'info',
      code: 'gstr2b_not_imported',
      message:
        'No GSTR-2B has been imported for this month, so credit was not compared with the portal.',
    });
  }

  const rupee = (v: number) => v;
  sheets.push(
    makeSheet(
      'itc_movements',
      'Credit worked out for this return',
      [
        col('document', 'Document'),
        col('kind', 'What happens'),
        col('rule', 'Rule'),
        col('line', 'Table 4'),
        col('igst', 'IGST', 'money', true),
        col('cgst', 'CGST', 'money', true),
        col('sgst', 'SGST', 'money', true),
        col('cess', 'Cess', 'money', true),
      ],
      itc.movements.map((m) => ({
        document: m.note,
        kind: m.kind,
        rule: m.rule,
        line: m.line.toUpperCase().replace(/^([ABD])(\d)$/, '4($1)($2)'),
        igst: rupee(m.tax.igst),
        cgst: rupee(m.tax.cgst),
        sgst: rupee(m.tax.sgst),
        cess: rupee(m.tax.cess),
      })),
      { note: 'Recorded against each document when this return is filed; carried into later returns.' },
    ),
  );
  if (itc.pending.length > 0) {
    sheets.push(
      makeSheet(
        'itc_pending',
        'Credit not claimable yet',
        [
          col('number', 'Supplier invoice'),
          col('supplier', 'Supplier GSTIN'),
          col('date', 'Date', 'date'),
          col('reason', 'Why not yet'),
          col('lastPeriod', 'Claim no later than'),
          col('igst', 'IGST', 'money', true),
          col('cgst', 'CGST', 'money', true),
          col('sgst', 'SGST', 'money', true),
          col('cess', 'Cess', 'money', true),
        ],
        itc.pending.map((x) => ({
          number: x.number,
          supplier: x.supplierGstin,
          date: x.documentDate,
          reason: PENDING_LABEL[x.reason],
          lastPeriod: x.lastClaimPeriod,
          igst: x.tax.igst,
          cgst: x.tax.cgst,
          sgst: x.tax.sgst,
          cess: x.tax.cess,
        })),
      ),
    );
  }
  // Advisory #389 (GSTN, Dec 2025, 2nd source): a negative closing balance in the Electronic
  // Credit Reversal and Re-claimed Statement or the RCM Liability/ITC Statement blocks GSTR-3B.
  const periodKey = `${p.period.year}-${String(p.period.month).padStart(2, '0')}`;
  const ecrrs = await itcEngineRepository.ecrrsBalanceBefore(tx, p.gstin, periodKey);
  if (ecrrs) {
    const heads = ['igst', 'cgst', 'sgst', 'cess'] as const;
    const closing = heads.map(
      (h) => ecrrs[h] + itc.table4.reversed.other[h] - itc.table4.ineligible.reclaimed_after_reversal[h],
    );
    if (closing.some((v) => v < 0)) {
      extra.push({
        severity: 'warning',
        code: 'ecrrs_negative',
        message:
          'Credit reclaimed in this return is more than the balance of credit reversed earlier (Electronic Credit Reversal and Re-claimed Statement). The portal does not accept a GSTR-3B that leaves this statement negative; check the reclaims or the declared opening balance.',
      });
    }
  }
  const rcmCredit = addTaxes(itc.table4.available.reverse_charge, itc.table4.available.import_services);
  const rcmPaid = {
    igst: inwardReverseCharge.igst,
    cgst: inwardReverseCharge.cgst,
    sgst: inwardReverseCharge.sgst,
    cess: inwardReverseCharge.cess,
  };
  if ((['igst', 'cgst', 'sgst', 'cess'] as const).some((h) => rcmCredit[h] > rcmPaid[h])) {
    extra.push({
      severity: 'warning',
      code: 'rcm_credit_exceeds_liability',
      message:
        'Reverse-charge credit in 4(A)(2)/(3) is more than the reverse-charge tax paid in 3.1(d) this month. Credit on reverse charge follows payment of the tax; the portal blocks a GSTR-3B that leaves the RCM Liability/ITC Statement negative.',
    });
  }

  const proposal: ItcProposal = { engine: 'v1', movements: itc.movements, pending: itc.pending };
  // 3.1.1(ii): supplies made through an operator that pays the tax under s.9(5) (from table 14(b)).
  const s95 = gstr1.model.ecommerce?.s9_5 ?? [];
  const model =
    s95.length === 0
      ? result.model
      : {
          ...result.model,
          ecommerce: {
            ecoPaysTax: { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 },
            registeredViaEco: s95.reduce((s, r) => s + r.value.taxable, 0),
          },
        };
  return { ...result, model, sheets, issues: [...result.issues, ...extra], itc: proposal };
}

function withAdvanceTax(
  w: Gstr1Workings,
  adv: NonNullable<Gstr1Workings['model']['advances']>,
): Gstr1Workings {
  const r = table11Total(adv.received);
  const a = table11Total(adv.adjusted);
  const t = w.net.taxable;
  return {
    ...w,
    net: {
      ...w.net,
      taxable: {
        taxable: t.taxable + r.taxable - a.taxable,
        igst: t.igst + r.igst - a.igst,
        cgst: t.cgst + r.cgst - a.cgst,
        sgst: t.sgst + r.sgst - a.sgst,
        cess: t.cess + r.cess - a.cess,
      },
    },
  };
}

/** 3.1(a) for B2B/B2CL/B2CS amendments and their notes, 3.1(b) for exports. */
function withAmendmentDifferences(w: Gstr1Workings, list: readonly ActiveAmendment[]): Gstr1Workings {
  let taxable = w.net.taxable;
  let zeroRated = w.net.zeroRated;
  for (const a of list) {
    const d = amendmentDifference(a.section, a.original, a.revised);
    const exportLike =
      a.section === 'exp' ||
      (a.section === 'cdnur' &&
        'unregisteredType' in a.revised &&
        a.revised.unregisteredType !== undefined &&
        a.revised.unregisteredType !== 'b2cl');
    const add = (v: TaxedValue): TaxedValue => ({
      taxable: v.taxable + d.taxable,
      igst: v.igst + d.igst,
      cgst: v.cgst + d.cgst,
      sgst: v.sgst + d.sgst,
      cess: v.cess + d.cess,
    });
    if (exportLike) zeroRated = add(zeroRated);
    else taxable = add(taxable);
  }
  return {
    ...w,
    net: { ...w.net, taxable, zeroRated },
    issues: [
      ...w.issues,
      {
        severity: 'info',
        code: 'amendments_in_3b',
        count: list.length,
        message: `${list.length} amendment(s) reported this period change 3.1 by their difference. Inter-state B2C amendments are not moved in 3.2; check it.`,
      },
    ],
  };
}

const addTaxes = (a: TaxAmounts, b: TaxAmounts): TaxAmounts => ({
  igst: a.igst + b.igst,
  cgst: a.cgst + b.cgst,
  sgst: a.sgst + b.sgst,
  cess: a.cess + b.cess,
});

const PENDING_LABEL: Readonly<Record<ItcPending['reason'], string>> = {
  not_in_2b: 'Not in GSTR-2B yet',
  in_later_2b: 'In a later GSTR-2B',
  goods_not_received: 'Goods or services not received',
  receipt_incomplete: 'Waiting for the last lot',
};

/** The stored, JSON-safe form of a workings object (drops engine-internal maps). */
export function toStoredWorkings(
  w: Gstr1Workings | Gstr3bWorkings | Gstr9Workings,
): Record<string, unknown> {
  const { net: _net, ...rest } = w as Gstr1Workings;
  void _net;
  return rest;
}

/**
 * The return periods between the last filed GSTR-3B and `p` (oldest first), in steps of the
 * period's length (one month, or three for a quarterly filer). With nothing filed, from the
 * earliest open document, at most three years back.
 */
function unfiledEarlierPeriods(
  p: PeriodBounds,
  lastFiled: { year: number; month: number } | null,
  documents: readonly ItcDocument[],
): { year: number; month: number }[] {
  const index = (y: number, m: number) => y * 12 + (m - 1);
  const target = index(p.period.year, p.period.month);
  const span =
    (Number(p.to.slice(0, 4)) - Number(p.from.slice(0, 4))) * 12 +
    (Number(p.to.slice(5, 7)) - Number(p.from.slice(5, 7))) +
    1;
  let start: number;
  if (lastFiled) {
    start = index(lastFiled.year, lastFiled.month) + span;
  } else {
    const open = documents.filter((d) => !d.history.closed).map((d) => d.documentDate);
    if (open.length === 0) return [];
    const earliest = open.reduce((a, b) => (a < b ? a : b));
    start = index(Number(earliest.slice(0, 4)), Number(earliest.slice(5, 7)));
    // Align to the period grid ending at the target.
    start = target - Math.ceil((target - start) / span) * span;
  }
  start = Math.max(start, target - 36);
  const out: { year: number; month: number }[] = [];
  for (let i = start; i < target; i += span) {
    out.push({ year: Math.floor(i / 12), month: (i % 12) + 1 });
  }
  return out;
}
