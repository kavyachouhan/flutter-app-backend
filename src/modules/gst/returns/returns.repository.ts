/**
 * Data loaders for the return engines. Plain reads, scoped by the GSTIN snapshotted on each
 * document (the only figure that stays right after a registration changes); all classification
 * lives in the pure engines in `src/domain/gst/returns`.
 */
import type { Tx } from '../../../db/tx.js';
import type { SupplyCategory, SupplyType } from '../../../domain/gst/classify.js';
import type { EngineDoc, EngineLine } from '../../../domain/gst/returns/gstr1-engine.js';
import type { IssuedNumberRow } from '../../../domain/gst/returns/docs-issued.js';
import type { TaxAmounts, TaxedValue } from '../../../domain/gst/returns/model.js';

interface HeaderRow {
  id: string;
  kind: 'invoice' | 'credit_note' | 'debit_note';
  number: string;
  date: string;
  status: string;
  irnState: string;
  supplyType: SupplyType;
  placeOfSupply: string | null;
  customerGstin: string | null;
  customerUin: string | null;
  customerName: string | null;
  buyerTreatment: string | null;
  grandTotal: number;
  reverseCharge: boolean;
  salesChannel: string | null;
  ecoGstin: string | null;
  origNumber: string | null;
  origDate: string | null;
  origTotal: number | null;
  origSupplyType: SupplyType | null;
}

interface LineRow {
  docId: string;
  category: SupplyCategory;
  hsn: string | null;
  uqc: string | null;
  quantity: number | string;
  taxable: number | string;
  ratePercent: number | string;
  cgst: number | string;
  sgst: number | string;
  igst: number | string;
  cess: number | string;
}

const HEADER_COLUMNS = (a: string) => `
  ${a}.id, ${a}.document_number AS number, ${a}.document_date::text AS date, ${a}.status,
  ${a}.supply_type AS "supplyType", ${a}.place_of_supply_state_code AS "placeOfSupply",
  ${a}.customer_gstin AS "customerGstin", ${a}.customer_uin AS "customerUin",
  ${a}.customer_name AS "customerName", ${a}.buyer_gst_treatment AS "buyerTreatment",
  ${a}.grand_total::bigint AS "grandTotal", ${a}.is_reverse_charge AS "reverseCharge"`;

const n = (v: number | string): number => (typeof v === 'number' ? v : Number(v));

export const returnsRepository = {
  /** Every outward document of a registration in the period, with its lines, all statuses. */
  async outwardDocuments(tx: Tx, gstin: string, from: string, to: string): Promise<EngineDoc[]> {
    const headers = await tx.many<HeaderRow>(
      `SELECT 'invoice' AS kind, ${HEADER_COLUMNS('i')}, i.irn_state AS "irnState",
              i.sales_channel AS "salesChannel", i.eco_gstin AS "ecoGstin",
              NULL::text AS "origNumber", NULL::text AS "origDate",
              NULL::bigint AS "origTotal", NULL::text AS "origSupplyType"
       FROM invoices i
       WHERE i.supplier_gstin = $1 AND i.document_date >= $2::date AND i.document_date <= $3::date
       UNION ALL
       SELECT 'credit_note', ${HEADER_COLUMNS('c')}, c.irn_state,
              c.sales_channel, c.eco_gstin,
              o.document_number, o.document_date::text, o.grand_total::bigint, o.supply_type
       FROM credit_notes c LEFT JOIN invoices o ON o.id = c.original_invoice_id
       WHERE c.supplier_gstin = $1 AND c.document_date >= $2::date AND c.document_date <= $3::date
       UNION ALL
       SELECT 'debit_note', ${HEADER_COLUMNS('d')}, d.irn_state,
              'direct', NULL,
              o.document_number, o.document_date::text, o.grand_total::bigint, o.supply_type
       FROM sales_debit_notes d LEFT JOIN invoices o ON o.id = d.original_invoice_id
       WHERE d.supplier_gstin = $1 AND d.document_date >= $2::date AND d.document_date <= $3::date`,
      [gstin, from, to],
    );

    const lineSql = (table: string, parent: string, fk: string, qty: string, uqc: string) =>
      `SELECT l.${fk} AS "docId", l.supply_category AS category, l.hsn_code AS hsn, ${uqc} AS uqc,
              ${qty} AS quantity, l.taxable_amount AS taxable, l.tax_rate_percent AS "ratePercent",
              l.cgst, l.sgst, l.igst, l.cess
       FROM ${table} l JOIN ${parent} p ON p.id = l.${fk}
       WHERE p.supplier_gstin = $1 AND p.document_date >= $2::date AND p.document_date <= $3::date`;

    const lines = await tx.many<LineRow>(
      `${lineSql('invoice_lines', 'invoices', 'invoice_id', 'l.quantity', 'l.uqc')}
       UNION ALL
       ${lineSql('credit_note_lines', 'credit_notes', 'credit_note_id', 'l.quantity', 'l.uqc')}
       UNION ALL
       ${lineSql('sales_debit_note_lines', 'sales_debit_notes', 'sales_debit_note_id', '0', 'NULL::text')}`,
      [gstin, from, to],
    );

    const byDoc = new Map<string, EngineLine[]>();
    for (const l of lines) {
      const list = byDoc.get(l.docId) ?? [];
      list.push({
        category: l.category,
        hsn: l.hsn && l.hsn.trim() !== '' ? l.hsn.trim() : null,
        uqc: l.uqc && l.uqc.trim() !== '' ? l.uqc.trim() : null,
        quantity: n(l.quantity),
        taxable: n(l.taxable),
        ratePercent: n(l.ratePercent),
        cgst: n(l.cgst),
        sgst: n(l.sgst),
        igst: n(l.igst),
        cess: n(l.cess),
      });
      byDoc.set(l.docId, list);
    }

    return headers.map((h) => ({
      kind: h.kind,
      id: h.id,
      number: h.number,
      date: h.date,
      status: h.status,
      irnState: h.irnState,
      supplyType: h.supplyType,
      placeOfSupply: h.placeOfSupply,
      customerGstin: h.customerGstin,
      customerUin: h.customerUin,
      customerName: h.customerName,
      buyerTreatment: h.buyerTreatment,
      grandTotal: n(h.grandTotal),
      reverseCharge: h.reverseCharge,
      salesChannel: h.salesChannel,
      ecoGstin: h.ecoGstin,
      original:
        h.origNumber && h.origDate && h.origTotal !== null && h.origSupplyType
          ? {
              number: h.origNumber,
              date: h.origDate,
              grandTotal: n(h.origTotal),
              supplyType: h.origSupplyType,
            }
          : null,
      lines: byDoc.get(h.id) ?? [],
    }));
  },

  /** Every number the registry holds for documents dated in the period (table 13). */
  async issuedNumbers(tx: Tx, gstin: string, from: string, to: string): Promise<IssuedNumberRow[]> {
    const rows = await tx.many<{
      family: string;
      seriesId: string;
      number: string;
      state: IssuedNumberRow['state'];
      sequenceNo: number | string;
    }>(
      `SELECT n.series_family AS family, d.series_id AS "seriesId", n.document_number AS number,
              n.number_state AS state, d.sequence_no AS "sequenceNo"
       FROM gst_document_numbers n
       JOIN gst_registrations r ON r.id = n.registration_id AND r.gstin = $1
       JOIN (
         SELECT 'invoices' AS t, id, series_id, sequence_no, document_date FROM invoices
         UNION ALL SELECT 'credit_notes', id, series_id, sequence_no, document_date FROM credit_notes
         UNION ALL SELECT 'sales_debit_notes', id, series_id, sequence_no, document_date FROM sales_debit_notes
       ) d ON d.t = n.document_table AND d.id = n.document_id
       WHERE d.document_date >= $2::date AND d.document_date <= $3::date`,
      [gstin, from, to],
    );
    return rows.map((r) => ({ ...r, sequenceNo: n(r.sequenceNo) }));
  },

  /** Reverse-charge inward supplies: value, and self-assessed tax by head, split by import or not. */
  async inwardReverseCharge(
    tx: Tx,
    from: string,
    to: string,
  ): Promise<{
    domestic: TaxedValue;
    importOfServices: TaxedValue;
    domesticIneligible: TaxAmounts;
  }> {
    const rows = await tx.many<{
      foreign: boolean;
      ineligible: boolean;
      taxable: number | string;
      igst: number | string;
      cgst: number | string;
      sgst: number | string;
      cess: number | string;
    }>(
      // A reverse-charge bill carries no tax (the supplier charged none), so the liability is
      // computed from the line rates. Stored tax is used when present.
      `SELECT (s.country_code <> 'IN') AS foreign,
              COALESCE(b.itc_category = 'ineligible' OR NOT b.itc_eligible, false) AS ineligible,
              SUM(l.taxable_amount)::bigint AS taxable,
              SUM(CASE WHEN l.cgst + l.sgst + l.igst > 0 THEN l.igst
                       WHEN b.supply_type = 'intra_state' THEN 0
                       ELSE round(l.taxable_amount * l.tax_rate_percent / 100) END)::bigint AS igst,
              SUM(CASE WHEN l.cgst + l.sgst + l.igst > 0 THEN l.cgst
                       WHEN b.supply_type = 'intra_state' THEN round(l.taxable_amount * l.tax_rate_percent / 200)
                       ELSE 0 END)::bigint AS cgst,
              SUM(CASE WHEN l.cgst + l.sgst + l.igst > 0 THEN l.sgst
                       WHEN b.supply_type = 'intra_state' THEN round(l.taxable_amount * l.tax_rate_percent / 200)
                       ELSE 0 END)::bigint AS sgst,
              SUM(CASE WHEN l.cess > 0 THEN l.cess
                       ELSE round(l.taxable_amount * l.cess_rate_percent / 100) END)::bigint AS cess
       FROM purchase_bill_lines l
       JOIN purchase_bills b ON b.id = l.purchase_bill_id
       JOIN suppliers s ON s.id = b.supplier_id
       WHERE b.is_reverse_charge AND b.status <> 'void'
         AND b.document_date >= $1::date AND b.document_date <= $2::date
       GROUP BY 1, 2`,
      [from, to],
    );
    const z: TaxedValue = { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
    let domestic = z;
    let imp = z;
    let ineligible: TaxAmounts = { igst: 0, cgst: 0, sgst: 0, cess: 0 };
    for (const r of rows) {
      const v: TaxedValue = {
        taxable: n(r.taxable),
        igst: n(r.igst),
        cgst: n(r.cgst),
        sgst: n(r.sgst),
        cess: n(r.cess),
      };
      const plus = (a: TaxedValue): TaxedValue => ({
        taxable: a.taxable + v.taxable,
        igst: a.igst + v.igst,
        cgst: a.cgst + v.cgst,
        sgst: a.sgst + v.sgst,
        cess: a.cess + v.cess,
      });
      if (r.foreign) imp = plus(imp);
      else domestic = plus(domestic);
      if (r.ineligible) {
        ineligible = {
          igst: ineligible.igst + v.igst,
          cgst: ineligible.cgst + v.cgst,
          sgst: ineligible.sgst + v.sgst,
          cess: ineligible.cess + v.cess,
        };
      }
    }
    return { domestic, importOfServices: imp, domesticIneligible: ineligible };
  },

  /** Non-reverse-charge credit from the ITC register (signed; debit notes already negative). */
  async inwardCredit(
    tx: Tx,
    gstin: string,
    from: string,
    to: string,
  ): Promise<{ importGoods: TaxAmounts; other: TaxAmounts; ineligible: TaxAmounts; rows: number }> {
    const rows = await tx.many<{
      isImportGoods: boolean;
      ineligible: boolean;
      igst: number | string;
      cgst: number | string;
      sgst: number | string;
      cess: number | string;
      rows: number | string;
    }>(
      `SELECT (COALESCE(pb.boe_number, pb2.boe_number) IS NOT NULL) AS "isImportGoods",
              (r.itc_category = 'ineligible') AS ineligible,
              SUM(r.igst)::bigint AS igst, SUM(r.cgst)::bigint AS cgst,
              SUM(r.sgst)::bigint AS sgst, SUM(r.cess)::bigint AS cess, COUNT(*)::int AS rows
       FROM itc_register r
       LEFT JOIN purchase_bills pb ON r.source_type = 'purchase_bill' AND pb.id = r.source_id
       LEFT JOIN debit_notes dn ON r.source_type = 'debit_note' AND dn.id = r.source_id
       LEFT JOIN purchase_bills pb2 ON pb2.id = dn.purchase_bill_id
       WHERE r.gstin = $1 AND r.document_date >= $2::date AND r.document_date <= $3::date
         AND NOT r.is_reverse_charge AND r.state <> 'reversed'
       GROUP BY 1, 2`,
      [gstin, from, to],
    );
    type Mutable = { igst: number; cgst: number; sgst: number; cess: number };
    const zero = (): Mutable => ({ igst: 0, cgst: 0, sgst: 0, cess: 0 });
    const acc: { importGoods: Mutable; other: Mutable; ineligible: Mutable; rows: number } = {
      importGoods: zero(),
      other: zero(),
      ineligible: zero(),
      rows: 0,
    };
    for (const r of rows) {
      const t: TaxAmounts = { igst: n(r.igst), cgst: n(r.cgst), sgst: n(r.sgst), cess: n(r.cess) };
      const bucket = r.isImportGoods ? acc.importGoods : acc.other;
      bucket.igst += t.igst;
      bucket.cgst += t.cgst;
      bucket.sgst += t.sgst;
      bucket.cess += t.cess;
      if (r.ineligible) {
        acc.ineligible.igst += t.igst;
        acc.ineligible.cgst += t.cgst;
        acc.ineligible.sgst += t.sgst;
        acc.ineligible.cess += t.cess;
      }
      acc.rows += n(r.rows);
    }
    return acc;
  },

  /**
   * Credit per the latest ingested GSTR-2B for the registration and month, signed (credit notes
   * negative), split into reverse-charge and other. Null when no statement was imported.
   */
  async gstr2bCredit(
    tx: Tx,
    gstin: string,
    year: number,
    month: number,
  ): Promise<{
    importId: string;
    other: TaxAmounts;
    reverseCharge: TaxAmounts;
    rows: number;
  } | null> {
    const imp = await tx.one<{ id: string }>(
      `SELECT id FROM gstr2b_imports
       WHERE gstin = $1 AND period_year = $2 AND period_month = $3
         AND status IN ('ingested', 'reconciling', 'reconciled')
       ORDER BY created_at DESC LIMIT 1`,
      [gstin, year, month],
    );
    if (!imp) return null;
    const rows = await tx.many<{
      rcm: boolean;
      igst: number | string;
      cgst: number | string;
      sgst: number | string;
      cess: number | string;
      rows: number | string;
    }>(
      // Only credit the portal itself calls available (itc_available = true); unknown (T) and
      // refused rows are not counted as credit.
      `SELECT is_reverse_charge AS rcm,
              SUM(CASE WHEN document_type IN ('credit_note', 'credit_note_amended', 'isd_credit_note') THEN -igst ELSE igst END)::bigint AS igst,
              SUM(CASE WHEN document_type IN ('credit_note', 'credit_note_amended', 'isd_credit_note') THEN -cgst ELSE cgst END)::bigint AS cgst,
              SUM(CASE WHEN document_type IN ('credit_note', 'credit_note_amended', 'isd_credit_note') THEN -sgst ELSE sgst END)::bigint AS sgst,
              SUM(CASE WHEN document_type IN ('credit_note', 'credit_note_amended', 'isd_credit_note') THEN -cess ELSE cess END)::bigint AS cess,
              COUNT(*)::int AS rows
       FROM gstr2b_invoices
       WHERE import_id = $1 AND itc_available IS TRUE
       GROUP BY is_reverse_charge`,
      [imp.id],
    );
    const zero = (): { igst: number; cgst: number; sgst: number; cess: number } => ({
      igst: 0,
      cgst: 0,
      sgst: 0,
      cess: 0,
    });
    const out = { importId: imp.id, other: zero(), reverseCharge: zero(), rows: 0 };
    for (const r of rows) {
      const t = r.rcm ? out.reverseCharge : out.other;
      t.igst += n(r.igst);
      t.cgst += n(r.cgst);
      t.sgst += n(r.sgst);
      t.cess += n(r.cess);
      out.rows += n(r.rows);
    }
    return out;
  },

  /** Inward exempt, nil-rated and non-GST supplies (3B table 5), net of purchase returns. */
  async inwardExempt(
    tx: Tx,
    from: string,
    to: string,
  ): Promise<{ gst: { inter: number; intra: number }; nonGst: { inter: number; intra: number } }> {
    const rows = await tx.many<{ bucket: string; inter: boolean; amount: number | string }>(
      `SELECT bucket, inter, SUM(amount)::bigint AS amount FROM (
         SELECT CASE WHEN l.supply_category = 'non_gst' THEN 'nongst' ELSE 'gst' END AS bucket,
                (b.supply_type <> 'intra_state') AS inter, l.taxable_amount AS amount
         FROM purchase_bill_lines l
         JOIN purchase_bills b ON b.id = l.purchase_bill_id
         JOIN suppliers s ON s.id = b.supplier_id
         WHERE b.status <> 'void' AND b.document_date >= $1::date AND b.document_date <= $2::date
           AND (l.supply_category <> 'taxable' OR s.registration_type = 'composition')
         UNION ALL
         SELECT CASE WHEN l.supply_category = 'non_gst' THEN 'nongst' ELSE 'gst' END,
                (d.supply_type <> 'intra_state'), -l.taxable_amount
         FROM debit_note_lines l
         JOIN debit_notes d ON d.id = l.debit_note_id
         JOIN suppliers s ON s.id = d.supplier_id
         WHERE d.status <> 'void' AND d.document_date >= $1::date AND d.document_date <= $2::date
           AND (l.supply_category <> 'taxable' OR s.registration_type = 'composition')
       ) x GROUP BY bucket, inter`,
      [from, to],
    );
    const out = { gst: { inter: 0, intra: 0 }, nonGst: { inter: 0, intra: 0 } };
    for (const r of rows) {
      const target = r.bucket === 'nongst' ? out.nonGst : out.gst;
      if (r.inter) target.inter += n(r.amount);
      else target.intra += n(r.amount);
    }
    return out;
  },
};
