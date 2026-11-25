/**
 * GSTR-1A (Rule 59(1) proviso, 59(4A), Form GSTR-1A; Notification 12/2024-CT): the optional
 * return for a period whose GSTR-1 is filed and whose GSTR-3B is not. It carries:
 *   - details added since the GSTR-1 was filed: documents dated in the period that were not in the
 *     filed GSTR-1, and B2CS rows that grew;
 *   - amendments of the filed details recorded with route 'gstr1a' (no change of recipient GSTIN).
 * No offline or API schema for GSTR-1A is published in this project's data, so it is exported as
 * Excel / CA package for entry on the portal, never as a JSON file.
 */
import type { Tx } from '../../../db/tx.js';
import { amendmentDifference } from '../../../domain/gst/amendments.js';
import type { Gstr1Return, TaxedValue } from '../../../domain/gst/returns/model.js';
import { col, makeSheet, type Sheet, type WorkingIssue } from '../../../domain/gst/returns/sheets.js';
import { activeAmendments, toGstr1Amendments } from '../amendments/amendments.service.js';
import { amendmentSheet, computeGstr1, type PeriodBounds } from './returns.service.js';

const ZERO: TaxedValue = { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
const add = (a: TaxedValue, b: TaxedValue, k = 1): TaxedValue => ({
  taxable: a.taxable + k * b.taxable,
  igst: a.igst + k * b.igst,
  cgst: a.cgst + k * b.cgst,
  sgst: a.sgst + k * b.sgst,
  cess: a.cess + k * b.cess,
});
const sumLines = (lines: readonly { value: TaxedValue }[]) => lines.reduce((s, l) => add(s, l.value), ZERO);

interface AddedDoc {
  table: string;
  number: string;
  date: string;
  party: string;
  value: TaxedValue;
}

export interface Gstr1aWorkings {
  readonly form: 'gstr1a';
  readonly sheets: readonly Sheet[];
  readonly issues: readonly WorkingIssue[];
  readonly totals: { readonly taxable: number; readonly tax: number };
  readonly model: {
    readonly additions: readonly AddedDoc[];
    readonly amendments: ReturnType<typeof toGstr1Amendments>;
  };
}

/** Documents in `fresh` that the filed GSTR-1 did not report, by section. */
function additions(filed: Gstr1Return, fresh: Gstr1Return): AddedDoc[] {
  const out: AddedDoc[] = [];
  const seen = new Set<string>();
  const mark = (t: string, n: string) => seen.add(`${t}|${n}`);
  filed.b2b.forEach((p) => p.invoices.forEach((i) => mark('4A B2B', i.number)));
  filed.b2cl.forEach((g) => g.invoices.forEach((i) => mark('5 B2CL', i.number)));
  filed.exports.forEach((e) => mark('6A Exports', e.number));
  filed.creditDebitNotesRegistered.forEach((p) => p.notes.forEach((n) => mark('9B CDNR', n.number)));
  filed.creditDebitNotesUnregistered.forEach((n) => mark('9B CDNUR', n.number));
  const push = (table: string, number: string, date: string, party: string, value: TaxedValue) => {
    if (!seen.has(`${table}|${number}`)) out.push({ table, number, date, party, value });
  };
  fresh.b2b.forEach((p) =>
    p.invoices.forEach((i) => push('4A B2B', i.number, i.date, p.recipientGstin, sumLines(i.lines))),
  );
  fresh.b2cl.forEach((g) =>
    g.invoices.forEach((i) => push('5 B2CL', i.number, i.date, `POS ${g.placeOfSupply}`, sumLines(i.lines))),
  );
  fresh.exports.forEach((e) => push('6A Exports', e.number, e.date, 'Export', sumLines(e.lines)));
  fresh.creditDebitNotesRegistered.forEach((p) =>
    p.notes.forEach((n) =>
      push('9B CDNR', n.number, n.date, p.recipientGstin, add(ZERO, sumLines(n.lines), n.kind === 'credit' ? -1 : 1)),
    ),
  );
  fresh.creditDebitNotesUnregistered.forEach((n) =>
    push('9B CDNUR', n.number, n.date, `POS ${n.placeOfSupply}`, add(ZERO, sumLines(n.lines), n.kind === 'credit' ? -1 : 1)),
  );

  // B2CS is rate-wise: only the increase over what was filed is an addition (table 7).
  const key = (r: Gstr1Return['b2cs'][number]) => `${r.placeOfSupply}|${r.ratePercent}|${r.ecommerceGstin ?? ''}`;
  const filedRows = new Map(filed.b2cs.map((r) => [key(r), r.value]));
  for (const r of fresh.b2cs) {
    const delta = add(r.value, filedRows.get(key(r)) ?? ZERO, -1);
    if (delta.taxable !== 0 || delta.igst + delta.cgst + delta.sgst + delta.cess !== 0) {
      out.push({ table: '7 B2CS', number: `${r.ratePercent}%`, date: '', party: `POS ${r.placeOfSupply}`, value: delta });
    }
  }
  return out;
}

export async function computeGstr1a(
  tx: Tx,
  p: PeriodBounds,
  filed: Gstr1Return,
): Promise<Gstr1aWorkings> {
  const fresh = await computeGstr1(tx, p, { skipDocsIssued: true });
  const added = additions(filed, fresh.model);
  const periodKey = `${p.period.year}-${String(p.period.month).padStart(2, '0')}`;
  const list = await activeAmendments(tx, p.gstin, periodKey, 'gstr1a');

  const sheets: Sheet[] = [
    makeSheet(
      'gstr1a_additions',
      'Added since GSTR-1 was filed',
      [
        col('table', 'Table'),
        col('number', 'Document'),
        col('date', 'Date', 'date'),
        col('party', 'Recipient'),
        col('taxable', 'Taxable', 'money', true),
        col('igst', 'IGST', 'money', true),
        col('cgst', 'CGST', 'money', true),
        col('sgst', 'SGST', 'money', true),
        col('cess', 'Cess', 'money', true),
      ],
      added.map((a) => ({
        table: a.table,
        number: a.number,
        date: a.date,
        party: a.party,
        taxable: a.value.taxable,
        igst: a.value.igst,
        cgst: a.value.cgst,
        sgst: a.value.sgst,
        cess: a.value.cess,
      })),
      { note: 'Details of this period not in the filed GSTR-1. Enter them in GSTR-1A on the portal.' },
    ),
  ];
  if (list.length > 0) sheets.push(amendmentSheet(list, 'gstr1a_amendments', 'Amendments in GSTR-1A'));

  let total = added.reduce((s, a) => add(s, a.value), ZERO);
  for (const a of list) total = add(total, amendmentDifference(a.section, a.original, a.revised));

  const issues: WorkingIssue[] = [
    {
      severity: 'info',
      code: 'gstr1a_no_json',
      message:
        'GSTR-1A is entered on the portal (or through a GSP); this project has no GSTR-1A file format, so it is exported as Excel and CA package only. It is optional and has no late fee.',
    },
  ];
  if (added.length === 0 && list.length === 0) {
    issues.push({
      severity: 'info',
      code: 'gstr1a_nothing',
      message: 'Nothing to report: the books agree with the filed GSTR-1 and no GSTR-1A amendment is recorded.',
    });
  }
  return {
    form: 'gstr1a',
    sheets,
    issues,
    totals: { taxable: total.taxable, tax: total.igst + total.cgst + total.sgst + total.cess },
    model: { additions: added, amendments: toGstr1Amendments(list) },
  };
}
