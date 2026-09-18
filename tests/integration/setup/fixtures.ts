/**
 * Builders for the objects a billing test needs. Everything goes through the
 * API for the same reason the tenant factory does: a fixture that INSERTs
 * directly would keep passing after the endpoint it stands in for breaks.
 */
import { randomUUID } from 'node:crypto';
import { data } from './body.js';
import type { TenantFixture } from './tenant.js';

export interface ItemOptions {
  name?: string;
  salePrice?: number;
  taxRatePercent?: number;
  trackStock?: boolean;
  itemType?: 'goods' | 'service';
  barcodes?: string[];
}

export async function createItem(
  t: TenantFixture,
  options: ItemOptions = {},
): Promise<{ id: string; salePrice: number; taxRatePercent: number }> {
  const id = randomUUID();
  const salePrice = options.salePrice ?? 10_000;
  const taxRatePercent = options.taxRatePercent ?? 18;
  await t
    .post('/v1/items')
    .send({
      id,
      itemType: options.itemType ?? 'goods',
      name: options.name ?? `Item ${id.slice(0, 8)}`,
      taxRatePercent,
      unit: 'pcs',
      salePrice,
      trackStock: options.trackStock ?? true,
      pricesIncludeTax: false,
      ...(options.barcodes ? { barcodes: options.barcodes } : {}),
    })
    .expect(201);
  return { id, salePrice, taxRatePercent };
}

export async function createCustomer(
  t: TenantFixture,
  options: { name?: string; creditLimit?: number | null; openingBalance?: number } = {},
): Promise<{ id: string }> {
  const id = randomUUID();
  await t
    .post('/v1/customers')
    .send({
      id,
      name: options.name ?? `Customer ${id.slice(0, 8)}`,
      creditLimit: options.creditLimit ?? null,
      ...(options.openingBalance ? { openingBalance: options.openingBalance } : {}),
    })
    .expect(201);
  return { id };
}

/** The financial year a date falls in, for an April-start year. */
export function fyStartYear(date = new Date()): number {
  return date.getUTCMonth() + 1 >= 4 ? date.getUTCFullYear() : date.getUTCFullYear() - 1;
}

export interface SeriesFixture {
  id: string;
  outletId: string;
  counterId: string | null;
}

/**
 * `document_series_scope_uq` is unique on
 * (tenant, outlet, counter, document_type, fy_start_year) — prefix is not part
 * of it. A tenant therefore gets exactly one invoice series per counter per
 * financial year, so a test wanting a second series must vary the scope;
 * `fyStartYear` is the cheapest dimension to move.
 *
 * Series used to issue invoices must keep the current year, because the
 * document date has to fall inside the series' financial year.
 */
export async function createSeries(
  t: TenantFixture,
  options: {
    counterId?: string | null;
    prefix?: string;
    documentType?: string;
    fyStartYear?: number;
  } = {},
): Promise<SeriesFixture> {
  const id = randomUUID();
  const counterId = options.counterId === undefined ? t.counterId : options.counterId;
  await t
    .post('/v1/numbering/series')
    .send({
      id,
      outletId: t.outletId,
      counterId,
      documentType: options.documentType ?? 'invoice',
      fyStartYear: options.fyStartYear ?? fyStartYear(),
      prefix: options.prefix ?? 'INV',
      includeOutletCode: false,
      includeCounterCode: false,
      includeFinancialYear: true,
      padding: 4,
      separator: '/',
      startingSequence: 1,
    })
    .expect(201);
  return { id, outletId: t.outletId, counterId };
}

export interface Lease {
  block: { id: string; startSeq: number; endSeq: number };
}

export async function leaseBlock(
  t: TenantFixture,
  seriesId: string,
  blockSize = 10,
): Promise<Lease['block']> {
  const res = await t
    .post(`/v1/numbering/series/${seriesId}/leases`)
    .send({ blockSize })
    .expect(201);
  return data<Lease>(res).block;
}

/** Today as YYYY-MM-DD, which is what `isoDate` expects. */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface InvoiceLineSpec {
  itemId: string;
  /** Thousandths of a unit. */
  quantity: number;
  unitPrice: number;
  taxRatePercent: number;
}

/**
 * Totals for exclusive-price, intra-state lines with no discount, computed the
 * long way on purpose. Deriving them from the server's own tax engine would
 * make TOTALS_MISMATCH untestable — the two sides could drift together and the
 * assertion would never notice.
 */
export function expectedTotals(lines: InvoiceLineSpec[]): {
  grandTotal: number;
  totalTax: number;
  taxableAmount: number;
} {
  let taxableAmount = 0;
  let totalTax = 0;
  for (const line of lines) {
    const gross = Math.round((line.quantity * line.unitPrice) / 1000);
    const tax = Math.round((gross * line.taxRatePercent) / 100);
    taxableAmount += gross;
    totalTax += tax;
  }
  return { taxableAmount, totalTax, grandTotal: taxableAmount + totalTax };
}

export interface IssueInvoiceOptions {
  seriesId: string;
  sequenceNo: number;
  lines: InvoiceLineSpec[];
  customerId?: string | null;
  payments?: { id: string; mode: string; amount: number }[];
  id?: string;
  /** Overrides the computed totals, to provoke TOTALS_MISMATCH. */
  totalsOverride?: { grandTotal: number; totalTax: number; taxableAmount: number };
}

export function invoicePayload(t: TenantFixture, options: IssueInvoiceOptions) {
  return {
    id: options.id ?? randomUUID(),
    outletId: t.outletId,
    counterId: t.counterId,
    seriesId: options.seriesId,
    sequenceNo: options.sequenceNo,
    documentDate: today(),
    issuedAt: new Date().toISOString(),
    customerId: options.customerId ?? null,
    placeOfSupplyStateCode: '27',
    pricesIncludeTax: false,
    roundOff: false,
    lines: options.lines.map((line) => ({
      id: randomUUID(),
      itemId: line.itemId,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      taxRatePercent: line.taxRatePercent,
    })),
    ...(options.payments ? { payments: options.payments } : {}),
    expectedTotals: options.totalsOverride ?? expectedTotals(options.lines),
  };
}
