/**
 * Parses a GSTR-2B statement as the GST portal ships it.
 *
 * Pure, because the portal's JSON is awkward in ways that are much easier to
 * pin down with cases than to debug against a live download: amounts are
 * rupees with decimals rather than paise, dates are `DD-MM-YYYY`, keys are
 * abbreviated (`ctin`, `inum`, `txval`), and the supplier's invoices are
 * nested two levels deep inside a per-supplier object.
 *
 * Everything here is defensive. The file is produced by someone else and
 * changes without notice, so a missing optional block is skipped rather than
 * fatal, while a missing *required* field on a row is reported — a row we
 * cannot identify is one we must not silently drop, because its absence would
 * look like a supplier who never filed.
 */

export interface ParsedPortalInvoice {
  readonly supplierGstin: string;
  readonly supplierName: string | null;
  readonly invoiceNo: string;
  /** ISO `YYYY-MM-DD`. */
  readonly invoiceDate: string;
  readonly documentType: string;
  /** Paise. */
  readonly invoiceValue: number;
  readonly taxableAmount: number;
  readonly cgst: number;
  readonly sgst: number;
  readonly igst: number;
  readonly cess: number;
  readonly placeOfSupply: string | null;
  readonly isReverseCharge: boolean;
  readonly itcAvailable: boolean | null;
  readonly itcUnavailableReason: string | null;
  readonly filedPeriod: string | null;
  readonly raw: Record<string, unknown>;
}

export interface ParseResult {
  readonly invoices: readonly ParsedPortalInvoice[];
  /** Rows that could not be read, with why. Reported, never discarded. */
  readonly errors: readonly { path: string; reason: string }[];
  /** The period the statement says it covers, as `MMYYYY` in the portal's own format. */
  readonly statementPeriod: string | null;
}

/** Rupees, as a number or a string, to integer paise. */
function toPaise(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0;
  // Only a number or a string is a plausible amount; anything else is a
  // malformed field, and coercing an object through String() would silently
  // produce NaN-then-zero rather than saying so.
  if (typeof value !== 'number' && typeof value !== 'string') return 0;
  const rupees = typeof value === 'number' ? value : Number(value.replace(/,/g, ''));
  if (!Number.isFinite(rupees)) return 0;
  // Multiply then round, not the reverse: 1234.565 must not become 123456.
  return Math.round(rupees * 100);
}

/**
 * `DD-MM-YYYY` to `YYYY-MM-DD`.
 *
 * The portal uses day-first and Postgres wants year-first. Passing it through
 * unchanged is the kind of bug that works for the first twelve days of every
 * month, which is exactly long enough to reach production.
 */
function toIsoDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const dayFirst = /^(\d{2})-(\d{2})-(\d{4})$/.exec(value.trim());
  if (dayFirst) return `${dayFirst[3]}-${dayFirst[2]}-${dayFirst[1]}`;
  const isoLike = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (isoLike) return `${isoLike[1]}-${isoLike[2]}-${isoLike[3]}`;
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number') return String(value);
  return null;
}

/**
 * The blocks of a 2B statement, and the document type each implies.
 *
 * `b2b` is the ordinary case. The others matter because a credit note the
 * supplier filed reduces the credit the shop may claim, and treating it as an
 * invoice would have the shop claiming credit it has lost.
 */
const SUPPLIER_BLOCKS: Readonly<Record<string, string>> = {
  b2b: 'b2b',
  b2ba: 'b2b_amended',
  cdnr: 'credit_note',
  cdnra: 'credit_note_amended',
  impg: 'import_goods',
  impgsez: 'import_goods_sez',
};

/**
 * Reads the statement.
 *
 * Shape, as the portal ships it:
 *   { data: { rtnprd, docdata: { b2b: [ { ctin, trdnm, inv: [ {...} ] } ] } } }
 *
 * Both `data` and `docdata` are optional wrappers in practice — some
 * downloads, and most hand-saved files, are already unwrapped — so each level
 * is tried and skipped rather than required.
 */
export function parseGstr2b(payload: unknown): ParseResult {
  const errors: { path: string; reason: string }[] = [];
  const invoices: ParsedPortalInvoice[] = [];

  const root = asRecord(payload) ?? {};
  const data = asRecord(root['data']) ?? root;
  const docData = asRecord(data['docdata']) ?? data;
  const statementPeriod = asString(data['rtnprd']);

  for (const [block, documentType] of Object.entries(SUPPLIER_BLOCKS)) {
    const suppliers = asArray(docData[block]);
    suppliers.forEach((supplierValue, supplierIndex) => {
      const supplier = asRecord(supplierValue);
      const path = `${block}[${supplierIndex}]`;
      if (!supplier) {
        errors.push({ path, reason: 'not an object' });
        return;
      }

      const supplierGstin = asString(supplier['ctin']);
      const supplierName = asString(supplier['trdnm']);

      // Invoices sit under `inv` for b2b, `nt` for credit and debit notes.
      const rows = [...asArray(supplier['inv']), ...asArray(supplier['nt'])];
      // An import block has no supplier GSTIN: the counterparty is customs.
      const isImport = block.startsWith('impg');
      if (!supplierGstin && !isImport) {
        errors.push({ path, reason: 'supplier GSTIN (ctin) missing' });
        return;
      }

      rows.forEach((rowValue, rowIndex) => {
        const row = asRecord(rowValue);
        const rowPath = `${path}.${rowIndex}`;
        if (!row) {
          errors.push({ path: rowPath, reason: 'not an object' });
          return;
        }

        const invoiceNo = asString(row['inum']) ?? asString(row['nt_num']);
        const invoiceDate = toIsoDate(row['idt'] ?? row['nt_dt']);
        if (!invoiceNo || !invoiceDate) {
          // Reported, not skipped silently: a row we cannot identify would
          // otherwise look like a supplier who never filed, and send the
          // shopkeeper chasing someone who did.
          errors.push({
            path: rowPath,
            reason: !invoiceNo ? 'invoice number missing' : 'invoice date unreadable',
          });
          return;
        }

        // Tax sits in a nested `items` array on some documents and flat on
        // others; both forms appear in real downloads.
        const items = asArray(row['items']);
        const taxFrom = (key: string): number => {
          if (items.length === 0) return toPaise(row[key]);
          let total = 0;
          for (const item of items) total += toPaise(asRecord(item)?.[key]);
          return total;
        };

        invoices.push({
          supplierGstin: supplierGstin ?? 'CUSTOMS',
          supplierName,
          invoiceNo,
          invoiceDate,
          documentType,
          invoiceValue: toPaise(row['val']),
          taxableAmount: taxFrom('txval'),
          cgst: taxFrom('camt'),
          sgst: taxFrom('samt'),
          igst: taxFrom('iamt'),
          cess: taxFrom('csamt'),
          placeOfSupply: asString(row['pos']),
          // 'Y' means yes in the portal's own encoding.
          isReverseCharge: asString(row['rev']) === 'Y',
          itcAvailable:
            asString(row['itcavl']) === null ? null : asString(row['itcavl']) === 'Y',
          itcUnavailableReason: asString(row['rsn']),
          filedPeriod: asString(row['fldprd']) ?? statementPeriod,
          raw: row,
        });
      });
    });
  }

  return { invoices, errors, statementPeriod };
}
