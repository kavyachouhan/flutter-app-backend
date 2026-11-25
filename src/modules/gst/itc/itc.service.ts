/**
 * The ITC features around the engine: RCM self-invoices (s.31(3)(f), Rule 47A), IMS decisions and
 * their export in the IMS Offline Utility format, the ECRRS / RCM statement balances, and each
 * document's credit history.
 */
import { withReadTransaction, withTransaction, type Tx } from '../../../db/tx.js';
import { requireAuthContext } from '../../../lib/context.js';
import { ErrorCode, NotFoundError, UnprocessableError } from '../../../lib/errors.js';
import { assertOutletAccess } from '../../../middleware/authorize.js';
import { recordAudit } from '../../audit/audit.js';
import { assertFeature } from '../../entitlements/entitlements.js';
import { itcEngineRepository } from './itc-engine.repository.js';
import type {
  DeclareStatementBalanceBody,
  IssueRcmSelfInvoiceBody,
  ListRcmSelfInvoicesQuery,
  RecordImsActionsBody,
} from './itc.schemas.js';

const n = (v: unknown): number => Number(v ?? 0);
const today = (): string => new Date().toISOString().slice(0, 10);

function addDays(date: string, days: number): string {
  const t = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}

// --- RCM self-invoices --------------------------------------------------------------------------

interface RcmBill {
  id: string;
  outletId: string;
  status: string;
  isReverseCharge: boolean;
  supplierGstin: string | null;
  foreign: boolean;
  gstin: string | null;
  documentDate: string;
  receiptDate: string;
}

const SELF_INVOICE_COLUMNS = `id, gstin, purchase_bill_id AS "purchaseBillId", fy_start_year AS "fyStartYear",
  sequence_no AS "sequenceNo", document_number AS "documentNumber", document_date::text AS "documentDate",
  receipt_date::text AS "receiptDate", taxable_amount AS "taxableAmount", igst, cgst, sgst, cess, status,
  created_at AS "createdAt"`;

/**
 * Issues the invoice the recipient must raise for a reverse-charge purchase from an unregistered
 * supplier or an import of services, within 30 days of receipt (Rule 47A, from 01.11.2024). Its
 * date is the time of supply for the reverse-charge tax (s.13(3)(c)), so GSTR-3B 3.1(d) and the
 * credit in 4(A)(2)/(3) follow it. One per bill; issuing again returns the first.
 */
export function issueRcmSelfInvoice(body: IssueRcmSelfInvoiceBody) {
  const auth = requireAuthContext();
  return withTransaction(async (tx) => {
    await assertFeature(tx, 'gst_workings');
    const existing = await tx.one(
      `SELECT ${SELF_INVOICE_COLUMNS} FROM rcm_self_invoices WHERE purchase_bill_id = $1`,
      [body.purchaseBillId],
    );
    if (existing) return { invoice: existing, lateUnderRule47A: false, replayed: true };

    const bill = await tx.one<RcmBill>(
      `SELECT pb.id, pb.outlet_id AS "outletId", pb.status, pb.is_reverse_charge AS "isReverseCharge",
              pb.supplier_gstin AS "supplierGstin", COALESCE(s.country_code, 'IN') <> 'IN' AS foreign,
              reg.gstin, pb.document_date::text AS "documentDate",
              COALESCE(pb.goods_received_date, pb.services_received_date, pb.supplier_invoice_date,
                       pb.document_date)::text AS "receiptDate"
       FROM purchase_bills pb
       JOIN suppliers s ON s.id = pb.supplier_id
       LEFT JOIN gst_registrations reg ON reg.id = pb.registration_id
       WHERE pb.id = $1 FOR UPDATE OF pb`,
      [body.purchaseBillId],
    );
    if (!bill) throw new NotFoundError('Purchase bill');
    assertOutletAccess(bill.outletId);
    if (bill.status === 'void') throw new UnprocessableError('This bill is void.', ErrorCode.UNPROCESSABLE);
    if (!bill.isReverseCharge) {
      throw new UnprocessableError(
        'A self-invoice is issued only for a purchase on which you pay tax under reverse charge.',
        ErrorCode.UNPROCESSABLE,
      );
    }
    if (bill.supplierGstin && !bill.foreign) {
      throw new UnprocessableError(
        'The supplier is registered: under reverse charge they issue the tax invoice, so no self-invoice is needed.',
        ErrorCode.UNPROCESSABLE,
      );
    }
    if (!bill.gstin) {
      throw new UnprocessableError(
        'This bill has no GST registration, so a self-invoice cannot be numbered.',
        ErrorCode.UNPROCESSABLE,
      );
    }
    const documentDate = body.documentDate ?? today();
    if (documentDate < bill.receiptDate) {
      throw new UnprocessableError(
        'A self-invoice cannot be dated before the goods or services were received.',
        ErrorCode.UNPROCESSABLE,
        { details: { receiptDate: bill.receiptDate } },
      );
    }

    const y = Number(documentDate.slice(0, 4));
    const fyStartYear = Number(documentDate.slice(5, 7)) >= 4 ? y : y - 1;
    // Numbers are per registration and financial year, without gaps.
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`rcm-si:${bill.gstin}:${fyStartYear}`]);
    const next = await tx.one<{ seq: number }>(
      `SELECT COALESCE(max(sequence_no), 0) + 1 AS seq FROM rcm_self_invoices
       WHERE gstin = $1 AND fy_start_year = $2`,
      [bill.gstin, fyStartYear],
    );
    const sequenceNo = n(next?.seq ?? 1);
    const fyLabel = `${String(fyStartYear % 100).padStart(2, '0')}${String((fyStartYear + 1) % 100).padStart(2, '0')}`;
    const documentNumber = `SI/${fyLabel}/${sequenceNo}`;

    const tax = await tx.one<{ taxable: string; igst: string; cgst: string; sgst: string; cess: string }>(
      `SELECT COALESCE(SUM(l.taxable_amount), 0)::bigint AS taxable,
              COALESCE(SUM(CASE WHEN l.cgst + l.sgst + l.igst > 0 THEN l.igst
                       WHEN pb.supply_type = 'intra_state' THEN 0
                       ELSE round(l.taxable_amount * l.tax_rate_percent / 100) END), 0)::bigint AS igst,
              COALESCE(SUM(CASE WHEN l.cgst + l.sgst + l.igst > 0 THEN l.cgst
                       WHEN pb.supply_type = 'intra_state' THEN round(l.taxable_amount * l.tax_rate_percent / 200)
                       ELSE 0 END), 0)::bigint AS cgst,
              COALESCE(SUM(CASE WHEN l.cgst + l.sgst + l.igst > 0 THEN l.sgst
                       WHEN pb.supply_type = 'intra_state' THEN round(l.taxable_amount * l.tax_rate_percent / 200)
                       ELSE 0 END), 0)::bigint AS sgst,
              COALESCE(SUM(CASE WHEN l.cess > 0 THEN l.cess
                       ELSE round(l.taxable_amount * l.cess_rate_percent / 100) END), 0)::bigint AS cess
       FROM purchase_bill_lines l JOIN purchase_bills pb ON pb.id = l.purchase_bill_id
       WHERE pb.id = $1`,
      [bill.id],
    );

    await tx.query(
      `INSERT INTO rcm_self_invoices (id, tenant_id, gstin, purchase_bill_id, fy_start_year, sequence_no,
         document_number, document_date, receipt_date, taxable_amount, igst, cgst, sgst, cess, created_by)
       VALUES ($1, app.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        body.id,
        bill.gstin,
        bill.id,
        fyStartYear,
        sequenceNo,
        documentNumber,
        documentDate,
        bill.receiptDate,
        n(tax?.taxable),
        n(tax?.igst),
        n(tax?.cgst),
        n(tax?.sgst),
        n(tax?.cess),
        auth.userId,
      ],
    );
    const late = documentDate > addDays(bill.receiptDate, 30);
    await recordAudit(tx, {
      action: 'rcm_self_invoice.issued',
      entityType: 'rcm_self_invoice',
      entityId: body.id,
      metadata: { purchaseBillId: bill.id, documentNumber, documentDate, lateUnderRule47A: late },
    });
    const invoice = await tx.one(`SELECT ${SELF_INVOICE_COLUMNS} FROM rcm_self_invoices WHERE id = $1`, [body.id]);
    return { invoice, lateUnderRule47A: late, replayed: false };
  });
}

export function listRcmSelfInvoices(query: ListRcmSelfInvoicesQuery) {
  return withReadTransaction(async (tx) => {
    await assertFeature(tx, 'gst_workings');
    return tx.many(
      `SELECT ${SELF_INVOICE_COLUMNS} FROM rcm_self_invoices
       WHERE ($1::text IS NULL OR gstin = $1)
         AND ($2::date IS NULL OR document_date >= $2) AND ($3::date IS NULL OR document_date <= $3)
       ORDER BY document_date DESC, sequence_no DESC LIMIT 500`,
      [query.gstin ?? null, query.from ?? null, query.to ?? null],
    );
  });
}

// --- IMS ----------------------------------------------------------------------------------------

/**
 * Records the shop's IMS decisions. Append-only: the latest decision per document counts. The
 * decisions take effect only when uploaded on the portal (import/export only, no GSP); the
 * export below produces the IMS Offline Utility v2.0 upload file.
 */
export function recordImsActions(body: RecordImsActionsBody) {
  const auth = requireAuthContext();
  return withTransaction(async (tx) => {
    await assertFeature(tx, 'gst_workings');
    await tx.query(
      `INSERT INTO ims_actions (id, tenant_id, gstin, section, supplier_gstin, document_number,
         document_date, document_value, gstr2b_invoice_id, purchase_bill_id, action,
         itc_reduction_required, declared_igst, declared_cgst, declared_sgst, declared_cess, remarks,
         decided_by)
       SELECT gen_random_uuid(), app.current_tenant_id(), $1, a.section, a."supplierGstin",
              a."documentNumber", a."documentDate", a."documentValue", a."gstr2bInvoiceId",
              a."purchaseBillId", a.action, a."itcReductionRequired", a.igst, a.cgst, a.sgst, a.cess,
              a.remarks, $2
       FROM jsonb_to_recordset($3::jsonb) AS a(section text, "supplierGstin" text, "documentNumber" text,
         "documentDate" date, "documentValue" bigint, "gstr2bInvoiceId" uuid, "purchaseBillId" uuid,
         action text, "itcReductionRequired" boolean, igst bigint, cgst bigint, sgst bigint, cess bigint,
         remarks text)`,
      [
        body.gstin,
        auth.userId,
        JSON.stringify(
          body.actions.map((a) => ({
            ...a,
            igst: a.declared?.igst ?? null,
            cgst: a.declared?.cgst ?? null,
            sgst: a.declared?.sgst ?? null,
            cess: a.declared?.cess ?? null,
          })),
        ),
      ],
    );
    await recordAudit(tx, {
      action: 'ims.actions_recorded',
      entityType: 'gst_registration',
      entityId: null,
      metadata: { gstin: body.gstin, count: body.actions.length },
    });
    return { recorded: body.actions.length };
  });
}

const ACTION_CODE = { accept: 'A', reject: 'R', pending: 'P', no_action: 'N' } as const;
const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;
const rupees = (paiseValue: unknown) => Math.round(n(paiseValue)) / 100;

/**
 * The IMS upload file: `{rtin, reqtyp: "SAVE", invdata: {b2b, b2ba, b2bdn, b2bdna, b2bcn, b2bcna,
 * ecom, ecoma}}`, keys as written by the IMS Offline Utility v2.0 export macro
 * (`data/IMS_Offline_Utility`). Only the latest decision per document is written. It was not
 * checked against a portal-generated file, so it is marked a draft.
 */
export function exportImsJson(gstin: string) {
  return withReadTransaction(async (tx) => {
    await assertFeature(tx, 'gst_workings');
    const rows = await tx.many<Record<string, unknown>>(
      `SELECT DISTINCT ON (a.section, a.supplier_gstin, upper(trim(a.document_number)))
              a.section, a.supplier_gstin AS stin, a.document_number AS num,
              a.document_date::text AS dt, COALESCE(a.document_value, g.invoice_value) AS val,
              a.action, a.itc_reduction_required AS red, a.declared_igst, a.declared_cgst,
              a.declared_sgst, a.declared_cess, a.remarks, g.place_of_supply AS pos,
              g.taxable_amount AS txval, g.igst, g.cgst, g.sgst, g.cess, g.filed_period AS rtnprd
       FROM ims_actions a
       LEFT JOIN gstr2b_invoices g ON g.id = a.gstr2b_invoice_id
       WHERE a.gstin = $1
       ORDER BY a.section, a.supplier_gstin, upper(trim(a.document_number)), a.created_at DESC`,
      [gstin],
    );
    const invdata: Record<string, Record<string, unknown>[]> = {};
    for (const r of rows) {
      const section = String(r['section']);
      const isNote = section.startsWith('b2bcn') || section.startsWith('b2bdn');
      const record: Record<string, unknown> = {
        stin: r['stin'],
        ...(isNote
          ? { nt_num: r['num'], nt_dt: ddmmyyyy(String(r['dt'])) }
          : { inum: r['num'], idt: ddmmyyyy(String(r['dt'])), inv_typ: 'R' }),
        val: rupees(r['val']),
        action: ACTION_CODE[r['action'] as keyof typeof ACTION_CODE],
        ...(r['pos'] ? { pos: r['pos'] } : {}),
        txval: rupees(r['txval']),
        iamt: rupees(r['igst']),
        camt: rupees(r['cgst']),
        samt: rupees(r['sgst']),
        cess: rupees(r['cess']),
        ...(r['remarks'] ? { remarks: r['remarks'] } : {}),
        srcform: 'R1',
        ...(r['rtnprd'] ? { rtnprd: r['rtnprd'] } : {}),
      };
      if (r['red'] !== null && r['red'] !== undefined) {
        record['itcRedReq'] = r['red'] ? 'Y' : 'N';
        if (r['red']) {
          record['declIgst'] = rupees(r['declared_igst']);
          record['declCgst'] = rupees(r['declared_cgst']);
          record['declSgst'] = rupees(r['declared_sgst']);
          record['declCess'] = rupees(r['declared_cess']);
        }
      }
      (invdata[section] ??= []).push(record);
    }
    return {
      payload: { rtin: gstin, reqtyp: 'SAVE', invdata },
      meta: {
        format: 'IMS Offline Utility v2.0 upload JSON',
        verification: 'built_from_utility_macros_unverified',
        records: rows.length,
      },
    };
  });
}

// --- ECRRS and RCM statement balances ----------------------------------------------------------

export function declareStatementBalance(body: DeclareStatementBalanceBody) {
  const auth = requireAuthContext();
  return withTransaction(async (tx) => {
    await assertFeature(tx, 'gst_workings');
    await tx.query(
      `INSERT INTO gst_statement_balances (id, tenant_id, gstin, statement, as_of_period, igst, cgst,
         sgst, cess, source, note, created_by)
       VALUES ($1, app.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO NOTHING`,
      [
        body.id,
        body.gstin,
        body.statement,
        body.asOfPeriod,
        body.igst,
        body.cgst,
        body.sgst,
        body.cess,
        body.source,
        body.note ?? null,
        auth.userId,
      ],
    );
    await recordAudit(tx, {
      action: 'gst_statement_balance.declared',
      entityType: 'gst_statement_balance',
      entityId: body.id,
      metadata: { gstin: body.gstin, statement: body.statement, asOfPeriod: body.asOfPeriod },
    });
    return listBalances(tx, body.gstin);
  });
}

function listBalances(tx: Tx, gstin: string) {
  return tx.many(
    `SELECT id, statement, as_of_period AS "asOfPeriod", igst, cgst, sgst, cess, source, note,
            created_at AS "createdAt"
     FROM gst_statement_balances WHERE gstin = $1
     ORDER BY statement, as_of_period DESC, created_at DESC`,
    [gstin],
  );
}

export function listStatementBalances(gstin: string) {
  return withReadTransaction(async (tx) => {
    await assertFeature(tx, 'gst_workings');
    return listBalances(tx, gstin);
  });
}

// --- History ------------------------------------------------------------------------------------

export function itcHistory(registerId: string) {
  return withReadTransaction(async (tx) => {
    await assertFeature(tx, 'gst_workings');
    const exists = await tx.one('SELECT id FROM itc_register WHERE id = $1', [registerId]);
    if (!exists) throw new NotFoundError('ITC register entry');
    return itcEngineRepository.movementsFor(tx, registerId);
  });
}
