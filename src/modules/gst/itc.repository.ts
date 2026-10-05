import type { Tx } from '../../db/tx.js';
import type { Cursor } from '../../lib/pagination.js';

export interface ItcEntryRow {
  id: string;
  gstin: string;
  sourceType: 'purchase_bill' | 'debit_note';
  sourceId: string;
  supplierId: string | null;
  supplierGstin: string | null;
  supplierName: string | null;
  documentNumber: string | null;
  documentDate: string;
  itcCategory: 'inputs' | 'input_services' | 'capital_goods' | 'ineligible';
  ineligibleReason: string | null;
  isReverseCharge: boolean;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
  taxableAmount: number;
  state: 'available' | 'claimed' | 'reversed' | 'ineligible';
  claimedPeriod: string | null;
  matched2bId: string | null;
  createdAt: Date;
}

export interface NewItcEntry {
  id: string;
  gstin: string;
  sourceType: 'purchase_bill' | 'debit_note';
  sourceId: string;
  supplierId: string | null;
  supplierGstin: string | null;
  documentDate: string;
  itcCategory: 'inputs' | 'input_services' | 'capital_goods' | 'ineligible';
  ineligibleReason: string | null;
  isReverseCharge: boolean;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
  taxableAmount: number;
  state: 'available' | 'claimed' | 'reversed' | 'ineligible';
}

const ENTRY_COLUMNS = `
  r.id, r.gstin, r.source_type AS "sourceType", r.source_id AS "sourceId",
  r.supplier_id AS "supplierId", r.supplier_gstin AS "supplierGstin",
  s.name AS "supplierName", r.document_date AS "documentDate",
  r.itc_category AS "itcCategory", r.ineligible_reason AS "ineligibleReason",
  r.is_reverse_charge AS "isReverseCharge", r.cgst, r.sgst, r.igst, r.cess,
  r.taxable_amount AS "taxableAmount", r.state, r.claimed_period AS "claimedPeriod",
  r.matched_2b_id AS "matched2bId", r.created_at AS "createdAt"`;

export const itcRepository = {
  /**
   * Records the credit a document carries.
   *
   * `ON CONFLICT DO NOTHING` on `(source_type, source_id)`: the register is
   * written from the same transaction as the bill, and a replayed upload must
   * not double the credit. The unique index is the real guarantee; this makes
   * the replay silent rather than an error the caller has to interpret.
   */
  async insert(tx: Tx, entry: NewItcEntry): Promise<void> {
    await tx.query(
      `INSERT INTO itc_register (id, tenant_id, gstin, source_type, source_id, supplier_id,
         supplier_gstin, document_date, itc_category, ineligible_reason, is_reverse_charge,
         cgst, sgst, igst, cess, taxable_amount, state)
       VALUES ($1, app.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
         $14, $15, $16)
       ON CONFLICT (tenant_id, source_type, source_id) DO NOTHING`,
      [
        entry.id,
        entry.gstin,
        entry.sourceType,
        entry.sourceId,
        entry.supplierId,
        entry.supplierGstin,
        entry.documentDate,
        entry.itcCategory,
        entry.ineligibleReason,
        entry.isReverseCharge,
        entry.cgst,
        entry.sgst,
        entry.igst,
        entry.cess,
        entry.taxableAmount,
        entry.state,
      ],
    );
  },

  /**
   * Reverses the credit on a document that has been voided.
   *
   * The entry is not deleted — DELETE is revoked, and rightly: the register is
   * what an assessment is defended with, and a credit that was claimed and
   * then reversed is part of that story. The state moves instead.
   */
  async markReversed(tx: Tx, sourceType: string, sourceId: string): Promise<void> {
    await tx.query(
      `UPDATE itc_register SET state = 'reversed', updated_at = now()
       WHERE source_type = $1 AND source_id = $2 AND state <> 'reversed'`,
      [sourceType, sourceId],
    );
  },

  list(
    tx: Tx,
    filter: {
      gstin: string | undefined;
      from: string | undefined;
      to: string | undefined;
      state: string | undefined;
      itcCategory: string | undefined;
      supplierId: string | undefined;
    },
    limit: number,
    cursor: Cursor | undefined,
  ): Promise<ItcEntryRow[]> {
    return tx.many<ItcEntryRow>(
      `SELECT ${ENTRY_COLUMNS}, NULL::text AS "documentNumber"
       FROM itc_register r LEFT JOIN suppliers s ON s.id = r.supplier_id
       WHERE ($1::text IS NULL OR r.gstin = $1)
         AND ($2::date IS NULL OR r.document_date >= $2::date)
         AND ($3::date IS NULL OR r.document_date <= $3::date)
         AND ($4::text IS NULL OR r.state = $4)
         AND ($5::text IS NULL OR r.itc_category = $5)
         AND ($6::uuid IS NULL OR r.supplier_id = $6::uuid)
         AND ($7::date IS NULL OR (r.document_date, r.id) < ($7::date, $8::uuid))
       ORDER BY r.document_date DESC, r.id DESC
       LIMIT $9`,
      [
        filter.gstin ?? null,
        filter.from ?? null,
        filter.to ?? null,
        filter.state ?? null,
        filter.itcCategory ?? null,
        filter.supplierId ?? null,
        cursor?.k ?? null,
        cursor?.id ?? null,
        limit + 1,
      ],
    );
  },

  /**
   * Credit totals for a period, split the way GSTR-3B table 4 wants.
   *
   * Reverse-charge rows are reported separately because they appear twice in
   * 3B — once as a liability under 3.1(d) and once as credit under 4(A)(3) —
   * and netting them into the ordinary categories would understate both.
   */
  totalsForPeriod(
    tx: Tx,
    gstin: string,
    from: string,
    to: string,
  ): Promise<
    {
      itcCategory: string;
      isReverseCharge: boolean;
      cgst: number;
      sgst: number;
      igst: number;
      cess: number;
      taxableAmount: number;
    }[]
  > {
    return tx.many(
      `SELECT itc_category AS "itcCategory", is_reverse_charge AS "isReverseCharge",
              SUM(cgst)::bigint AS cgst, SUM(sgst)::bigint AS sgst,
              SUM(igst)::bigint AS igst, SUM(cess)::bigint AS cess,
              SUM(taxable_amount)::bigint AS "taxableAmount"
       FROM itc_register
       WHERE gstin = $1 AND document_date >= $2::date AND document_date <= $3::date
         AND state <> 'reversed'
       GROUP BY itc_category, is_reverse_charge`,
      [gstin, from, to],
    );
  },

  /** Links an entry to the 2B row that supports it, and claims the credit. */
  async markMatched(
    tx: Tx,
    sourceId: string,
    gstr2bInvoiceId: string,
    claimedPeriod: string,
  ): Promise<void> {
    await tx.query(
      `UPDATE itc_register
       SET matched_2b_id = $2, claimed_period = $3,
           state = CASE WHEN state = 'available' THEN 'claimed' ELSE state END,
           updated_at = now()
       WHERE source_type = 'purchase_bill' AND source_id = $1`,
      [sourceId, gstr2bInvoiceId, claimedPeriod],
    );
  },

  /**
   * Backfills the register from bills entered before it existed.
   *
   * A shop that has been using the system for months has a purchase register
   * and no ITC register, and asking it to re-enter the bills would be absurd.
   * Runs once, idempotently — the unique index means a second run writes
   * nothing — and is driven from the same endpoint that prepares a return, so
   * nobody has to know to call it.
   */
  async backfillFromBills(tx: Tx, gstin: string, limit: number): Promise<number> {
    const result = await tx.query(
      `INSERT INTO itc_register (id, tenant_id, gstin, source_type, source_id, supplier_id,
         supplier_gstin, document_date, itc_category, is_reverse_charge,
         cgst, sgst, igst, cess, taxable_amount, state)
       SELECT gen_random_uuid(), app.current_tenant_id(), $1, 'purchase_bill', b.id, b.supplier_id,
              b.supplier_gstin, b.supplier_invoice_date,
              category.value, b.is_reverse_charge,
              b.total_cgst, b.total_sgst, b.total_igst, b.total_cess, b.taxable_amount,
              -- The state follows the category, never the boolean: the CHECK
              -- requires an ineligible category to carry the ineligible state,
              -- and a bill marked eligible with a blocked-credit category
              -- would otherwise violate it.
              CASE WHEN category.value = 'ineligible' THEN 'ineligible' ELSE 'available' END
       FROM purchase_bills b
       CROSS JOIN LATERAL (
         SELECT COALESCE(
           b.itc_category,
           CASE WHEN b.itc_eligible THEN 'inputs' ELSE 'ineligible' END
         ) AS value
       ) AS category
       WHERE b.status <> 'void'
         AND NOT EXISTS (
           SELECT 1 FROM itc_register r
           WHERE r.source_type = 'purchase_bill' AND r.source_id = b.id)
       LIMIT $2`,
      [gstin, limit],
    );
    return result.rowCount ?? 0;
  },
};
