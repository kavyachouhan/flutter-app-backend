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
  const base = buildGstr1({
    gstin: p.gstin,
    period: p.period,
    documents,
    options: { excludeEinvoiceFromPortal: options.excludeEinvoiceFromPortal ?? true },
  });

  if (options.skipDocsIssued) return base;
  const numbers = await returnsRepository.issuedNumbers(tx, p.gstin, p.from, p.to);
  const docs = buildDocsIssued(numbers);
  return {
    ...base,
    sheets: [...base.sheets, docs.sheet],
    issues: [...base.issues, ...docs.issues],
    model: { ...base.model, documentsIssued: docs.rows },
  };
}

export async function computeGstr3b(
  tx: Tx,
  p: PeriodBounds,
  /** A GSTR-1 already worked out for the same window: its net totals do not depend on options. */
  precomputed?: Gstr1Workings,
): Promise<Gstr3bWorkings> {
  const gstr1 = precomputed ?? (await computeGstr1(tx, p));
  const rcm = await returnsRepository.inwardReverseCharge(tx, p.from, p.to);
  const credit = await returnsRepository.inwardCredit(tx, p.gstin, p.from, p.to);
  const exempt = await returnsRepository.inwardExempt(tx, p.from, p.to);

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

  const result = buildGstr3b({
    gstin: p.gstin,
    period: p.period,
    gstr1: gstr1.net,
    inwardReverseCharge,
    itc: {
      available: {
        import_goods: credit.importGoods,
        import_services: tax(rcm.importOfServices),
        reverse_charge: tax(rcm.domestic),
        isd: ZERO,
        other: credit.other,
      },
      reversed: {
        rules_38_42_43_17_5: {
          igst: credit.ineligible.igst + rcm.domesticIneligible.igst,
          cgst: credit.ineligible.cgst + rcm.domesticIneligible.cgst,
          sgst: credit.ineligible.sgst + rcm.domesticIneligible.sgst,
          cess: credit.ineligible.cess + rcm.domesticIneligible.cess,
        },
        other: ZERO,
      },
      ineligible: { reclaimed_after_reversal: ZERO, section_16_4_or_pos: ZERO },
    },
    inwardExempt: {
      gst: { interState: exempt.gst.inter, intraState: exempt.gst.intra },
      nonGst: { interState: exempt.nonGst.inter, intraState: exempt.nonGst.intra },
    },
    outwardReverseChargeDocs: outwardRcm,
    pendingItcRows: 0,
  });

  const extra: WorkingIssue[] = [
    {
      severity: 'info',
      code: 'rcm_time_of_supply',
      message:
        'Reverse-charge purchases are placed in the month of the bill date. The time-of-supply rule for reverse charge is not applied here; check bills near a month end.',
    },
    ...gstr1.issues
      .filter((i) => i.severity === 'error')
      .map((i) => ({ ...i, message: `GSTR-1 data: ${i.message}` })),
  ];
  // Credit per the books against the latest imported GSTR-2B for the month.
  const twoB = await returnsRepository.gstr2bCredit(tx, p.gstin, p.period.year, p.period.month);
  const sheets = [...result.sheets];
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
    const off = rows.filter((r) => r.difference !== 0);
    if (off.length > 0) {
      extra.push({
        severity: 'warning',
        code: 'itc_differs_from_2b',
        count: off.length,
        message: `Eligible credit per books differs from GSTR-2B in ${off.map((r) => r.head).join(', ')}. Review the reconciliation before claiming.`,
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

  return { ...result, sheets, issues: [...result.issues, ...extra] };
}

/** The stored, JSON-safe form of a workings object (drops engine-internal maps). */
export function toStoredWorkings(
  w: Gstr1Workings | Gstr3bWorkings | Gstr9Workings,
): Record<string, unknown> {
  const { net: _net, ...rest } = w as Gstr1Workings;
  void _net;
  return rest;
}
