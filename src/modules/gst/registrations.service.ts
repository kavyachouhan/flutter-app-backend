/**
 * GST registrations as the source of the business's GST facts (freeze §9a). The tenant and outlet
 * services call these; the database functions write the registration tables and mirror the old
 * columns for app versions that still read them.
 */
import type { Tx } from '../../db/tx.js';
import { withReadTransaction, withTransaction } from '../../db/tx.js';
import { NotFoundError } from '../../lib/errors.js';
import { recordAudit } from '../audit/audit.js';

export interface TenantGstFacts {
  readonly tenantId: string;
  readonly isGstRegistered: boolean;
  readonly gstin: string | null;
  readonly stateCode: string;
  readonly isComposition: boolean;
  readonly compositionCategory: string | null;
  readonly compositionRatePercent: string | number | null;
  readonly filingFrequency: string;
  readonly registrationEffectiveFrom: string | Date | null;
  readonly name: string;
  readonly legalName: string | null;
}

export async function setTenantGst(tx: Tx, f: TenantGstFacts): Promise<void> {
  await tx.query('SELECT app.set_tenant_gst($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)', [
    f.tenantId,
    f.isGstRegistered,
    f.gstin,
    f.stateCode,
    f.isComposition,
    f.compositionCategory,
    f.compositionRatePercent,
    f.filingFrequency,
    f.registrationEffectiveFrom,
    f.name,
    f.legalName,
  ]);
}

export async function setOutletGstin(
  tx: Tx,
  outletId: string,
  gstin: string | null,
  stateCode: string | null,
): Promise<void> {
  await tx.query('SELECT app.set_outlet_gstin($1, $2, $3)', [outletId, gstin, stateCode]);
}

/** An outlet that is gone no longer keeps its own GSTIN in force. */
export async function closeUnusedRegistrations(tx: Tx): Promise<void> {
  await tx.query('SELECT app.close_unused_registrations(app.current_tenant_id())');
}

interface RegistrationRow {
  id: string;
  gstin: string;
  stateCode: string;
  isPrincipal: boolean;
  status: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  roundOffEnabled: boolean;
}

const COLUMNS = `id, gstin, state_code AS "stateCode", is_principal AS "isPrincipal", status,
  effective_from AS "effectiveFrom", effective_to AS "effectiveTo", round_off_enabled AS "roundOffEnabled"`;

export function listRegistrations(): Promise<RegistrationRow[]> {
  return withReadTransaction((tx) =>
    tx.many<RegistrationRow>(
      `SELECT ${COLUMNS} FROM gst_registrations WHERE deleted_at IS NULL ORDER BY is_principal DESC, gstin`,
    ),
  );
}

/** D5: rounding the bill to the rupee is this registration's choice, on unless it says otherwise. */
export function updateRegistration(id: string, patch: { roundOffEnabled: boolean }): Promise<RegistrationRow> {
  return withTransaction(async (tx) => {
    const row = await tx.one<RegistrationRow>(
      `UPDATE gst_registrations SET round_off_enabled = $2 WHERE id = $1 AND deleted_at IS NULL RETURNING ${COLUMNS}`,
      [id, patch.roundOffEnabled],
    );
    if (!row) throw new NotFoundError('GST registration');
    await recordAudit(tx, { action: 'gst_registration.updated', entityType: 'gst_registration', entityId: id });
    return row;
  });
}
