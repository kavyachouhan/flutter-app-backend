/**
 * The compliance group: GSTR-1 tables, GSTR-3B, 2B reconciliation and the ITC
 * register, as reports rather than as prepared returns.
 *
 * These read the *live* documents, so they answer "what would this period
 * look like if I filed it now" — which is what an accountant wants halfway
 * through a month. A prepared return is the other thing: a snapshot that must
 * not move once filed. Both exist because they answer different questions, and
 * confusing them is how a filed return silently restates itself.
 *
 * Every one of these is scoped by GSTIN, not by outlet. A business trading in
 * two states files a return per registration, and a figure spanning both is
 * wrong for either.
 */
import type { Tx } from '../../../db/tx.js';
import { B2CL_THRESHOLD_PAISE } from '../../../domain/gst/classify.js';
import { dateRange, gstinScope } from '../reports.filters.js';
import { Params, type ReportParams, type ReportRow } from '../reports.types.js';

/** The tax columns every GSTR-1 table shows, over an alias. */
const TAX_COLUMNS = (a: string) => `
  ${a}.taxable_amount AS "taxableAmount",
  ${a}.total_cgst AS "cgst", ${a}.total_sgst AS "sgst",
  ${a}.total_igst AS "igst", ${a}.total_cess AS "cess",
  ${a}.grand_total AS "invoiceValue"`;

/**
 * GSTR-1 table 4: supplies to a registered buyer, invoice by invoice.
 *
 * Itemised rather than aggregated because the buyer's input tax credit depends
 * on their invoice appearing here exactly as they hold it. A wrong figure in
 * this table is the buyer's problem before it is the shop's, which is what
 * makes it the table most worth checking.
 */
export async function gstr1B2b(tx: Tx, params: ReportParams): Promise<ReportRow[]> {
  const p = new Params();
  const sql = `
    SELECT i.document_date AS "date", i.document_number AS "documentNumber",
           i.customer_gstin AS "customerGstin", i.customer_name AS "customerName",
           i.place_of_supply_state_code AS "placeOfSupply",
           i.supply_type AS "supplyType", i.is_reverse_charge::text AS "reverseCharge",
           ${TAX_COLUMNS('i')}
    FROM invoices i
    WHERE i.status = 'issued' AND i.customer_gstin IS NOT NULL
      AND i.supply_type IN ('intra_state', 'inter_state')
      AND ${gstinScope(p, 'i', params)} AND ${dateRange(p, 'i.document_date', params)}
    ORDER BY i.document_date, i.document_number
    LIMIT ${p.add(params.limit)}`;
  return tx.many(sql, p.all);
}

/**
 * GSTR-1 tables 5 and 7: supplies to unregistered buyers.
 *
 * Both in one report because they are one decision seen twice. An inter-state
 * sale above ₹2.5 lakh is reported individually (B2CL); everything else is a
 * rate-wise total per place of supply (B2CS). The `table` column says which,
 * so an accountant sees the split the form expects rather than having to
 * recompute the threshold.
 *
 * B2CS is aggregated because the portal will not take a row per corner-shop
 * sale, and a shop doing two hundred bills a day would file something nobody
 * could upload.
 */
export async function gstr1B2c(tx: Tx, params: ReportParams): Promise<ReportRow[]> {
  const p = new Params();
  const threshold = p.add(B2CL_THRESHOLD_PAISE);
  const sql = `
    WITH b2c AS (
      SELECT i.id, i.document_date, i.document_number, i.supply_type,
             i.place_of_supply_state_code, i.grand_total,
             i.grand_total > ${threshold}::bigint AND i.supply_type = 'inter_state' AS large
      FROM invoices i
      WHERE i.status = 'issued' AND i.customer_gstin IS NULL
        AND i.supply_type IN ('intra_state', 'inter_state')
        AND ${gstinScope(p, 'i', params)} AND ${dateRange(p, 'i.document_date', params)}
    )
    SELECT 'B2CL' AS "table", b.document_date AS "date",
           b.document_number AS "documentNumber",
           b.place_of_supply_state_code AS "placeOfSupply",
           l.tax_rate_percent AS "rate",
           SUM(l.taxable_amount)::bigint AS "taxableAmount",
           SUM(l.cgst)::bigint AS "cgst", SUM(l.sgst)::bigint AS "sgst",
           SUM(l.igst)::bigint AS "igst", SUM(l.cess)::bigint AS "cess",
           b.grand_total AS "invoiceValue"
    FROM b2c b JOIN invoice_lines l ON l.invoice_id = b.id
    WHERE b.large
    GROUP BY b.document_date, b.document_number, b.place_of_supply_state_code,
             l.tax_rate_percent, b.grand_total
    UNION ALL
    SELECT 'B2CS' AS "table", NULL::date AS "date", NULL AS "documentNumber",
           b.place_of_supply_state_code AS "placeOfSupply",
           l.tax_rate_percent AS "rate",
           SUM(l.taxable_amount)::bigint AS "taxableAmount",
           SUM(l.cgst)::bigint AS "cgst", SUM(l.sgst)::bigint AS "sgst",
           SUM(l.igst)::bigint AS "igst", SUM(l.cess)::bigint AS "cess",
           SUM(b.grand_total)::bigint AS "invoiceValue"
    FROM b2c b JOIN invoice_lines l ON l.invoice_id = b.id
    WHERE NOT b.large
    GROUP BY b.place_of_supply_state_code, l.tax_rate_percent
    ORDER BY 1, 2, 4
    LIMIT ${p.add(params.limit)}`;
  return tx.many(sql, p.all);
}

/**
 * GSTR-1 table 9B: credit and debit notes.
 *
 * Both the registered (CDNR) and unregistered (CDNUR) variants, with the
 * original invoice number — which is what makes a credit note matchable to the
 * supply it reverses. A credit note with no original number cannot be filed,
 * so the column being empty is itself the finding.
 */
export async function gstr1CreditDebitNotes(
  tx: Tx,
  params: ReportParams,
): Promise<ReportRow[]> {
  const p = new Params();
  const sql = `
    SELECT CASE WHEN c.customer_gstin IS NULL THEN 'CDNUR' ELSE 'CDNR' END AS "table",
           c.document_date AS "date", c.document_number AS "documentNumber",
           c.original_document_number AS "originalNumber",
           c.customer_gstin AS "customerGstin", c.customer_name AS "customerName",
           c.place_of_supply_state_code AS "placeOfSupply",
           c.reason_code AS "reason",
           ${TAX_COLUMNS('c')}
    FROM credit_notes c
    WHERE c.status = 'issued'
      AND ${gstinScope(p, 'c', params)} AND ${dateRange(p, 'c.document_date', params)}
    ORDER BY c.document_date, c.document_number
    LIMIT ${p.add(params.limit)}`;
  return tx.many(sql, p.all);
}

/**
 * GSTR-1 table 12: HSN-wise summary.
 *
 * Net of credit notes, so the table reconciles to the period's actual supply.
 *
 * Lines with no HSN code are bucketed under a reserved value rather than
 * dropped. The table has to account for every rupee of the turnover declared
 * above it, and a silent omission is both a filing error and invisible —
 * whereas an `UNCLASSIFIED` row with a figure against it tells whoever
 * maintains the catalogue exactly what to fix.
 */
export async function gstr1HsnSummary(tx: Tx, params: ReportParams): Promise<ReportRow[]> {
  const p = new Params();
  const hsnCode = p.add(params.hsnCode ?? null);
  const sql = `
    WITH lines AS (
      SELECT COALESCE(NULLIF(trim(l.hsn_code), ''), 'UNCLASSIFIED') AS hsn, l.unit,
             l.quantity, l.taxable_amount, l.tax_rate_percent,
             l.cgst, l.sgst, l.igst, l.cess
      FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
      WHERE i.status = 'issued' AND ${gstinScope(p, 'i', params)}
        AND ${dateRange(p, 'l.document_date', params)}
      UNION ALL
      SELECT COALESCE(NULLIF(trim(l.hsn_code), ''), 'UNCLASSIFIED') AS hsn, l.unit,
             -l.quantity, -l.taxable_amount, l.tax_rate_percent,
             -l.cgst, -l.sgst, -l.igst, -l.cess
      FROM credit_note_lines l JOIN credit_notes c ON c.id = l.credit_note_id
      WHERE c.status = 'issued' AND ${gstinScope(p, 'c', params)}
        AND ${dateRange(p, 'l.document_date', params)}
    )
    SELECT hsn AS "hsnCode",
           (array_agg(unit) FILTER (WHERE unit IS NOT NULL))[1] AS "unit",
           tax_rate_percent AS "rate",
           SUM(quantity)::bigint AS "quantity",
           SUM(taxable_amount)::bigint AS "taxableAmount",
           SUM(cgst)::bigint AS "cgst", SUM(sgst)::bigint AS "sgst",
           SUM(igst)::bigint AS "igst", SUM(cess)::bigint AS "cess"
    FROM lines
    WHERE (${hsnCode}::text IS NULL OR hsn = ${hsnCode}::text)
    GROUP BY hsn, tax_rate_percent
    ORDER BY hsn, tax_rate_percent
    LIMIT ${p.add(params.limit)}`;
  return tx.many(sql, p.all);
}

/**
 * GSTR-1 table 8: nil-rated, exempt and non-GST outward supplies.
 *
 * The table that could not be produced before supply classification existed.
 * A zero-rate line is not evidence of anything on its own — it may be a
 * taxable good notified at 0%, an exempt supply, a nil-rated one, or outside
 * GST altogether — and the form reports the four separately.
 */
export async function gstr1NilExempt(tx: Tx, params: ReportParams): Promise<ReportRow[]> {
  const p = new Params();
  const sql = `
    WITH lines AS (
      SELECT l.supply_category, i.supply_type, l.taxable_amount
      FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
      WHERE i.status = 'issued' AND l.supply_category <> 'taxable'
        AND ${gstinScope(p, 'i', params)} AND ${dateRange(p, 'l.document_date', params)}
      UNION ALL
      SELECT l.supply_category, c.supply_type, -l.taxable_amount
      FROM credit_note_lines l JOIN credit_notes c ON c.id = l.credit_note_id
      WHERE c.status = 'issued' AND l.supply_category <> 'taxable'
        AND ${gstinScope(p, 'c', params)} AND ${dateRange(p, 'l.document_date', params)}
    )
    SELECT supply_category AS "classification",
           CASE WHEN supply_type = 'intra_state' THEN 'Intra-state' ELSE 'Inter-state' END
             AS "supplyType",
           SUM(taxable_amount)::bigint AS "taxableAmount"
    FROM lines
    GROUP BY supply_category, supply_type
    ORDER BY 1, 2
    LIMIT ${p.add(params.limit)}`;
  return tx.many(sql, p.all);
}

/**
 * GSTR-1 table 13: documents issued, and the numbers that were not.
 *
 * Declares the range each series issued and how many of those numbers were
 * cancelled. A gap has to be declared rather than quietly skipped, which is
 * why this reads the series alongside the documents — an unused number has no
 * document to count.
 */
export async function gstr1DocumentsIssued(tx: Tx, params: ReportParams): Promise<ReportRow[]> {
  const p = new Params();
  const sql = `
    WITH issued AS (
      SELECT series_id, document_number, document_date, status FROM invoices
      UNION ALL
      SELECT series_id, document_number, document_date, status FROM credit_notes
      UNION ALL
      SELECT series_id, document_number, document_date, status FROM debit_notes
    )
    SELECT s.document_type AS "documentType", s.prefix,
           MIN(d.document_number) AS "fromNumber", MAX(d.document_number) AS "toNumber",
           count(*)::int AS "totalIssued",
           count(*) FILTER (WHERE d.status = 'void')::int AS "cancelled",
           count(*) FILTER (WHERE d.status <> 'void')::int AS "net"
    FROM issued d
    JOIN document_series s ON s.id = d.series_id
    WHERE ${dateRange(p, 'd.document_date', params)}
    GROUP BY s.document_type, s.prefix, s.id
    ORDER BY s.document_type
    LIMIT ${p.add(params.limit)}`;
  return tx.many(sql, p.all);
}

/**
 * GSTR-3B summary: the figures the summary return asks for, live.
 *
 * Section 3.1 split by classification, with the self-assessed reverse-charge
 * liability on inward supplies, and table 4 input tax credit from the register.
 * One row per line of the form, so it reads the way the form does.
 */
export async function gstr3bSummary(tx: Tx, params: ReportParams): Promise<ReportRow[]> {
  const p = new Params();
  const sql = `
    WITH outward AS (
      SELECT l.supply_category, i.supply_type, l.taxable_amount,
             l.cgst, l.sgst, l.igst, l.cess
      FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
      WHERE i.status = 'issued' AND ${gstinScope(p, 'i', params)}
        AND ${dateRange(p, 'l.document_date', params)}
      UNION ALL
      SELECT l.supply_category, c.supply_type, -l.taxable_amount,
             -l.cgst, -l.sgst, -l.igst, -l.cess
      FROM credit_note_lines l JOIN credit_notes c ON c.id = l.credit_note_id
      WHERE c.status = 'issued' AND ${gstinScope(p, 'c', params)}
        AND ${dateRange(p, 'l.document_date', params)}
    ),
    sections AS (
      SELECT CASE
               WHEN supply_type LIKE 'export%' OR supply_type LIKE 'sez%' THEN '3.1(b) Zero-rated'
               WHEN supply_category = 'non_gst' THEN '3.1(e) Non-GST'
               WHEN supply_category IN ('exempt', 'nil_rated') THEN '3.1(c) Nil-rated and exempt'
               ELSE '3.1(a) Outward taxable'
             END AS section,
             SUM(taxable_amount)::bigint AS taxable,
             SUM(cgst)::bigint AS cgst, SUM(sgst)::bigint AS sgst,
             SUM(igst)::bigint AS igst, SUM(cess)::bigint AS cess
      FROM outward GROUP BY 1
      UNION ALL
      -- Inward, not outward: the shop owes this tax itself. The liability is
      -- computed from the line rates because a reverse-charge bill carries no
      -- tax — the supplier charged none.
      SELECT '3.1(d) Inward liable to reverse charge' AS section,
             SUM(l.taxable_amount)::bigint,
             0::bigint, 0::bigint, 0::bigint,
             SUM(round(l.taxable_amount * (l.tax_rate_percent + l.cess_rate_percent) / 100))::bigint
      FROM purchase_bill_lines l JOIN purchase_bills b ON b.id = l.purchase_bill_id
      WHERE b.is_reverse_charge AND b.status <> 'void'
        AND ${dateRange(p, 'l.document_date', params)}
      HAVING SUM(l.taxable_amount) IS NOT NULL
      UNION ALL
      SELECT '4(A) Input tax credit — ' || r.itc_category AS section,
             SUM(r.taxable_amount)::bigint,
             SUM(r.cgst)::bigint, SUM(r.sgst)::bigint, SUM(r.igst)::bigint, SUM(r.cess)::bigint
      FROM itc_register r
      WHERE r.state <> 'reversed' AND ${dateRange(p, 'r.document_date', params)}
      GROUP BY r.itc_category
    )
    SELECT section AS "section", taxable AS "taxableAmount",
           cgst AS "cgst", sgst AS "sgst", igst AS "igst", cess AS "cess",
           (cgst + sgst + igst + cess)::bigint AS "totalTax"
    FROM sections
    ORDER BY section
    LIMIT ${p.add(params.limit)}`;
  return tx.many(sql, p.all);
}

/**
 * GSTR-2B reconciliation: the latest reconciliation per period, with what it
 * found and the credit at risk.
 *
 * The report form of the feature. `creditAtRisk` is the number this whole area
 * of the product exists to produce: input tax the shop has paid and cannot
 * reclaim because no supplier has reported the invoice.
 */
export async function gstr2bReconciliation(tx: Tx, params: ReportParams): Promise<ReportRow[]> {
  const p = new Params();
  const sql = `
    SELECT g.period_year AS "year", g.period_month AS "month", g.gstin,
           g.status, g.invoice_count AS "portalInvoices",
           g.exact_count AS "matched", g.probable_count AS "probable",
           g.mismatch_count AS "mismatched",
           g.missing_in_books AS "missingInBooks",
           g.missing_in_2b AS "missingIn2b",
           COALESCE((SELECT SUM(abs(m.tax_difference)) FROM gstr2b_matches m
                     WHERE m.import_id = g.id AND m.match_type = 'missing_in_2b'), 0)::bigint
             AS "creditAtRisk",
           g.reconciled_at AS "reconciledAt"
    FROM gstr2b_imports g
    WHERE (${p.add(params.gstin ?? null)}::text IS NULL OR g.gstin = ${p.add(params.gstin ?? null)}::text)
    ORDER BY g.period_year DESC, g.period_month DESC, g.created_at DESC
    LIMIT ${p.add(params.limit)}`;
  return tx.many(sql, p.all);
}

/** The ITC register as a report: credit claimed, available and at risk. */
export async function itcRegisterReport(tx: Tx, params: ReportParams): Promise<ReportRow[]> {
  const p = new Params();
  const supplierId = p.add(params.supplierId ?? null);
  const sql = `
    SELECT r.document_date AS "date", r.source_type AS "source",
           COALESCE(s.name, 'Unknown supplier') AS "supplierName",
           r.supplier_gstin AS "supplierGstin",
           r.itc_category AS "category", r.state,
           r.is_reverse_charge::text AS "reverseCharge",
           r.taxable_amount AS "taxableAmount",
           r.cgst, r.sgst, r.igst, r.cess,
           (r.cgst + r.sgst + r.igst + r.cess)::bigint AS "totalCredit",
           r.claimed_period AS "claimedPeriod",
           -- Null means no 2B row supports it: credit the shop has paid for
           -- that no supplier has reported.
           CASE WHEN r.matched_2b_id IS NULL THEN 'no' ELSE 'yes' END AS "supportedBy2b",
           COALESCE(r.ineligible_reason, '') AS "ineligibleReason"
    FROM itc_register r
    LEFT JOIN suppliers s ON s.id = r.supplier_id
    WHERE ${gstinScopeOnSelf(p, params)}
      AND ${dateRange(p, 'r.document_date', params)}
      AND (${supplierId}::uuid IS NULL OR r.supplier_id = ${supplierId}::uuid)
    ORDER BY r.document_date DESC
    LIMIT ${p.add(params.limit)}`;
  return tx.many(sql, p.all);
}

/**
 * The ITC register names our own registration in `gstin`, not a supplier's, so
 * it cannot use `gstinScope` — which matches on `supplier_gstin`, the column
 * the outward documents snapshot our GSTIN into.
 */
function gstinScopeOnSelf(p: Params, params: ReportParams): string {
  const gstin = p.add(params.gstin ?? null);
  return `(${gstin}::text IS NULL OR r.gstin = ${gstin}::text)`;
}

/** CMP-08: flat tax on turnover for a composition dealer, per business day. */
export async function compositionTurnover(tx: Tx, params: ReportParams): Promise<ReportRow[]> {
  const p = new Params();
  const sql = `
    WITH sales AS (
      SELECT i.document_date AS d, SUM(i.grand_total)::bigint AS billed, 0::bigint AS returned
      FROM invoices i
      WHERE i.status = 'issued' AND ${gstinScope(p, 'i', params)}
        AND ${dateRange(p, 'i.document_date', params)}
      GROUP BY 1
      UNION ALL
      SELECT c.document_date AS d, 0::bigint AS billed, SUM(c.grand_total)::bigint AS returned
      FROM credit_notes c
      WHERE c.status = 'issued' AND ${gstinScope(p, 'c', params)}
        AND ${dateRange(p, 'c.document_date', params)}
      GROUP BY 1
    )
    SELECT d AS "date",
           SUM(billed)::bigint AS "billed",
           SUM(returned)::bigint AS "returned",
           (SUM(billed) - SUM(returned))::bigint AS "turnover",
           -- The rate as configured now. A CMP-08 already prepared keeps the
           -- rate it was prepared at; this is the live view.
           (SELECT composition_rate_percent FROM tenants
            WHERE id = app.current_tenant_id()) AS "ratePercent",
           round((SUM(billed) - SUM(returned))
                 * COALESCE((SELECT composition_rate_percent FROM tenants
                             WHERE id = app.current_tenant_id()), 0) / 100)::bigint AS "taxPayable"
    FROM sales
    GROUP BY d
    ORDER BY d
    LIMIT ${p.add(params.limit)}`;
  return tx.many(sql, p.all);
}
