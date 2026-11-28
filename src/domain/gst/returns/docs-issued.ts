/**
 * GSTR-1 table 13: documents issued during the period, from the number registry.
 *
 * Reads numbers, not documents, so a number that was cancelled, withdrawn or rejected still
 * counts, and a gap in the sequence (a number nobody can account for) is reported instead of
 * hidden. Pure.
 */
import type { Gstr1DocRow } from './model.js';
import { col, makeSheet, type Sheet, type WorkingIssue } from './sheets.js';

export interface IssuedNumberRow {
  readonly family: string;
  readonly seriesId: string;
  readonly number: string;
  readonly state: 'issued' | 'cancelled' | 'withdrawn' | 'rejected_before_issue';
  readonly sequenceNo: number;
}

/**
 * The portal's document-nature code and wording for each of our series families (Save GSTR-1
 * "Table 1.1.2 A"). Bill of supply is its own nature, 1A, apart from tax invoices.
 */
const NATURE: Readonly<Record<string, { code: string; nature: string }>> = {
  outward_invoice: { code: '1', nature: 'Invoices for outward supply' },
  bill_of_supply: { code: '1A', nature: 'Bill of Supply (Exempt Supply)' },
  rcm_self_invoice: {
    code: '2',
    nature: 'Invoices for inward supply from unregistered person liable under reverse charge',
  },
  debit_note_outward: { code: '4', nature: 'Debit Note' },
  credit_note: { code: '5', nature: 'Credit Note' },
  receipt_voucher: { code: '6', nature: 'Receipt voucher' },
  payment_voucher: { code: '7', nature: 'Payment Voucher' },
  refund_voucher: { code: '8', nature: 'Refund voucher' },
};

const ORDER = ['1', '1A', '2', '3', '4', '5', '6', '7', '8'];

export interface DocsIssuedResult {
  readonly sheet: Sheet;
  readonly issues: WorkingIssue[];
  /** Records for the model: how many table-13 rows exist. */
  readonly rowCount: number;
  /** The rows for the neutral model, which the payload mapper reads. */
  readonly rows: Gstr1DocRow[];
}

export function buildDocsIssued(rows: readonly IssuedNumberRow[]): DocsIssuedResult {
  const issues: WorkingIssue[] = [];
  const groups = new Map<string, IssuedNumberRow[]>();
  for (const r of rows) {
    const key = `${NATURE[r.family]?.code ?? r.family}|${r.seriesId}`;
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }

  const out = [...groups.entries()]
    .map(([key, list]) => {
      const sorted = [...list].sort((a, b) => a.sequenceNo - b.sequenceNo);
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      const total = sorted.length;
      const cancelled = sorted.filter((r) => r.state !== 'issued').length;
      const code = key.split('|')[0] ?? '';
      const nature = Object.values(NATURE).find((n) => n.code === code)?.nature ?? code;
      if (first && last) {
        const span = last.sequenceNo - first.sequenceNo + 1;
        if (span !== total) {
          issues.push({
            severity: 'error',
            code: 'document_number_gap',
            ref: nature,
            count: span - total,
            message: `${span - total} number(s) between ${first.number} and ${last.number} (${nature}) are not accounted for. Every number must be issued, cancelled or explained: numbers reserved for billing and never used can be marked cancelled.`,
          });
        }
      }
      return {
        code,
        nature,
        from: first?.number ?? '',
        to: last?.number ?? '',
        total,
        cancelled,
        net: total - cancelled,
      };
    })
    .sort((a, b) => ORDER.indexOf(a.code) - ORDER.indexOf(b.code) || a.from.localeCompare(b.from));

  const sheet = makeSheet(
    'docs',
    'Documents issued',
    [
      col('code', 'Doc Num'),
      col('nature', 'Nature of Document'),
      col('from', 'Sr. No. From'),
      col('to', 'Sr. No. To'),
      col('total', 'Total Number', 'number', true),
      col('cancelled', 'Cancelled', 'number', true),
      col('net', 'Net Issued', 'number', true),
    ],
    out,
    { table: '13' },
  );
  return { sheet, issues, rowCount: out.length, rows: out };
}
