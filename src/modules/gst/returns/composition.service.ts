/**
 * CMP-08 and GSTR-4 workings for a composition registration (see
 * domain/gst/returns/composition-engine.ts). Read-only; the period service stores the result.
 */
import type { Tx } from '../../../db/tx.js';
import { DEFAULT_COMPOSITION_RATES } from '../../../domain/gst/composition.js';
import {
  COMPOSITION_ISSUES,
  cmp08Figures,
  cmp08Sheet,
  compositionTurnover,
  gstr4InwardSheet,
  gstr4SummarySheets,
  type CompositionCategory,
  type InwardDocument,
  type QuarterFigures,
} from '../../../domain/gst/returns/composition-engine.js';
import type { TaxedValue } from '../../../domain/gst/returns/model.js';
import type { Sheet, WorkingIssue } from '../../../domain/gst/returns/sheets.js';
import { returnsRepository } from './returns.repository.js';

export interface CompositionWorkings {
  readonly form: 'cmp08' | 'gstr4';
  readonly sheets: readonly Sheet[];
  readonly issues: readonly WorkingIssue[];
  readonly totals: { readonly taxable: number; readonly tax: number };
  readonly model: Record<string, unknown>;
}

const n = (v: unknown) => Number(v ?? 0);

/** The composition rate and category on a date: the registration profile, else the tenant setting. */
async function rateFor(tx: Tx, gstin: string, date: string): Promise<{ rate: number; category: CompositionCategory }> {
  const row = await tx.one<{ rate: string | null; category: CompositionCategory | null; tRate: string | null; tCategory: CompositionCategory | null }>(
    `SELECT p.composition_rate_percent AS rate, p.composition_category AS category,
            (SELECT composition_rate_percent FROM tenants WHERE id = app.current_tenant_id()) AS "tRate",
            (SELECT composition_category FROM tenants WHERE id = app.current_tenant_id()) AS "tCategory"
     FROM gst_registrations r
     LEFT JOIN gst_registration_profiles p ON p.registration_id = r.id
       AND p.effective_from <= $2::date AND (p.effective_to IS NULL OR p.effective_to > $2::date)
     WHERE r.gstin = $1 AND r.deleted_at IS NULL LIMIT 1`,
    [gstin, date],
  );
  const category = row?.category ?? row?.tCategory ?? 'trader';
  const rate = row?.rate ?? row?.tRate;
  return { category, rate: rate !== null && rate !== undefined ? Number(rate) : DEFAULT_COMPOSITION_RATES[category] };
}

async function quarterFigures(tx: Tx, gstin: string, from: string, to: string) {
  const { rate, category } = await rateFor(tx, gstin, to);
  const docs = await returnsRepository.outwardDocuments(tx, gstin, from, to);
  const rcm = await returnsRepository.inwardReverseCharge(tx, gstin, from, to);
  const inward: TaxedValue = {
    taxable: rcm.domestic.taxable + rcm.importOfServices.taxable,
    igst: rcm.domestic.igst + rcm.importOfServices.igst,
    cgst: rcm.domestic.cgst + rcm.importOfServices.cgst,
    sgst: rcm.domestic.sgst + rcm.importOfServices.sgst,
    cess: rcm.domestic.cess + rcm.importOfServices.cess,
  };
  return { rate, category, figures: cmp08Figures(compositionTurnover(docs, category), rate, inward) };
}

export async function computeCmp08(tx: Tx, gstin: string, from: string, to: string): Promise<CompositionWorkings> {
  const { rate, category, figures } = await quarterFigures(tx, gstin, from, to);
  const tax = figures.payable.igst + figures.payable.cgst + figures.payable.sgst + figures.payable.cess;
  return {
    form: 'cmp08',
    sheets: [cmp08Sheet(figures, rate)],
    issues: [
      ...COMPOSITION_ISSUES,
      {
        severity: 'info',
        code: 'composition_rate',
        message: `Composition category ${category}, rate ${rate}%. Tax is paid from the cash ledger only.`,
      },
    ],
    totals: { taxable: figures.outwardTax.taxable, tax },
    model: { ratePercent: rate, category, figures },
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const lastDay = (y: number, m: number) =>
  `${y}-${String(m).padStart(2, '0')}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;

export async function computeGstr4(tx: Tx, gstin: string, fyStartYear: number): Promise<CompositionWorkings> {
  const quarters: QuarterFigures[] = [];
  let rate = 0;
  for (let q = 0; q < 4; q++) {
    const startMonth = 4 + q * 3;
    const y = startMonth > 12 ? fyStartYear + 1 : fyStartYear;
    const m = ((startMonth - 1) % 12) + 1;
    const from = `${y}-${String(m).padStart(2, '0')}-01`;
    const to = lastDay(y, m + 2);
    const r = await quarterFigures(tx, gstin, from, to);
    rate = r.rate;
    quarters.push({ quarter: `${MONTHS[m - 1]}-${MONTHS[m + 1]} ${y}`, figures: r.figures });
  }
  const inward = await inwardDocuments(tx, gstin, `${fyStartYear}-04-01`, `${fyStartYear + 1}-03-31`);
  const payable = quarters.reduce((s, q) => s + q.figures.payable.cgst + q.figures.payable.sgst + q.figures.payable.igst + q.figures.payable.cess, 0);
  const turnover = quarters.reduce((s, q) => s + q.figures.turnover.goods + q.figures.turnover.services + q.figures.turnover.servicesViaEco95, 0);
  return {
    form: 'gstr4',
    sheets: [gstr4InwardSheet(inward), ...gstr4SummarySheets(quarters, rate)],
    issues: [
      ...COMPOSITION_ISSUES,
      {
        severity: 'info',
        code: 'gstr4_tables_not_computed',
        message:
          'Table 7 (TDS/TCS credit received) and Table 8 (interest and late fee) are not worked out here; enter them on the portal. Due by 30 June after the year (Rule 62, 12/2024-CT).',
      },
    ],
    totals: { taxable: turnover, tax: payable },
    model: { ratePercent: rate, quarters, inward },
  };
}

/** Purchase bills of the year, rate-wise per bill (GSTR-4 Table 4 is invoice-wise). */
async function inwardDocuments(tx: Tx, gstin: string, from: string, to: string): Promise<InwardDocument[]> {
  const rows = await tx.many<Record<string, unknown>>(
    `SELECT b.supplier_gstin AS gstin, s.name, b.supplier_invoice_no AS number,
            b.supplier_invoice_date::text AS date, b.is_reverse_charge AS rcm,
            COALESCE(s.country_code, 'IN') <> 'IN' AS foreign, b.place_of_supply_state_code AS pos,
            l.tax_rate_percent::float AS rate, SUM(l.taxable_amount) AS taxable,
            SUM(l.igst) AS igst, SUM(l.cgst) AS cgst, SUM(l.sgst) AS sgst, SUM(l.cess) AS cess
     FROM purchase_bills b
     JOIN purchase_bill_lines l ON l.purchase_bill_id = b.id
     JOIN suppliers s ON s.id = b.supplier_id
     LEFT JOIN gst_registrations reg ON reg.id = b.registration_id
     WHERE b.status <> 'void' AND (reg.gstin IS NULL OR reg.gstin = $1)
       AND b.supplier_invoice_date >= $2::date AND b.supplier_invoice_date <= $3::date
     GROUP BY b.id, s.name, s.country_code, l.tax_rate_percent
     ORDER BY b.supplier_invoice_date, b.id`,
    [gstin, from, to],
  );
  return rows.map((r) => ({
    supplierGstin: (r['gstin'] as string | null) ?? null,
    supplierName: (r['name'] as string | null) ?? null,
    number: String(r['number']),
    date: String(r['date']),
    reverseCharge: Boolean(r['rcm']),
    importOfServices: Boolean(r['foreign']) && Boolean(r['rcm']),
    placeOfSupply: (r['pos'] as string | null) ?? null,
    ratePercent: Number(r['rate']),
    value: { taxable: n(r['taxable']), igst: n(r['igst']), cgst: n(r['cgst']), sgst: n(r['sgst']), cess: n(r['cess']) },
  }));
}
