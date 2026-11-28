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
import type { ItcRegisterRow } from '../../../domain/gst/returns/gstr9-engine.js';
import type { InwardDoc } from '../../../domain/gst/returns/purchase-register.js';

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
  ecoLiability: string | null;
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
              i.sales_channel AS "salesChannel", i.eco_gstin AS "ecoGstin", i.eco_liability AS "ecoLiability",
              NULL::text AS "origNumber", NULL::text AS "origDate",
              NULL::bigint AS "origTotal", NULL::text AS "origSupplyType"
       FROM invoices i
       WHERE i.supplier_gstin = $1 AND i.document_date >= $2::date AND i.document_date <= $3::date
       UNION ALL
       SELECT 'credit_note', ${HEADER_COLUMNS('c')}, c.irn_state,
              c.sales_channel, c.eco_gstin, c.eco_liability,
              o.document_number, o.document_date::text, o.grand_total::bigint, o.supply_type
       FROM credit_notes c LEFT JOIN invoices o ON o.id = c.original_invoice_id
       WHERE c.supplier_gstin = $1 AND c.document_date >= $2::date AND c.document_date <= $3::date
       UNION ALL
       SELECT 'debit_note', ${HEADER_COLUMNS('d')}, d.irn_state,
              'direct', NULL, NULL,
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
      ecoLiability: h.ecoLiability,
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

  /**
   * Purchase bills and debit notes of a registration in the period, with lines, for the purchase
   * register. Scoped through the outlet's registration; a legacy document whose outlet has none is
   * kept, as the 3B inward loaders do. Void documents are left out.
   */
  async inwardDocuments(tx: Tx, gstin: string, from: string, to: string): Promise<InwardDoc[]> {
    interface InHeader {
      kind: 'bill' | 'debit_note';
      id: string;
      number: string;
      date: string;
      grandTotal: number | string;
      supplierName: string | null;
      supplierGstin: string | null;
      supplierCountry: string;
      supplierTreatment: string | null;
      composition: boolean;
      placeOfSupply: string | null;
      supplyType: string;
      reverseCharge: boolean;
      itcCategory: InwardDoc['itcCategory'];
      itcEligible: boolean;
      boeNumber: string | null;
      boeDate: string | null;
      boePortCode: string | null;
      origNumber: string | null;
      origDate: string | null;
      reasonCode: string | null;
      registerItc: number | string | null;
    }
    const scope = `AND (r.gstin IS NULL OR r.gstin = $1)
         AND x.document_date >= $2::date AND x.document_date <= $3::date AND x.status <> 'void'`;
    const headers = await tx.many<InHeader>(
      `SELECT 'bill' AS kind, x.id, x.supplier_invoice_no AS number,
              x.supplier_invoice_date::text AS date, x.grand_total::bigint AS "grandTotal",
              s.name AS "supplierName", x.supplier_gstin AS "supplierGstin",
              s.country_code AS "supplierCountry", s.gst_treatment AS "supplierTreatment",
              (s.registration_type = 'composition') AS composition,
              x.place_of_supply_state_code AS "placeOfSupply", x.supply_type AS "supplyType",
              x.is_reverse_charge AS "reverseCharge", x.itc_category AS "itcCategory",
              x.itc_eligible AS "itcEligible", x.boe_number AS "boeNumber",
              x.boe_date::text AS "boeDate", x.boe_port_code AS "boePortCode",
              NULL::text AS "origNumber", NULL::text AS "origDate", NULL::text AS "reasonCode",
              (SELECT SUM(i.cgst + i.sgst + i.igst + i.cess)::bigint FROM itc_register i
                WHERE i.source_type = 'purchase_bill' AND i.source_id = x.id
                  AND i.state <> 'reversed' AND i.itc_category <> 'ineligible') AS "registerItc"
       FROM purchase_bills x
       JOIN suppliers s ON s.id = x.supplier_id
       LEFT JOIN outlets o ON o.id = x.outlet_id
       LEFT JOIN gst_registrations r ON r.id = o.registration_id
       WHERE true ${scope}
       UNION ALL
       SELECT 'debit_note', x.id, x.document_number, x.document_date::text,
              x.grand_total::bigint, s.name, x.supplier_gstin, s.country_code, s.gst_treatment,
              (s.registration_type = 'composition'), x.place_of_supply_state_code, x.supply_type,
              x.is_reverse_charge, b.itc_category, b.itc_eligible, NULL, NULL, NULL,
              x.original_document_number, COALESCE(x.original_document_date, b.document_date)::text,
              x.reason_code,
              (SELECT SUM(i.cgst + i.sgst + i.igst + i.cess)::bigint FROM itc_register i
                WHERE i.source_type = 'debit_note' AND i.source_id = x.id
                  AND i.state <> 'reversed' AND i.itc_category <> 'ineligible')
       FROM debit_notes x
       JOIN suppliers s ON s.id = x.supplier_id
       JOIN purchase_bills b ON b.id = x.purchase_bill_id
       LEFT JOIN outlets o ON o.id = x.outlet_id
       LEFT JOIN gst_registrations r ON r.id = o.registration_id
       WHERE true ${scope}`,
      [gstin, from, to],
    );

    const lineSql = (table: string, fk: string, parent: string) =>
      `SELECT l.${fk} AS "docId", l.supply_category AS category, l.hsn_code AS hsn, l.unit,
              l.quantity, l.taxable_amount AS taxable, l.tax_rate_percent AS "ratePercent",
              l.cess_rate_percent AS "cessRate", l.cgst, l.sgst, l.igst, l.cess
       FROM ${table} l JOIN ${parent} x ON x.id = l.${fk}
       LEFT JOIN outlets o ON o.id = x.outlet_id
       LEFT JOIN gst_registrations r ON r.id = o.registration_id
       WHERE true ${scope}`;
    const lines = await tx.many<{
      docId: string;
      category: SupplyCategory;
      hsn: string | null;
      unit: string | null;
      quantity: number | string;
      taxable: number | string;
      ratePercent: number | string;
      cessRate: number | string;
      cgst: number | string;
      sgst: number | string;
      igst: number | string;
      cess: number | string;
    }>(
      `${lineSql('purchase_bill_lines', 'purchase_bill_id', 'purchase_bills')}
       UNION ALL
       ${lineSql('debit_note_lines', 'debit_note_id', 'debit_notes')}`,
      [gstin, from, to],
    );

    const byDoc = new Map<string, InwardDoc['lines'][number][]>();
    const headerById = new Map(headers.map((h) => [h.id, h]));
    for (const l of lines) {
      const h = headerById.get(l.docId);
      const taxable = n(l.taxable);
      const rate = n(l.ratePercent);
      let cgst = n(l.cgst);
      let sgst = n(l.sgst);
      let igst = n(l.igst);
      let cess = n(l.cess);
      // A reverse-charge bill carries no tax (the supplier charged none): the liability is worked
      // out from the line rate, exactly as `inwardReverseCharge` does for GSTR-3B.
      if (h?.reverseCharge && cgst + sgst + igst === 0 && taxable > 0) {
        if (h.supplyType === 'intra_state') {
          cgst = Math.round((taxable * rate) / 200);
          sgst = Math.round((taxable * rate) / 200);
        } else {
          igst = Math.round((taxable * rate) / 100);
        }
      }
      if (h?.reverseCharge && cess === 0) cess = Math.round((taxable * n(l.cessRate)) / 100);
      const list = byDoc.get(l.docId) ?? [];
      list.push({
        category: l.category,
        hsn: l.hsn && l.hsn.trim() !== '' ? l.hsn.trim() : null,
        unit: l.unit && l.unit.trim() !== '' ? l.unit.trim().toUpperCase() : null,
        quantity: n(l.quantity),
        taxable,
        ratePercent: rate,
        cgst,
        sgst,
        igst,
        cess,
      });
      byDoc.set(l.docId, list);
    }

    return headers.map((h) => ({
      kind: h.kind,
      id: h.id,
      number: h.number,
      date: h.date,
      grandTotal: n(h.grandTotal),
      supplierName: h.supplierName,
      supplierGstin: h.supplierGstin,
      supplierCountry: h.supplierCountry,
      supplierTreatment: h.supplierTreatment,
      composition: h.composition,
      placeOfSupply: h.placeOfSupply,
      interState: h.supplyType !== 'intra_state',
      reverseCharge: h.reverseCharge,
      itcCategory: h.itcCategory,
      itcEligible: h.itcEligible,
      boeNumber: h.boeNumber,
      boeDate: h.boeDate,
      boePortCode: h.boePortCode,
      original: h.origNumber && h.origDate ? { number: h.origNumber, date: h.origDate } : null,
      reasonCode: h.reasonCode,
      // A debit note's register row is negative; the engine signs notes itself.
      registerItc:
        h.registerItc === null ? null : h.kind === 'debit_note' ? -Math.abs(n(h.registerItc)) : n(h.registerItc),
      lines: byDoc.get(h.id) ?? [],
    }));
  },

  /**
   * The credit register for a window, grouped by what decides its GSTR-9 Table 6 row: category,
   * reverse charge, whether the supplier is registered, bill of entry, and country. Reversed
   * entries are left out, as in the 3B loaders. Signed: debit notes already carry negatives.
   */
  async itcRegisterRows(tx: Tx, gstin: string, from: string, to: string): Promise<ItcRegisterRow[]> {
    const rows = await tx.many<{
      category: ItcRegisterRow['category'];
      rcm: boolean;
      registered: boolean;
      importGoods: boolean;
      foreign: boolean;
      igst: number | string;
      cgst: number | string;
      sgst: number | string;
      cess: number | string;
      rows: number | string;
    }>(
      `SELECT r.itc_category AS category, r.is_reverse_charge AS rcm,
              (r.supplier_gstin IS NOT NULL) AS registered,
              (COALESCE(pb.boe_number, pb2.boe_number) IS NOT NULL) AS "importGoods",
              (COALESCE(s.country_code, 'IN') <> 'IN') AS foreign,
              SUM(r.igst)::bigint AS igst, SUM(r.cgst)::bigint AS cgst,
              SUM(r.sgst)::bigint AS sgst, SUM(r.cess)::bigint AS cess, COUNT(*)::int AS rows
       FROM itc_register r
       LEFT JOIN purchase_bills pb ON r.source_type = 'purchase_bill' AND pb.id = r.source_id
       LEFT JOIN debit_notes dn ON r.source_type = 'debit_note' AND dn.id = r.source_id
       LEFT JOIN purchase_bills pb2 ON pb2.id = dn.purchase_bill_id
       LEFT JOIN suppliers s ON s.id = r.supplier_id
       WHERE r.gstin = $1 AND r.document_date >= $2::date AND r.document_date <= $3::date
         AND r.state <> 'reversed'
       GROUP BY 1, 2, 3, 4, 5`,
      [gstin, from, to],
    );
    return rows.map((r) => ({
      category: r.category,
      reverseCharge: r.rcm,
      supplierRegistered: r.registered,
      importGoods: r.importGoods,
      foreignSupplier: r.foreign,
      tax: { igst: n(r.igst), cgst: n(r.cgst), sgst: n(r.sgst), cess: n(r.cess) },
      rows: n(r.rows),
    }));
  },

  /** Descriptions from the HSN/SAC master for the codes in use; a code the master lacks is absent. */
  async hsnDescriptions(tx: Tx, codes: readonly string[]): Promise<Map<string, string>> {
    if (codes.length === 0) return new Map();
    const rows = await tx.many<{ code: string; description: string }>(
      'SELECT code, description FROM hsn_master WHERE code = ANY($1::text[])',
      [[...new Set(codes)]],
    );
    return new Map(rows.map((r) => [r.code, r.description]));
  },

  /** Codes the HSN/SAC master lists as services (empty when no master is loaded). */
  async masterServiceCodes(tx: Tx): Promise<Set<string>> {
    const rows = await tx.many<{ code: string }>(
      `SELECT code FROM hsn_master WHERE kind = 'service'`,
    );
    return new Set(rows.map((r) => r.code));
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
      `SELECT n.series_family AS family, d.series_id::text AS "seriesId", n.document_number AS number,
              n.number_state AS state, d.sequence_no AS "sequenceNo"
       FROM gst_document_numbers n
       JOIN gst_registrations r ON r.id = n.registration_id AND r.gstin = $1
       JOIN (
         SELECT 'invoices' AS t, id, series_id, sequence_no, document_date FROM invoices
         UNION ALL SELECT 'credit_notes', id, series_id, sequence_no, document_date FROM credit_notes
         UNION ALL SELECT 'sales_debit_notes', id, series_id, sequence_no, document_date FROM sales_debit_notes
       ) d ON d.t = n.document_table AND d.id = n.document_id
       WHERE d.document_date >= $2::date AND d.document_date <= $3::date
       UNION ALL
       -- Self-invoices for reverse-charge purchases (Table 13, nature 2), numbered per FY.
       SELECT 'rcm_self_invoice', 'rcm-si-' || si.fy_start_year, si.document_number,
              CASE WHEN si.status = 'void' THEN 'cancelled' ELSE 'issued' END, si.sequence_no
       FROM rcm_self_invoices si
       WHERE si.gstin = $1 AND si.document_date >= $2::date AND si.document_date <= $3::date
       UNION ALL
       -- Receipt vouchers (nature 6) and refund vouchers (nature 8), numbered per FY.
       SELECT 'receipt_voucher', 'rv-' || rv.fy_start_year, rv.document_number,
              CASE WHEN rv.status = 'void' THEN 'cancelled' ELSE 'issued' END, rv.sequence_no
       FROM receipt_vouchers rv
       WHERE rv.gstin = $1 AND rv.document_date >= $2::date AND rv.document_date <= $3::date
       UNION ALL
       SELECT 'refund_voucher', 'rf-' || rf.fy_start_year, rf.document_number, 'issued', rf.sequence_no
       FROM refund_vouchers rf
       WHERE rf.gstin = $1 AND rf.document_date >= $2::date AND rf.document_date <= $3::date
       UNION ALL
       -- Reserved numbers no document used, declared cancelled (0058), in the period they stopped
       -- being usable: so a series with an unused block reads as issued plus cancelled, no gap.
       SELECT c.series_family, c.series_id::text, c.document_number, 'cancelled', c.sequence_no
       FROM cancelled_document_numbers c
       JOIN gst_registrations r ON r.id = c.registration_id AND r.gstin = $1
       WHERE c.series_family IN ('outward_invoice', 'bill_of_supply', 'credit_note', 'debit_note_outward')
         AND c.cancelled_on >= $2::date AND c.cancelled_on <= $3::date`,
      [gstin, from, to],
    );
    return rows.map((r) => ({ ...r, sequenceNo: n(r.sequenceNo) }));
  },

  /** Reverse-charge inward supplies: value, and self-assessed tax by head, split by import or not. */
  async inwardReverseCharge(
    tx: Tx,
    gstin: string,
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
       LEFT JOIN gst_registrations reg ON reg.id = b.registration_id
       -- From 01.11.2024 the time of supply is the date of the self-invoice (s.13(3)(c)), when one
       -- has been issued; until then the bill date stands.
       LEFT JOIN rcm_self_invoices si ON si.purchase_bill_id = b.id AND si.status = 'issued'
       WHERE b.is_reverse_charge AND b.status <> 'void'
         AND (reg.gstin IS NULL OR reg.gstin = $1)
         AND COALESCE(si.document_date, b.document_date) >= $2::date
         AND COALESCE(si.document_date, b.document_date) <= $3::date
       GROUP BY 1, 2`,
      [gstin, from, to],
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
    gstin: string,
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
         LEFT JOIN gst_registrations reg ON reg.id = b.registration_id
         WHERE b.status <> 'void' AND b.document_date >= $2::date AND b.document_date <= $3::date
           AND (reg.gstin IS NULL OR reg.gstin = $1)
           AND (l.supply_category <> 'taxable' OR s.registration_type = 'composition')
         UNION ALL
         SELECT CASE WHEN l.supply_category = 'non_gst' THEN 'nongst' ELSE 'gst' END,
                (d.supply_type <> 'intra_state'), -l.taxable_amount
         FROM debit_note_lines l
         JOIN debit_notes d ON d.id = l.debit_note_id
         JOIN suppliers s ON s.id = d.supplier_id
         LEFT JOIN gst_registrations reg ON reg.id = d.registration_id
         WHERE d.status <> 'void' AND d.document_date >= $2::date AND d.document_date <= $3::date
           AND (reg.gstin IS NULL OR reg.gstin = $1)
           AND (l.supply_category <> 'taxable' OR s.registration_type = 'composition')
       ) x GROUP BY bucket, inter`,
      [gstin, from, to],
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
