import { buildSet } from '../../db/sql.js';
import type { Tx } from '../../db/tx.js';
import type { CapKind } from '../../domain/pricing/resolve.js';
import type { Cursor } from '../../lib/pagination.js';

/**
 * NUMERIC columns come back from pg as strings, and every one of these is
 * nullable because an unset limit means no limit. The service casts once, on
 * the way into the pure domain.
 */
export interface DiscountPolicyRow {
  id: string;
  outletId: string | null;
  maxLineDiscountPercent: string | null;
  maxBillDiscountPercent: string | null;
  maxDiscountAmount: number | null;
  minMarginPercent: string | null;
  requireApprovalAbovePercent: string | null;
  approverPermission: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface DiscountApprovalRow {
  id: string;
  outletId: string;
  invoiceId: string | null;
  invoiceLineId: string | null;
  breachKind: CapKind;
  requestedValue: string;
  allowedValue: string;
  requestedBy: string;
  approvedBy: string;
  approverRole: string;
  reason: string | null;
  approvedAt: Date;
  createdAt: Date;
}

/**
 * An approval travels inside the invoice that carries the discount, and is
 * written in the same transaction, right after the header.
 *
 * That is deliberate and it is what the rest of the document works like:
 * lines, tenders and allocations all arrive with the invoice rather than being
 * posted separately and linked. It buys three things here — the approval and
 * the discount it authorises can never be committed apart, an offline sale
 * uploads its evidence with it, and the table stays genuinely append-only
 * because no later statement has to claim the row.
 *
 * `invoiceId` stays nullable only for the case with no invoice: an approval
 * given for a sale that was then abandoned, which is itself worth seeing.
 */
export interface NewDiscountApproval {
  id: string;
  outletId: string;
  invoiceId: string | null;
  invoiceLineId: string | null;
  breachKind: string;
  requestedValue: number;
  allowedValue: number;
  requestedBy: string;
  approvedBy: string;
  approverRole: string;
  reason: string | null;
  approvedAt: string;
}

const POLICY_COLUMNS = `
  id, outlet_id AS "outletId",
  max_line_discount_percent AS "maxLineDiscountPercent",
  max_bill_discount_percent AS "maxBillDiscountPercent",
  max_discount_amount AS "maxDiscountAmount",
  min_margin_percent AS "minMarginPercent",
  require_approval_above_percent AS "requireApprovalAbovePercent",
  approver_permission AS "approverPermission",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

const POLICY_UPDATABLE = {
  maxLineDiscountPercent: 'max_line_discount_percent',
  maxBillDiscountPercent: 'max_bill_discount_percent',
  maxDiscountAmount: 'max_discount_amount',
  minMarginPercent: 'min_margin_percent',
  requireApprovalAbovePercent: 'require_approval_above_percent',
  approverPermission: 'approver_permission',
} as const;

const APPROVAL_COLUMNS = `
  id, outlet_id AS "outletId", invoice_id AS "invoiceId", invoice_line_id AS "invoiceLineId",
  breach_kind AS "breachKind", requested_value AS "requestedValue", allowed_value AS "allowedValue",
  requested_by AS "requestedBy", approved_by AS "approvedBy", approver_role AS "approverRole",
  reason, approved_at AS "approvedAt", created_at AS "createdAt"`;

export const discountsRepository = {
  /**
   * The tenant-wide row and the outlet's override, in that order, so the
   * caller can merge field by field. Two rows at most, so one query rather
   * than two round-trips on the billing path.
   */
  scopedPolicies(tx: Tx, outletId: string | null): Promise<DiscountPolicyRow[]> {
    return tx.many<DiscountPolicyRow>(
      `SELECT ${POLICY_COLUMNS} FROM discount_policies
       WHERE deleted_at IS NULL AND (outlet_id IS NULL OR outlet_id = $1::uuid)
       ORDER BY outlet_id NULLS FIRST`,
      [outletId],
    );
  },

  findByScope(tx: Tx, outletId: string | null): Promise<DiscountPolicyRow | undefined> {
    return tx.one<DiscountPolicyRow>(
      `SELECT ${POLICY_COLUMNS} FROM discount_policies
       WHERE deleted_at IS NULL AND outlet_id IS NOT DISTINCT FROM $1::uuid`,
      [outletId],
    );
  },

  async insertPolicy(
    tx: Tx,
    policy: { id: string; outletId: string | null; approverPermission: string },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO discount_policies (id, tenant_id, outlet_id, approver_permission)
       VALUES ($1, app.current_tenant_id(), $2, $3)`,
      [policy.id, policy.outletId, policy.approverPermission],
    );
  },

  async updatePolicy(tx: Tx, id: string, patch: Record<string, unknown>): Promise<void> {
    const { clause, values } = buildSet(patch, POLICY_UPDATABLE, 2);
    if (clause) {
      await tx.query(`UPDATE discount_policies SET ${clause} WHERE id = $1`, [id, ...values]);
    }
  },

  async insertApproval(tx: Tx, a: NewDiscountApproval): Promise<void> {
    await tx.query(
      `INSERT INTO discount_approvals (id, tenant_id, outlet_id, invoice_id, invoice_line_id,
         breach_kind, requested_value, allowed_value, requested_by, approved_by, approver_role,
         reason, approved_at)
       VALUES ($1, app.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        a.id,
        a.outletId,
        a.invoiceId,
        a.invoiceLineId,
        a.breachKind,
        a.requestedValue,
        a.allowedValue,
        a.requestedBy,
        a.approvedBy,
        a.approverRole,
        a.reason,
        a.approvedAt,
      ],
    );
  },

  listApprovals(
    tx: Tx,
    filter: {
      from: string | undefined;
      to: string | undefined;
      approvedBy: string | undefined;
      invoiceId: string | undefined;
    },
    restrictTo: readonly string[] | null,
    limit: number,
    cursor: Cursor | undefined,
  ): Promise<DiscountApprovalRow[]> {
    return tx.many<DiscountApprovalRow>(
      `SELECT ${APPROVAL_COLUMNS} FROM discount_approvals
       WHERE ($1::date IS NULL OR approved_at >= $1::date)
         AND ($2::date IS NULL OR approved_at < ($2::date + 1))
         AND ($3::uuid IS NULL OR approved_by = $3::uuid)
         AND ($4::uuid IS NULL OR invoice_id = $4::uuid)
         AND ($5::uuid[] IS NULL OR outlet_id = ANY($5::uuid[]))
         AND ($6::timestamptz IS NULL OR (approved_at, id) < ($6::timestamptz, $7::uuid))
       ORDER BY approved_at DESC, id DESC
       LIMIT $8`,
      [
        filter.from ?? null,
        filter.to ?? null,
        filter.approvedBy ?? null,
        filter.invoiceId ?? null,
        restrictTo ? [...restrictTo] : null,
        cursor?.k ?? null,
        cursor?.id ?? null,
        limit + 1,
      ],
    );
  },
};
