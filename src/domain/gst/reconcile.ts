/**
 * GSTR-2B reconciliation: what the shop's purchase register says against what
 * its suppliers actually filed.
 *
 * Pure, because the matching rules are the whole feature and they need to be
 * testable against cases rather than against a database.
 *
 * The outcome that matters is `missing_in_2b`: a bill in our books that no
 * supplier reported. That is input tax the shop has already paid and cannot
 * reclaim until the supplier files, and nothing else in the system can see it.
 * Everything here exists to make that list short and trustworthy — a
 * reconciliation that cries wolf is worse than none, because the shopkeeper
 * stops reading it.
 */
import { normaliseInvoiceNumber } from './classify.js';

export type MatchType = 'exact' | 'probable' | 'missing_in_books' | 'missing_in_2b' | 'mismatch';

/** A row as the portal filed it. */
export interface PortalInvoice {
  readonly id: string;
  readonly supplierGstin: string;
  readonly invoiceNo: string;
  readonly invoiceDate: string;
  readonly taxableAmount: number;
  readonly totalTax: number;
}

/** A purchase bill as the shop entered it. */
export interface BookInvoice {
  readonly id: string;
  readonly supplierGstin: string | null;
  readonly supplierInvoiceNo: string;
  readonly supplierInvoiceDate: string;
  readonly taxableAmount: number;
  readonly totalTax: number;
}

export interface MatchResult {
  readonly matchType: MatchType;
  readonly portalInvoiceId: string | undefined;
  readonly bookInvoiceId: string | undefined;
  /** `{field: {ours, theirs}}`, for a mismatch. */
  readonly differences: Record<string, { ours: number | string; theirs: number | string }> | undefined;
  /** Signed paise: positive means the portal shows more tax than our books. */
  readonly taxDifference: number;
}

export interface ReconcileRules {
  /**
   * Paise of tax difference treated as equal. Rounding genuinely differs
   * between two systems computing the same invoice, and a one-paisa
   * discrepancy is not worth a shopkeeper's attention.
   */
  readonly taxTolerancePaise: number;
  /**
   * Days a supplier's invoice date may differ from ours and still match. A
   * date keyed a day out is common; a date a month out is a different invoice.
   */
  readonly dateToleranceDays: number;
}

export const DEFAULT_RECONCILE_RULES: ReconcileRules = {
  taxTolerancePaise: 100,
  dateToleranceDays: 7,
};

function daysBetween(a: string, b: string): number {
  const ms = Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`));
  return Math.round(ms / 86_400_000);
}

/** GSTIN plus the normalised invoice number: the key a confident match needs. */
function strongKey(gstin: string, invoiceNo: string): string {
  return `${gstin}|${normaliseInvoiceNumber(invoiceNo)}`;
}

/**
 * Reconciles one period's portal rows against the shop's bills.
 *
 * Three passes, narrowing in confidence:
 *
 *   1. **Strong key.** Same GSTIN and same normalised invoice number. If the
 *      amounts agree within tolerance it is `exact`; if not it is `mismatch`,
 *      which is the useful case — the document is the same, so one side has
 *      keyed a figure wrong and the shop may be claiming the wrong credit.
 *   2. **Amount and date.** Same GSTIN, tax within tolerance, date within a
 *      few days, but the numbers differ. That is `probable`, never automatic:
 *      it needs a human to confirm, because accepting it wrongly claims credit
 *      against someone else's invoice.
 *   3. **Whatever is left.** A portal row with no bill is `missing_in_books` —
 *      usually a bill nobody entered, occasionally one filed against the wrong
 *      GSTIN. A bill with no portal row is `missing_in_2b`, the one to chase.
 *
 * A bill with no supplier GSTIN is skipped entirely rather than reported
 * missing: an unregistered supplier files nothing, so its absence from 2B is
 * correct and listing it would bury the real gaps.
 */
export function reconcile(
  portal: readonly PortalInvoice[],
  books: readonly BookInvoice[],
  rules: ReconcileRules = DEFAULT_RECONCILE_RULES,
): MatchResult[] {
  const results: MatchResult[] = [];
  const usedPortal = new Set<string>();
  const usedBooks = new Set<string>();

  const matchable = books.filter((bill) => bill.supplierGstin !== null);

  // Pass 1: the strong key.
  const booksByKey = new Map<string, BookInvoice[]>();
  for (const bill of matchable) {
    const key = strongKey(bill.supplierGstin as string, bill.supplierInvoiceNo);
    const bucket = booksByKey.get(key) ?? [];
    bucket.push(bill);
    booksByKey.set(key, bucket);
  }

  for (const row of portal) {
    const candidates = booksByKey.get(strongKey(row.supplierGstin, row.invoiceNo));
    const bill = candidates?.find((candidate) => !usedBooks.has(candidate.id));
    if (!bill) continue;

    usedPortal.add(row.id);
    usedBooks.add(bill.id);

    const taxDifference = row.totalTax - bill.totalTax;
    const taxableDifference = row.taxableAmount - bill.taxableAmount;
    const withinTolerance =
      Math.abs(taxDifference) <= rules.taxTolerancePaise &&
      Math.abs(taxableDifference) <= rules.taxTolerancePaise;

    if (withinTolerance) {
      results.push({
        matchType: 'exact',
        portalInvoiceId: row.id,
        bookInvoiceId: bill.id,
        differences: undefined,
        taxDifference,
      });
      continue;
    }

    const differences: Record<string, { ours: number | string; theirs: number | string }> = {};
    if (Math.abs(taxDifference) > rules.taxTolerancePaise) {
      differences['totalTax'] = { ours: bill.totalTax, theirs: row.totalTax };
    }
    if (Math.abs(taxableDifference) > rules.taxTolerancePaise) {
      differences['taxableAmount'] = { ours: bill.taxableAmount, theirs: row.taxableAmount };
    }
    if (bill.supplierInvoiceDate !== row.invoiceDate) {
      differences['invoiceDate'] = { ours: bill.supplierInvoiceDate, theirs: row.invoiceDate };
    }
    results.push({
      matchType: 'mismatch',
      portalInvoiceId: row.id,
      bookInvoiceId: bill.id,
      differences,
      taxDifference,
    });
  }

  // Pass 2: same supplier, amounts and date close, numbers differ.
  for (const row of portal) {
    if (usedPortal.has(row.id)) continue;
    const bill = matchable.find(
      (candidate) =>
        !usedBooks.has(candidate.id) &&
        candidate.supplierGstin === row.supplierGstin &&
        Math.abs(candidate.totalTax - row.totalTax) <= rules.taxTolerancePaise &&
        daysBetween(candidate.supplierInvoiceDate, row.invoiceDate) <= rules.dateToleranceDays,
    );
    if (!bill) continue;

    usedPortal.add(row.id);
    usedBooks.add(bill.id);
    results.push({
      matchType: 'probable',
      portalInvoiceId: row.id,
      bookInvoiceId: bill.id,
      differences: {
        invoiceNo: { ours: bill.supplierInvoiceNo, theirs: row.invoiceNo },
      },
      taxDifference: row.totalTax - bill.totalTax,
    });
  }

  // Pass 3: the remainder.
  for (const row of portal) {
    if (usedPortal.has(row.id)) continue;
    results.push({
      matchType: 'missing_in_books',
      portalInvoiceId: row.id,
      bookInvoiceId: undefined,
      differences: undefined,
      taxDifference: row.totalTax,
    });
  }
  for (const bill of matchable) {
    if (usedBooks.has(bill.id)) continue;
    results.push({
      matchType: 'missing_in_2b',
      portalInvoiceId: undefined,
      bookInvoiceId: bill.id,
      differences: undefined,
      // Negative: this is credit our books claim and the portal does not
      // support, which is the figure at risk.
      taxDifference: -bill.totalTax,
    });
  }

  return results;
}

/** Counts by outcome, for the import's progress row. */
export function summarise(results: readonly MatchResult[]): Record<MatchType, number> {
  const counts: Record<MatchType, number> = {
    exact: 0,
    probable: 0,
    missing_in_books: 0,
    missing_in_2b: 0,
    mismatch: 0,
  };
  for (const result of results) counts[result.matchType] += 1;
  return counts;
}

/**
 * Input tax credit at risk: the tax on bills the portal does not support.
 *
 * The single number the feature exists to produce. Returned as a positive
 * amount — it is an exposure, and showing it negative because the internal
 * sign convention says so would be a UI bug waiting to happen.
 */
export function creditAtRisk(results: readonly MatchResult[]): number {
  return results
    .filter((result) => result.matchType === 'missing_in_2b')
    .reduce((total, result) => total + Math.abs(result.taxDifference), 0);
}
