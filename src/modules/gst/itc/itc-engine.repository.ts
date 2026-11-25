/**
 * Loads the facts the ITC engine (`domain/gst/itc-engine.ts`) needs for one registration and
 * return period, and writes the movements of a filed GSTR-3B. The engine itself is pure.
 */
import type { Tx } from '../../../db/tx.js';
import type {
  BlockedCreditCode,
  CommonCapitalGood,
  ItcDocKind,
  ItcDocument,
  ItcMovement,
  ItcUse,
} from '../../../domain/gst/itc-engine.js';
import type { TaxAmounts } from '../../../domain/gst/returns/model.js';

const n = (v: number | string | null | undefined): number => Number(v ?? 0);
const tax = (r: { igst: unknown; cgst: unknown; sgst: unknown; cess: unknown }): TaxAmounts => ({
  igst: n(r.igst as string),
  cgst: n(r.cgst as string),
  sgst: n(r.sgst as string),
  cess: n(r.cess as string),
});

interface DocRow {
  registerId: string;
  sourceType: 'purchase_bill' | 'debit_note';
  number: string;
  supplierGstin: string | null;
  documentDate: string;
  receivedDate: string | null;
  receiptComplete: boolean;
  reverseCharge: boolean;
  foreign: boolean;
  importGoods: boolean;
  itcCategory: string;
  blockedCode: BlockedCreditCode | null;
  use: ItcUse;
  igst: string;
  cgst: string;
  sgst: string;
  cess: string;
  payable: string | null;
  returned: string | null;
  billId: string | null;
  twoBPeriod: string | null;
  twoBAvailable: boolean | null;
  twoBIgst: string | null;
  twoBCgst: string | null;
  twoBSgst: string | null;
  twoBCess: string | null;
  claimedIgst: string; claimedCgst: string; claimedSgst: string; claimedCess: string;
  revIgst: string; revCgst: string; revSgst: string; revCess: string;
  recIgst: string; recCgst: string; recSgst: string; recCess: string;
  closedByMovement: boolean;
  movementCount: string;
}

export const itcEngineRepository = {
  /**
   * The last day covered by a GSTR-3B filed before the engine existed (no movements written for
   * it). Credit dated up to then was claimed by those returns, per books, and is left alone.
   */
  async legacyClaimedThrough(tx: Tx, gstin: string): Promise<string | null> {
    const row = await tx.one<{ through: string | null }>(
      `SELECT max(p.period_to)::text AS through FROM gst_return_periods p
       WHERE p.gstin = $1 AND p.return_type = 'gstr3b' AND p.status = 'filed'
         AND NOT EXISTS (SELECT 1 FROM itc_movements m WHERE m.return_period_id = p.id)
         AND COALESCE((p.workings ->> 'itcEngine'), '') = ''`,
      [gstin],
    );
    return row?.through ?? null;
  },

  /** The last GSTR-3B period filed for the registration, as {year, month}, or null. */
  async lastFiledPeriod(tx: Tx, gstin: string): Promise<{ year: number; month: number } | null> {
    const row = await tx.one<{ year: number; month: number }>(
      `SELECT period_year AS year, period_month AS month FROM gst_return_periods
       WHERE gstin = $1 AND return_type = 'gstr3b' AND status = 'filed'
       ORDER BY period_year DESC, period_month DESC LIMIT 1`,
      [gstin],
    );
    return row ?? null;
  },

  /** Every credit document of the registration dated on or before `periodEnd`, with its facts. */
  async documents(tx: Tx, gstin: string, periodEnd: string): Promise<ItcDocument[]> {
    const legacyThrough = await this.legacyClaimedThrough(tx, gstin);
    // The first month with an imported GSTR-2B: from then on 2B is enforced (s.16(2)(aa)).
    const tracked = await tx.one<{ first: string | null }>(
      `SELECT min(lpad(period_year::text, 4, '0') || '-' || lpad(period_month::text, 2, '0')) AS first
       FROM gstr2b_imports WHERE gstin = $1 AND status IN ('ingested', 'reconciling', 'reconciled')`,
      [gstin],
    );
    const firstTracked = tracked?.first ?? null;
    const rows = await tx.many<DocRow>(
      `WITH mv AS (
         SELECT register_id,
                SUM(igst) FILTER (WHERE kind = 'claim') AS c_igst, SUM(cgst) FILTER (WHERE kind = 'claim') AS c_cgst,
                SUM(sgst) FILTER (WHERE kind = 'claim') AS c_sgst, SUM(cess) FILTER (WHERE kind = 'claim') AS c_cess,
                SUM(igst) FILTER (WHERE kind = 'reverse_temporary') AS r_igst,
                SUM(cgst) FILTER (WHERE kind = 'reverse_temporary') AS r_cgst,
                SUM(sgst) FILTER (WHERE kind = 'reverse_temporary') AS r_sgst,
                SUM(cess) FILTER (WHERE kind = 'reverse_temporary') AS r_cess,
                SUM(igst) FILTER (WHERE kind = 'reclaim') AS k_igst, SUM(cgst) FILTER (WHERE kind = 'reclaim') AS k_cgst,
                SUM(sgst) FILTER (WHERE kind = 'reclaim') AS k_sgst, SUM(cess) FILTER (WHERE kind = 'reclaim') AS k_cess,
                bool_or(kind IN ('ineligible', 'reverse_permanent')) AS closed,
                COUNT(*) AS cnt
         FROM itc_movements WHERE gstin = $1 AND register_id IS NOT NULL GROUP BY register_id
       ),
       twob AS (
         -- The latest GSTR-2B row matched to each bill: exact, mismatch (amounts differ, the
         -- smaller is claimed), or a probable match a person accepted.
         SELECT DISTINCT ON (m.purchase_bill_id) m.purchase_bill_id,
                lpad(imp.period_year::text, 4, '0') || '-' || lpad(imp.period_month::text, 2, '0') AS period,
                COALESCE(g.itc_available, true) AS available,
                g.igst, g.cgst, g.sgst, g.cess
         FROM gstr2b_matches m
         JOIN gstr2b_invoices g ON g.id = m.gstr2b_invoice_id
         JOIN gstr2b_imports imp ON imp.id = m.import_id
         WHERE imp.gstin = $1 AND m.purchase_bill_id IS NOT NULL
           AND (m.match_type IN ('exact', 'mismatch') OR m.accepted_at IS NOT NULL)
         ORDER BY m.purchase_bill_id, imp.period_year, imp.period_month, imp.created_at DESC
       )
       SELECT r.id AS "registerId", r.source_type AS "sourceType",
              COALESCE(pb.supplier_invoice_no, dn.document_number) AS number,
              r.supplier_gstin AS "supplierGstin",
              COALESCE(si.document_date, r.document_date)::text AS "documentDate",
              COALESCE(pb.goods_received_date, pb.services_received_date)::text AS "receivedDate",
              COALESCE(pb.receipt_complete, true) AS "receiptComplete",
              r.is_reverse_charge AS "reverseCharge",
              COALESCE(s.country_code, 'IN') <> 'IN' AS foreign,
              COALESCE(pb.boe_number, bill.boe_number) IS NOT NULL AS "importGoods",
              COALESCE(bill.itc_category, r.itc_category) AS "itcCategory",
              bill.blocked_credit_code AS "blockedCode",
              COALESCE(bill.itc_use, 'business_taxable') AS use,
              -- Reverse charge: the bill carries no tax, so the credit is the self-assessed tax
              -- worked out from the line rates (the same figure 3.1(d) pays).
              CASE WHEN rc.bill_id IS NOT NULL THEN rc.igst ELSE r.igst END AS igst,
              CASE WHEN rc.bill_id IS NOT NULL THEN rc.cgst ELSE r.cgst END AS cgst,
              CASE WHEN rc.bill_id IS NOT NULL THEN rc.sgst ELSE r.sgst END AS sgst,
              CASE WHEN rc.bill_id IS NOT NULL THEN rc.cess ELSE r.cess END AS cess,
              pb.grand_total AS payable,
              CASE WHEN pb.id IS NULL THEN 0 ELSE COALESCE((
                SELECT SUM(d.grand_total) FROM debit_notes d
                WHERE d.purchase_bill_id = pb.id AND d.status = 'issued'), 0) END AS returned,
              pb.id AS "billId",
              tb.period AS "twoBPeriod", tb.available AS "twoBAvailable",
              tb.igst AS "twoBIgst", tb.cgst AS "twoBCgst", tb.sgst AS "twoBSgst", tb.cess AS "twoBCess",
              COALESCE(mv.c_igst, 0) AS "claimedIgst", COALESCE(mv.c_cgst, 0) AS "claimedCgst",
              COALESCE(mv.c_sgst, 0) AS "claimedSgst", COALESCE(mv.c_cess, 0) AS "claimedCess",
              COALESCE(mv.r_igst, 0) AS "revIgst", COALESCE(mv.r_cgst, 0) AS "revCgst",
              COALESCE(mv.r_sgst, 0) AS "revSgst", COALESCE(mv.r_cess, 0) AS "revCess",
              COALESCE(mv.k_igst, 0) AS "recIgst", COALESCE(mv.k_cgst, 0) AS "recCgst",
              COALESCE(mv.k_sgst, 0) AS "recSgst", COALESCE(mv.k_cess, 0) AS "recCess",
              COALESCE(mv.closed, false) AS "closedByMovement",
              COALESCE(mv.cnt, 0) AS "movementCount"
       FROM itc_register r
       LEFT JOIN purchase_bills pb ON r.source_type = 'purchase_bill' AND pb.id = r.source_id
       LEFT JOIN debit_notes dn ON r.source_type = 'debit_note' AND dn.id = r.source_id
       LEFT JOIN purchase_bills bill ON bill.id = COALESCE(pb.id, dn.purchase_bill_id)
       LEFT JOIN suppliers s ON s.id = r.supplier_id
       LEFT JOIN mv ON mv.register_id = r.id
       LEFT JOIN twob tb ON tb.purchase_bill_id = pb.id
       LEFT JOIN rcm_self_invoices si
         ON r.is_reverse_charge AND si.purchase_bill_id = pb.id AND si.status = 'issued'
       LEFT JOIN LATERAL (
         SELECT l.purchase_bill_id AS bill_id,
                SUM(CASE WHEN l.cgst + l.sgst + l.igst > 0 THEN l.igst
                         WHEN pb.supply_type = 'intra_state' THEN 0
                         ELSE round(l.taxable_amount * l.tax_rate_percent / 100) END)::bigint AS igst,
                SUM(CASE WHEN l.cgst + l.sgst + l.igst > 0 THEN l.cgst
                         WHEN pb.supply_type = 'intra_state' THEN round(l.taxable_amount * l.tax_rate_percent / 200)
                         ELSE 0 END)::bigint AS cgst,
                SUM(CASE WHEN l.cgst + l.sgst + l.igst > 0 THEN l.sgst
                         WHEN pb.supply_type = 'intra_state' THEN round(l.taxable_amount * l.tax_rate_percent / 200)
                         ELSE 0 END)::bigint AS sgst,
                SUM(CASE WHEN l.cess > 0 THEN l.cess
                         ELSE round(l.taxable_amount * l.cess_rate_percent / 100) END)::bigint AS cess
         FROM purchase_bill_lines l
         WHERE pb.is_reverse_charge AND l.purchase_bill_id = pb.id
         GROUP BY l.purchase_bill_id
       ) rc ON true
       WHERE r.gstin = $1 AND r.state <> 'reversed'
         AND COALESCE(si.document_date, r.document_date) <= $2::date
       ORDER BY r.document_date, r.id`,
      [gstin, periodEnd],
    );

    const billIds = rows.map((r) => r.billId).filter((v): v is string => v !== null);
    const payments = billIds.length
      ? await tx.many<{ billId: string; date: string; amount: string }>(
          `SELECT a.purchase_bill_id AS "billId", (p.paid_at AT TIME ZONE 'Asia/Kolkata')::date::text AS date,
                  a.amount
           FROM supplier_payment_allocations a
           JOIN supplier_payments p ON p.id = a.supplier_payment_id
           WHERE a.purchase_bill_id = ANY($1::uuid[]) AND p.status = 'issued'`,
          [billIds],
        )
      : [];
    const paid = new Map<string, { date: string; amount: number }[]>();
    for (const p of payments) {
      const list = paid.get(p.billId) ?? [];
      list.push({ date: p.date, amount: n(p.amount) });
      paid.set(p.billId, list);
    }

    return rows.map((r): ItcDocument => {
      const kind: ItcDocKind = r.importGoods
        ? 'import_goods'
        : r.reverseCharge
          ? r.foreign
            ? 'rcm_import_services'
            : 'rcm_domestic'
          : 'domestic';
      const legacy =
        legacyThrough !== null && r.documentDate <= legacyThrough && n(r.movementCount) === 0;
      return {
        registerId: r.registerId,
        sourceType: r.sourceType,
        number: r.number,
        supplierGstin: r.supplierGstin,
        documentDate: r.documentDate,
        receivedDate: r.receivedDate,
        receiptComplete: r.receiptComplete,
        kind,
        blocked: r.blockedCode ?? (r.itcCategory === 'ineligible' ? 'unspecified' : null),
        use: r.use,
        capitalGoods: r.itcCategory === 'capital_goods',
        tax: tax(r),
        payable: n(r.payable),
        returned: n(r.returned),
        payments: r.billId ? (paid.get(r.billId) ?? []) : [],
        twoB:
          r.twoBPeriod === null
            ? null
            : {
                period: r.twoBPeriod,
                available: r.twoBAvailable ?? true,
                tax: tax({ igst: r.twoBIgst, cgst: r.twoBCgst, sgst: r.twoBSgst, cess: r.twoBCess }),
              },
        twoBTracked: firstTracked !== null && r.documentDate.slice(0, 7) >= firstTracked,
        history: {
          claimed: tax({ igst: r.claimedIgst, cgst: r.claimedCgst, sgst: r.claimedSgst, cess: r.claimedCess }),
          reversedTemporary: tax({ igst: r.revIgst, cgst: r.revCgst, sgst: r.revSgst, cess: r.revCess }),
          reclaimed: tax({ igst: r.recIgst, cgst: r.recCgst, sgst: r.recSgst, cess: r.recCess }),
          closed: r.closedByMovement || legacy,
        },
      };
    });
  },

  /** Common capital goods already claimed in a filed return, for Rule 43. */
  commonCapitalGoods(tx: Tx, gstin: string): Promise<CommonCapitalGood[]> {
    return tx
      .many<{ registerId: string; documentDate: string; igst: string; cgst: string; sgst: string; cess: string }>(
        `SELECT m.register_id AS "registerId", r.document_date::text AS "documentDate",
                SUM(m.igst) AS igst, SUM(m.cgst) AS cgst, SUM(m.sgst) AS sgst, SUM(m.cess) AS cess
         FROM itc_movements m
         JOIN itc_register r ON r.id = m.register_id
         JOIN purchase_bills pb ON r.source_type = 'purchase_bill' AND pb.id = r.source_id
         WHERE m.gstin = $1 AND m.kind = 'claim' AND pb.itc_category = 'capital_goods'
           AND pb.itc_use IN ('common', 'common_with_non_business')
         GROUP BY m.register_id, r.document_date`,
        [gstin],
      )
      .then((rows) => rows.map((r) => ({ registerId: r.registerId, documentDate: r.documentDate, tax: tax(r) })));
  },

  /**
   * The Electronic Credit Reversal and Re-claimed Statement balance before `period`: the latest
   * declared balance before it, plus filed 4(B)(2) reversals and less filed reclaims after that
   * declaration. Null when nothing is declared and nothing was ever reversed.
   */
  async ecrrsBalanceBefore(tx: Tx, gstin: string, period: string): Promise<TaxAmounts | null> {
    const base = await tx.one<{ asOf: string; igst: string; cgst: string; sgst: string; cess: string }>(
      `SELECT as_of_period AS "asOf", igst, cgst, sgst, cess FROM gst_statement_balances
       WHERE gstin = $1 AND statement = 'ecrrs' AND as_of_period < $2
       ORDER BY as_of_period DESC, created_at DESC LIMIT 1`,
      [gstin, period],
    );
    const moves = await tx.one<{ hasAny: boolean; igst: string; cgst: string; sgst: string; cess: string }>(
      `SELECT COUNT(*) > 0 AS "hasAny",
              COALESCE(SUM(CASE kind WHEN 'reverse_temporary' THEN igst ELSE -igst END), 0) AS igst,
              COALESCE(SUM(CASE kind WHEN 'reverse_temporary' THEN cgst ELSE -cgst END), 0) AS cgst,
              COALESCE(SUM(CASE kind WHEN 'reverse_temporary' THEN sgst ELSE -sgst END), 0) AS sgst,
              COALESCE(SUM(CASE kind WHEN 'reverse_temporary' THEN cess ELSE -cess END), 0) AS cess
       FROM itc_movements
       WHERE gstin = $1 AND kind IN ('reverse_temporary', 'reclaim') AND period < $2
         AND ($3::text IS NULL OR period > $3)`,
      [gstin, period, base?.asOf ?? null],
    );
    if (!base && !moves?.hasAny) return null;
    const b = base ? tax(base) : { igst: 0, cgst: 0, sgst: 0, cess: 0 };
    const m = moves ? tax(moves) : { igst: 0, cgst: 0, sgst: 0, cess: 0 };
    return { igst: b.igst + m.igst, cgst: b.cgst + m.cgst, sgst: b.sgst + m.sgst, cess: b.cess + m.cess };
  },

  /** Writes a filed return's movements. Append-only; called once per filing. */
  async insertMovements(
    tx: Tx,
    args: { gstin: string; returnPeriodId: string; period: string; createdBy: string },
    movements: readonly ItcMovement[],
  ): Promise<void> {
    if (movements.length === 0) return;
    await tx.query(
      `INSERT INTO itc_movements (id, tenant_id, gstin, return_period_id, period, register_id, kind,
         rule, table4_line, igst, cgst, sgst, cess, note, created_by)
       SELECT gen_random_uuid(), app.current_tenant_id(), $1, $2, $3, m."registerId", m.kind,
              m.rule, m.line, m.igst, m.cgst, m.sgst, m.cess, m.note, $4
       FROM jsonb_to_recordset($5::jsonb) AS m("registerId" uuid, kind text, rule text, line text,
         igst bigint, cgst bigint, sgst bigint, cess bigint, note text)`,
      [
        args.gstin,
        args.returnPeriodId,
        args.period,
        args.createdBy,
        JSON.stringify(
          movements.map((m) => ({
            registerId: m.registerId,
            kind: m.kind,
            rule: m.rule,
            line: m.line,
            note: m.note,
            ...m.tax,
          })),
        ),
      ],
    );
  },

  /** Movements recorded for a document (the ITC history screen). */
  movementsFor(tx: Tx, registerId: string) {
    return tx.many(
      `SELECT period, kind, rule, table4_line AS line, igst, cgst, sgst, cess, note, created_at AS "createdAt"
       FROM itc_movements WHERE register_id = $1 ORDER BY created_at, id`,
      [registerId],
    );
  },
};
