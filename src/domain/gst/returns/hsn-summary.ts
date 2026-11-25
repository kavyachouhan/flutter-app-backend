/**
 * HSN/SAC accumulation, shared by GSTR-1 Table 12, the Sales Summary by HSN report and the SAC
 * report, so a code's figures cannot differ between them.
 *
 * Pure. Rows are keyed by code, unit and rate; quantity is thousandths of a unit and amounts are
 * paise, and both are net of notes (credit notes carry sign -1).
 */
import type { EngineDoc } from './gstr1-engine.js';
import { ZERO_TAXED, type TaxedValue } from './model.js';
import type { InwardDoc } from './purchase-register.js';
import { col, makeSheet, type Sheet, type WorkingIssue } from './sheets.js';

export interface HsnAcc {
  hsn: string;
  uqc: string;
  ratePercent: number;
  quantity: number;
  value: TaxedValue;
}

const plus = (a: TaxedValue, b: TaxedValue, sign: number): TaxedValue => ({
  taxable: a.taxable + sign * b.taxable,
  igst: a.igst + sign * b.igst,
  cgst: a.cgst + sign * b.cgst,
  sgst: a.sgst + sign * b.sgst,
  cess: a.cess + sign * b.cess,
});

/** Adds one line into the map. Missing code, unit become `NA` and `OTH`, as the portal expects. */
export function addHsnLine(
  map: Map<string, HsnAcc>,
  line: {
    hsn: string | null;
    uqc: string | null;
    quantity: number;
    ratePercent: number;
    taxable: number;
    igst: number;
    cgst: number;
    sgst: number;
    cess: number;
  },
  sign: number,
): void {
  const key = `${line.hsn ?? 'NA'}|${line.uqc ?? 'OTH'}|${line.ratePercent}`;
  const cur = map.get(key) ?? {
    hsn: line.hsn ?? 'NA',
    uqc: line.uqc ?? 'OTH',
    ratePercent: line.ratePercent,
    quantity: 0,
    value: ZERO_TAXED,
  };
  cur.quantity += sign * line.quantity;
  cur.value = plus(cur.value, line, sign);
  map.set(key, cur);
}

export const sortedHsn = (m: ReadonlyMap<string, HsnAcc>): HsnAcc[] =>
  [...m.values()].sort((a, b) => a.hsn.localeCompare(b.hsn) || a.ratePercent - b.ratePercent);

export function hsnColumns() {
  return [
    col('hsn', 'HSN'),
    col('description', 'Description'),
    col('uqc', 'UQC'),
    col('quantity', 'Total Quantity', 'quantity', true),
    col('totalValue', 'Total Value', 'money', true),
    col('rate', 'Rate', 'percent'),
    col('taxable', 'Taxable Value', 'money', true),
    col('igst', 'Integrated Tax Amount', 'money', true),
    col('cgst', 'Central Tax Amount', 'money', true),
    col('sgst', 'State/UT Tax Amount', 'money', true),
    col('cess', 'Cess Amount', 'money', true),
  ];
}

export function hsnSheetRows(
  rows: readonly HsnAcc[],
  descriptions: ReadonlyMap<string, string> = new Map(),
) {
  return rows.map((r) => ({
    hsn: r.hsn,
    description: descriptions.get(r.hsn) ?? null,
    uqc: r.uqc,
    quantity: r.quantity,
    totalValue: r.value.taxable + r.value.igst + r.value.cgst + r.value.sgst + r.value.cess,
    rate: r.ratePercent,
    taxable: r.value.taxable,
    igst: r.value.igst,
    cgst: r.value.cgst,
    sgst: r.value.sgst,
    cess: r.value.cess,
  }));
}

const isExportSupply = (t: string): boolean => t === 'export_with_tax' || t === 'export_without_tax';

/**
 * Sales Summary by HSN: issued invoices and notes of one registration, net of credit notes, split
 * into registered-buyer and other as in GSTR-1 Table 12, with a combined sheet.
 */
export function buildHsnSales(
  docs: readonly EngineDoc[],
  descriptions: ReadonlyMap<string, string> = new Map(),
): { sheets: Sheet[]; issues: WorkingIssue[] } {
  const b2b = new Map<string, HsnAcc>();
  const b2c = new Map<string, HsnAcc>();
  const all = new Map<string, HsnAcc>();
  let pendingIrn = 0;
  let skipped = 0;
  let missingHsn = 0;
  let missingUqc = 0;

  for (const d of docs) {
    if (d.status === 'pending_irn') {
      pendingIrn++;
      continue;
    }
    if (d.status !== 'issued') {
      skipped++;
      continue;
    }
    const sign = d.kind === 'credit_note' ? -1 : 1;
    const registered = (d.customerGstin ?? d.customerUin) !== null && !isExportSupply(d.supplyType);
    for (const l of d.lines) {
      if (!l.hsn) missingHsn++;
      if (!l.uqc) missingUqc++;
      addHsnLine(registered ? b2b : b2c, l, sign);
      addHsnLine(all, l, sign);
    }
  }

  const issues: WorkingIssue[] = [];
  if (pendingIrn > 0) {
    issues.push({
      severity: 'error',
      code: 'pending_irn_excluded',
      count: pendingIrn,
      message: `${pendingIrn} document(s) are waiting for an IRN and are not valid tax invoices yet, so they are left out.`,
    });
  }
  if (skipped > 0) {
    issues.push({
      severity: 'info',
      code: 'void_or_withdrawn_excluded',
      count: skipped,
      message: `${skipped} cancelled or withdrawn document(s) are not supplies and are left out.`,
    });
  }
  if (missingHsn > 0) {
    issues.push({
      severity: 'warning',
      code: 'hsn_missing',
      count: missingHsn,
      message: `${missingHsn} line(s) have no HSN/SAC; they are listed as "NA".`,
    });
  }
  if (missingUqc > 0) {
    issues.push({
      severity: 'warning',
      code: 'uqc_missing',
      count: missingUqc,
      message: `${missingUqc} line(s) have no unit quantity code; "OTH" is used.`,
    });
  }

  const sheet = (id: string, title: string, map: Map<string, HsnAcc>, note?: string) =>
    makeSheet(id, title, hsnColumns(), hsnSheetRows(sortedHsn(map), descriptions), {
      table: id === 'hsn_all' ? 'Summary' : id === 'hsn_b2b' ? 'B2B' : 'B2C',
      ...(note ? { note } : {}),
    });

  return {
    sheets: [
      sheet('hsn_all', 'Sales summary by HSN', all, 'Net of credit notes; debit notes add.'),
      sheet('hsn_b2b', 'Sales to registered buyers', b2b),
      sheet('hsn_b2c', 'Sales to other buyers', b2c, 'Exports are listed here.'),
    ],
    issues,
  };
}

// --- SAC -------------------------------------------------------------------------------------

export type SacTransaction = 'sale' | 'sale_return' | 'purchase' | 'purchase_return';
export type SacFilter = SacTransaction | 'all';

const TRANSACTION_LABEL: Readonly<Record<SacTransaction, string>> = {
  sale: 'Sale',
  sale_return: 'Sale return',
  purchase: 'Purchase',
  purchase_return: 'Purchase return',
};

/**
 * A service code is one in chapter 99 (the services chapter of the HSN/SAC schedule) or one the
 * HSN/SAC master lists as a service. A line with no code cannot be told apart and is reported.
 */
export function isServiceCode(code: string, masterServices: ReadonlySet<string>): boolean {
  return code.startsWith('99') || masterServices.has(code);
}

interface SacAcc {
  sac: string;
  transaction: SacTransaction;
  ratePercent: number;
  value: TaxedValue;
}

/**
 * SAC report: service lines only, by code, transaction type and rate. Returns are shown as their
 * own positive rows rather than netted, so each transaction type reads as the documents do.
 */
export function buildSacReport(input: {
  readonly outward: readonly EngineDoc[];
  readonly inward: readonly InwardDoc[];
  readonly filter: SacFilter;
  readonly masterServices: ReadonlySet<string>;
  readonly descriptions?: ReadonlyMap<string, string>;
}): { sheet: Sheet; issues: WorkingIssue[] } {
  const rows = new Map<string, SacAcc>();
  let noCode = 0;
  const want = (t: SacTransaction) => input.filter === 'all' || input.filter === t;

  const add = (
    t: SacTransaction,
    l: {
      hsn: string | null;
      ratePercent: number;
      taxable: number;
      igst: number;
      cgst: number;
      sgst: number;
      cess: number;
    },
  ) => {
    if (!want(t)) return;
    if (!l.hsn) {
      noCode++;
      return;
    }
    if (!isServiceCode(l.hsn, input.masterServices)) return;
    const key = `${l.hsn}|${t}|${l.ratePercent}`;
    const cur = rows.get(key) ?? { sac: l.hsn, transaction: t, ratePercent: l.ratePercent, value: ZERO_TAXED };
    cur.value = plus(cur.value, l, 1);
    rows.set(key, cur);
  };

  for (const d of input.outward) {
    if (d.status !== 'issued') continue;
    const t: SacTransaction = d.kind === 'credit_note' ? 'sale_return' : 'sale';
    for (const l of d.lines) add(t, l);
  }
  for (const d of input.inward) {
    const t: SacTransaction = d.kind === 'debit_note' ? 'purchase_return' : 'purchase';
    for (const l of d.lines) add(t, l);
  }

  const issues: WorkingIssue[] = [];
  if (noCode > 0) {
    issues.push({
      severity: 'warning',
      code: 'line_without_code',
      count: noCode,
      message: `${noCode} line(s) have no HSN/SAC, so they could not be told apart as goods or services and are not in this report.`,
    });
  }

  const single = input.filter !== 'all';
  const sorted = [...rows.values()].sort(
    (a, b) =>
      a.sac.localeCompare(b.sac) ||
      a.transaction.localeCompare(b.transaction) ||
      a.ratePercent - b.ratePercent,
  );
  const tc = (key: string, label: string) => col(key, label, 'money', single);
  const descriptions = input.descriptions ?? new Map<string, string>();
  const sheet = makeSheet(
    'sac',
    'SAC report',
    [
      col('sac', 'SAC'),
      col('description', 'Description'),
      col('transaction', 'Transaction'),
      col('rate', 'Rate', 'percent'),
      tc('taxable', 'Taxable Value'),
      tc('igst', 'Integrated Tax'),
      tc('cgst', 'Central Tax'),
      tc('sgst', 'State/UT Tax'),
      tc('cess', 'Cess'),
      tc('total', 'Total'),
    ],
    sorted.map((r) => ({
      sac: r.sac,
      description: descriptions.get(r.sac) ?? null,
      transaction: TRANSACTION_LABEL[r.transaction],
      rate: r.ratePercent,
      taxable: r.value.taxable,
      igst: r.value.igst,
      cgst: r.value.cgst,
      sgst: r.value.sgst,
      cess: r.value.cess,
      total: r.value.taxable + r.value.igst + r.value.cgst + r.value.sgst + r.value.cess,
    })),
    single
      ? {}
      : { note: 'Totals are not shown because sales and purchases are different things to add up.' },
  );
  return { sheet, issues };
}
