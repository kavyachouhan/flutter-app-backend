/**
 * Receipt vouchers, refund vouchers and the adjustment of advances against invoices (s.31(3)(d),
 * (e); Rules 50, 51). See domain/gst/advances.ts for the tax rules and Table 11.
 */
import { withReadTransaction, withTransaction, type Tx } from '../../../db/tx.js';
import {
  RULE_50_DEFAULT_RATE,
  shareOf,
  voucherTax,
  type AdvanceMovement,
  type AdvanceVoucher,
} from '../../../domain/gst/advances.js';
import type { TaxedValue } from '../../../domain/gst/returns/model.js';
import { requireAuthContext } from '../../../lib/context.js';
import { ErrorCode, NotFoundError, UnprocessableError } from '../../../lib/errors.js';
import { assertOutletAccess } from '../../../middleware/authorize.js';
import { recordAudit } from '../../audit/audit.js';
import { assertFeature } from '../../entitlements/entitlements.js';
import { gstr1FiledFor } from '../filing-state.js';
import type {
  AdjustAdvanceBody,
  CreateReceiptVoucherBody,
  ListReceiptVouchersQuery,
  RefundAdvanceBody,
} from './advances.schemas.js';

const n = (v: unknown) => Number(v ?? 0);
const todayIso = () => new Date().toISOString().slice(0, 10);
const fyOf = (date: string) => {
  const y = Number(date.slice(0, 4));
  return Number(date.slice(5, 7)) >= 4 ? y : y - 1;
};
const fyLabel = (fy: number) =>
  `${String(fy % 100).padStart(2, '0')}${String((fy + 1) % 100).padStart(2, '0')}`;

/** Next number in a per-registration, per-year series, without gaps (advisory lock). */
async function nextNumber(tx: Tx, table: 'receipt_vouchers' | 'refund_vouchers', gstin: string, fy: number) {
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${table}:${gstin}:${fy}`]);
  const row = await tx.one<{ seq: number }>(
    `SELECT COALESCE(max(sequence_no), 0) + 1 AS seq FROM ${table} WHERE gstin = $1 AND fy_start_year = $2`,
    [gstin, fy],
  );
  return n(row?.seq ?? 1);
}

const VOUCHER_COLUMNS = `v.id, v.gstin, v.outlet_id AS "outletId", v.customer_id AS "customerId",
  v.payment_id AS "paymentId", v.document_number AS "documentNumber", v.document_date::text AS "documentDate",
  v.supply_kind AS "supplyKind", v.place_of_supply AS "placeOfSupply", v.supply_type AS "supplyType",
  v.rate_percent::float AS "ratePercent", v.rate_determinable AS "rateDeterminable",
  v.reverse_charge AS "reverseCharge", v.amount, v.taxable_amount AS "taxableAmount", v.igst, v.cgst,
  v.sgst, v.cess, v.description, v.status,
  v.amount - COALESCE((SELECT SUM(a.amount) FROM advance_adjustments a WHERE a.receipt_voucher_id = v.id), 0)
           - COALESCE((SELECT SUM(r.amount) FROM refund_vouchers r WHERE r.receipt_voucher_id = v.id), 0)
    AS "unadjusted", v.created_at AS "createdAt"`;

async function loadVoucher(tx: Tx, id: string, forUpdate = false) {
  const row = await tx.one<Record<string, unknown>>(
    `SELECT ${VOUCHER_COLUMNS} FROM receipt_vouchers v WHERE v.id = $1 ${forUpdate ? 'FOR UPDATE OF v' : ''}`,
    [id],
  );
  if (!row) throw new NotFoundError('Receipt voucher');
  return row;
}

const valueOf = (r: Record<string, unknown>): TaxedValue => ({
  taxable: n(r['taxableAmount']),
  igst: n(r['igst']),
  cgst: n(r['cgst']),
  sgst: n(r['sgst']),
  cess: n(r['cess']),
});

export function createReceiptVoucher(body: CreateReceiptVoucherBody) {
  const auth = requireAuthContext();
  assertOutletAccess(body.outletId);
  return withTransaction(async (tx) => {
    await assertFeature(tx, 'gst_workings');
    const existing = await tx.one('SELECT id FROM receipt_vouchers WHERE id = $1', [body.id]);
    if (existing) return loadVoucher(tx, body.id);

    const documentDate = body.documentDate ?? todayIso();
    const reg = await tx.one<{ gstin: string; stateCode: string }>(
      `SELECT r.gstin, r.state_code AS "stateCode" FROM outlets o
       JOIN gst_registrations r ON r.id = o.registration_id
       WHERE o.id = $1 AND $2::date >= r.effective_from AND (r.effective_to IS NULL OR $2::date < r.effective_to)`,
      [body.outletId, documentDate],
    );
    if (!reg) {
      throw new UnprocessableError(
        'The outlet has no GST registration in force on this date, so a receipt voucher cannot be issued.',
        ErrorCode.UNPROCESSABLE,
      );
    }
    let customerState: string | null = null;
    if (body.customerId) {
      const c = await tx.one<{ stateCode: string | null }>(
        'SELECT state_code AS "stateCode" FROM customers WHERE id = $1',
        [body.customerId],
      );
      if (!c) throw new NotFoundError('Customer');
      customerState = c.stateCode;
    }
    // Rule 50 proviso: rate not determinable, 18%; nature not determinable, inter-State.
    const rateDeterminable = body.ratePercent !== undefined;
    const ratePercent = body.ratePercent ?? RULE_50_DEFAULT_RATE;
    const placeOfSupply = body.placeOfSupply ?? customerState ?? reg.stateCode;
    const supplyType: 'intra_state' | 'inter_state' =
      body.placeOfSupply === undefined && customerState === null
        ? 'inter_state'
        : placeOfSupply === reg.stateCode
          ? 'intra_state'
          : 'inter_state';
    const value = voucherTax({ amount: body.amount, ratePercent, supplyKind: body.supplyKind, supplyType });
    const fy = fyOf(documentDate);
    const seq = await nextNumber(tx, 'receipt_vouchers', reg.gstin, fy);

    await tx.query(
      `INSERT INTO receipt_vouchers (id, tenant_id, gstin, outlet_id, customer_id, payment_id, fy_start_year,
         sequence_no, document_number, document_date, supply_kind, place_of_supply, supply_type,
         rate_percent, rate_determinable, reverse_charge, amount, taxable_amount, igst, cgst, sgst, cess,
         description, created_by)
       VALUES ($1, app.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
         $16, $17, $18, $19, $20, $21, $22, $23)`,
      [
        body.id,
        reg.gstin,
        body.outletId,
        body.customerId ?? null,
        body.paymentId ?? null,
        fy,
        seq,
        `RV/${fyLabel(fy)}/${seq}`,
        documentDate,
        body.supplyKind,
        placeOfSupply,
        supplyType,
        ratePercent,
        rateDeterminable,
        body.reverseCharge ?? false,
        body.amount,
        value.taxable,
        value.igst,
        value.cgst,
        value.sgst,
        value.cess,
        body.description ?? null,
        auth.userId,
      ],
    );
    await recordAudit(tx, {
      action: 'receipt_voucher.issued',
      entityType: 'receipt_voucher',
      entityId: body.id,
      metadata: { gstin: reg.gstin, amount: body.amount, supplyKind: body.supplyKind, ratePercent },
    });
    return loadVoucher(tx, body.id);
  });
}

export function refundAdvance(voucherId: string, body: RefundAdvanceBody) {
  const auth = requireAuthContext();
  return withTransaction(async (tx) => {
    await assertFeature(tx, 'gst_workings');
    const v = await loadVoucher(tx, voucherId, true);
    if (v['status'] !== 'issued') throw new UnprocessableError('This voucher is void.', ErrorCode.UNPROCESSABLE);
    if (body.amount > n(v['unadjusted'])) {
      throw new UnprocessableError(
        'A refund cannot be more than the advance not yet adjusted or refunded.',
        ErrorCode.UNPROCESSABLE,
        { details: { unadjusted: n(v['unadjusted']) } },
      );
    }
    const documentDate = body.documentDate ?? todayIso();
    const share = shareOf({ amount: n(v['amount']), value: valueOf(v) }, body.amount);
    const gstin = String(v['gstin']);
    const fy = fyOf(documentDate);
    const seq = await nextNumber(tx, 'refund_vouchers', gstin, fy);
    await tx.query(
      `INSERT INTO refund_vouchers (id, tenant_id, gstin, receipt_voucher_id, fy_start_year, sequence_no,
         document_number, document_date, amount, taxable_amount, igst, cgst, sgst, cess, created_by)
       VALUES ($1, app.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (id) DO NOTHING`,
      [
        body.id,
        gstin,
        voucherId,
        fy,
        seq,
        `RF/${fyLabel(fy)}/${seq}`,
        documentDate,
        body.amount,
        share.taxable,
        share.igst,
        share.cgst,
        share.sgst,
        share.cess,
        auth.userId,
      ],
    );
    await recordAudit(tx, {
      action: 'refund_voucher.issued',
      entityType: 'refund_voucher',
      entityId: body.id,
      metadata: { receiptVoucherId: voucherId, amount: body.amount },
    });
    return loadVoucher(tx, voucherId);
  });
}

export function adjustAdvance(voucherId: string, body: AdjustAdvanceBody) {
  const auth = requireAuthContext();
  return withTransaction(async (tx) => {
    await assertFeature(tx, 'gst_workings');
    const v = await loadVoucher(tx, voucherId, true);
    if (v['status'] !== 'issued') throw new UnprocessableError('This voucher is void.', ErrorCode.UNPROCESSABLE);
    const invoice = await tx.one<{ status: string; date: string; customerId: string | null; gstin: string | null }>(
      `SELECT status, document_date::text AS date, customer_id AS "customerId", supplier_gstin AS gstin
       FROM invoices WHERE id = $1`,
      [body.invoiceId],
    );
    if (!invoice) throw new NotFoundError('Invoice');
    if (invoice.status !== 'issued') {
      throw new UnprocessableError('An advance can be adjusted only against an issued invoice.', ErrorCode.UNPROCESSABLE);
    }
    if (invoice.gstin !== v['gstin']) {
      throw new UnprocessableError('The invoice is of another registration.', ErrorCode.UNPROCESSABLE);
    }
    if (v['customerId'] && invoice.customerId !== v['customerId']) {
      throw new UnprocessableError('The invoice is of another customer.', ErrorCode.UNPROCESSABLE);
    }
    if (invoice.date < String(v['documentDate'])) {
      throw new UnprocessableError('An advance cannot be adjusted against an earlier invoice.', ErrorCode.UNPROCESSABLE);
    }
    if (body.amount > n(v['unadjusted'])) {
      throw new UnprocessableError(
        'The adjustment is more than the advance left on this voucher.',
        ErrorCode.UNPROCESSABLE,
        { details: { unadjusted: n(v['unadjusted']) } },
      );
    }
    const share = shareOf({ amount: n(v['amount']), value: valueOf(v) }, body.amount);
    await tx.query(
      `INSERT INTO advance_adjustments (id, tenant_id, gstin, receipt_voucher_id, invoice_id, document_date,
         amount, taxable_amount, igst, cgst, sgst, cess, created_by)
       VALUES (gen_random_uuid(), app.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        v['gstin'],
        voucherId,
        body.invoiceId,
        invoice.date,
        body.amount,
        share.taxable,
        share.igst,
        share.cgst,
        share.sgst,
        share.cess,
        auth.userId,
      ],
    );
    await recordAudit(tx, {
      action: 'receipt_voucher.adjusted',
      entityType: 'receipt_voucher',
      entityId: voucherId,
      metadata: { invoiceId: body.invoiceId, amount: body.amount },
    });
    return loadVoucher(tx, voucherId);
  });
}

export function voidReceiptVoucher(voucherId: string) {
  return withTransaction(async (tx) => {
    await assertFeature(tx, 'gst_workings');
    const v = await loadVoucher(tx, voucherId, true);
    if (v['status'] === 'void') return v;
    if (n(v['unadjusted']) !== n(v['amount'])) {
      throw new UnprocessableError(
        'This advance is already adjusted or refunded; void those first or issue a refund voucher.',
        ErrorCode.UNPROCESSABLE,
      );
    }
    if (await gstr1FiledFor(tx, String(v['gstin']), String(v['documentDate']))) {
      throw new UnprocessableError(
        'The voucher is in a filed GSTR-1; issue a refund voucher instead.',
        ErrorCode.CORRECTION_NOT_ALLOWED,
      );
    }
    await tx.query(`UPDATE receipt_vouchers SET status = 'void', updated_at = now() WHERE id = $1`, [voucherId]);
    await recordAudit(tx, { action: 'receipt_voucher.voided', entityType: 'receipt_voucher', entityId: voucherId });
    return loadVoucher(tx, voucherId);
  });
}

export function listReceiptVouchers(query: ListReceiptVouchersQuery) {
  return withReadTransaction(async (tx) => {
    await assertFeature(tx, 'gst_workings');
    return tx.many(
      `SELECT ${VOUCHER_COLUMNS} FROM receipt_vouchers v
       WHERE ($1::text IS NULL OR v.gstin = $1) AND ($2::uuid IS NULL OR v.customer_id = $2)
         AND ($3::date IS NULL OR v.document_date >= $3) AND ($4::date IS NULL OR v.document_date <= $4)
       ORDER BY v.document_date DESC, v.sequence_no DESC LIMIT 500`,
      [query.gstin ?? null, query.customerId ?? null, query.from ?? null, query.to ?? null],
    );
  });
}

// --- For the return engines ---------------------------------------------------------------------

const ym = (date: string) => date.slice(0, 7);

/** Vouchers and movements relevant to Table 11 of the period ending `to`. */
export async function advancesFor(
  tx: Tx,
  gstin: string,
  from: string,
  to: string,
): Promise<{ vouchers: AdvanceVoucher[]; adjustments: AdvanceMovement[]; refunds: AdvanceMovement[] }> {
  const movementRows = async (table: 'advance_adjustments' | 'refund_vouchers') =>
    tx.many<Record<string, unknown>>(
      `SELECT m.receipt_voucher_id AS "voucherId", m.document_date::text AS date, m.taxable_amount AS "taxableAmount",
              m.igst, m.cgst, m.sgst, m.cess
       FROM ${table} m WHERE m.gstin = $1 AND m.document_date >= $2::date AND m.document_date <= $3::date`,
      [gstin, from, to],
    );
  const adjustments = await movementRows('advance_adjustments');
  const refunds = await movementRows('refund_vouchers');
  const ids = [...new Set([...adjustments, ...refunds].map((m) => String(m['voucherId'])))];
  const vouchers = await tx.many<Record<string, unknown>>(
    `SELECT v.id, v.document_date::text AS date, v.place_of_supply AS pos, v.supply_type AS "supplyType",
            v.rate_percent::float AS rate, v.supply_kind AS kind, v.taxable_amount AS "taxableAmount",
            v.igst, v.cgst, v.sgst, v.cess
     FROM receipt_vouchers v
     WHERE v.gstin = $1 AND v.status = 'issued'
       AND ((v.document_date >= $2::date AND v.document_date <= $3::date) OR v.id = ANY($4::uuid[]))`,
    [gstin, from, to, ids],
  );
  // Quarterly filers: every date in the window maps to the window's period key.
  const periodKey = ym(to);
  const inWindow = (d: string) => d >= from && d <= to;
  return {
    vouchers: vouchers.map((v) => ({
      id: String(v['id']),
      period: inWindow(String(v['date'])) ? periodKey : ym(String(v['date'])),
      placeOfSupply: String(v['pos']),
      supplyType: v['supplyType'] as 'intra_state' | 'inter_state',
      ratePercent: Number(v['rate']),
      supplyKind: v['kind'] as 'goods' | 'services',
      value: valueOf(v),
    })),
    adjustments: adjustments.map((m) => ({ voucherId: String(m['voucherId']), period: periodKey, value: valueOf(m) })),
    refunds: refunds.map((m) => ({ voucherId: String(m['voucherId']), period: periodKey, value: valueOf(m) })),
  };
}
