import { env } from '../../config/env.js';
import { withReadTransaction, withTransaction } from '../../db/tx.js';
import { ConflictError, ErrorCode, NotFoundError, ValidationError } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { diffFields, recordAudit } from '../audit/audit.js';
import { createSession } from '../auth/auth.service.js';
import { getSubscriptionWithUsage, insertFreeSubscription } from '../entitlements/entitlements.js';
import { membersRepository } from '../members/members.repository.js';
import { outletsRepository } from '../outlets/outlets.repository.js';
import { tenantsRepository } from './tenants.repository.js';
import type { CreateTenantBody, UpdateTenantBody } from './tenants.schemas.js';

/** Checked here so a bad combination is a 400, not a CHECK-constraint 500. */
function assertGstConsistency(state: {
  isGstRegistered: boolean;
  gstin: string | null;
  isComposition: boolean;
}): void {
  if (state.isGstRegistered && !state.gstin) {
    throw new ValidationError('A GST-registered business needs a GSTIN.', {
      details: { fields: { gstin: 'required' } },
    });
  }
  if (state.isComposition && !state.isGstRegistered) {
    throw new ValidationError('Composition scheme requires GST registration.');
  }
}

export async function onboardTenant(userId: string, body: CreateTenantBody) {
  const isComposition = body.isComposition ?? false;
  assertGstConsistency({
    isGstRegistered: body.isGstRegistered,
    gstin: body.gstin ?? null,
    isComposition,
  });

  const tenant = await withTransaction(
    async (tx) => {
      if (await tenantsRepository.findCurrent(tx)) {
        throw new ConflictError('This tenant already exists.', ErrorCode.DUPLICATE);
      }

      await tenantsRepository.insert(tx, {
        id: body.id,
        name: body.name,
        legalName: body.legalName ?? null,
        isGstRegistered: body.isGstRegistered,
        gstin: body.gstin ?? null,
        isComposition,
        pan: body.pan ?? null,
        stateCode: body.stateCode,
        addressLine1: body.addressLine1 ?? null,
        addressLine2: body.addressLine2 ?? null,
        city: body.city ?? null,
        pincode: body.pincode ?? null,
        phone: body.phone ?? null,
        email: body.email ?? null,
        locale: body.locale ?? env.TENANT_DEFAULT_LOCALE,
        timezone: body.timezone ?? env.TENANT_DEFAULT_TIMEZONE,
        currencyCode: body.currencyCode ?? env.TENANT_DEFAULT_CURRENCY_CODE,
        currencySymbol: body.currencySymbol ?? env.TENANT_DEFAULT_CURRENCY_SYMBOL,
        fyStartMonth: body.fyStartMonth ?? env.TENANT_DEFAULT_FY_START_MONTH,
        allowNegativeStock: body.allowNegativeStock ?? env.TENANT_DEFAULT_ALLOW_NEGATIVE_STOCK,
        defaultPricesIncludeTax:
          body.defaultPricesIncludeTax ?? env.TENANT_DEFAULT_PRICES_INCLUDE_TAX,
      });

      await insertFreeSubscription(tx);
      await membersRepository.insert(tx, { id: newId(), userId, role: 'owner', outletIds: null });
      await outletsRepository.insertOutlet(tx, {
        id: body.outlet.id,
        name: body.outlet.name,
        code: body.outlet.code,
        gstin: null,
        stateCode: null,
        addressLine1: null,
        addressLine2: null,
        city: null,
        pincode: null,
        phone: null,
        isActive: true,
        isDefault: true,
      });
      await outletsRepository.insertCounter(tx, {
        id: body.counter.id,
        outletId: body.outlet.id,
        name: body.counter.name,
        code: body.counter.code,
        isActive: true,
        isDefault: true,
      });
      await recordAudit(tx, { action: 'tenant.created', entityType: 'tenant', entityId: body.id });
      return tenantsRepository.findCurrent(tx);
    },
    { tenantId: body.id },
  );

  const session = await createSession(userId, { tenantId: body.id, device: body.device });
  return { tenant, session };
}

export async function getTenant() {
  const tenant = await withReadTransaction((tx) => tenantsRepository.findCurrent(tx));
  if (!tenant) throw new NotFoundError('Tenant');
  return tenant;
}

export function updateTenant(patch: UpdateTenantBody) {
  return withTransaction(async (tx) => {
    const before = await tenantsRepository.findCurrent(tx);
    if (!before) throw new NotFoundError('Tenant');

    assertGstConsistency({
      isGstRegistered: patch.isGstRegistered ?? before.isGstRegistered,
      gstin: patch.gstin === undefined ? before.gstin : patch.gstin,
      isComposition: patch.isComposition ?? before.isComposition,
    });

    await tenantsRepository.update(tx, patch);
    const changes = diffFields(before, patch);
    if (changes)
      await recordAudit(tx, {
        action: 'tenant.updated',
        entityType: 'tenant',
        entityId: before.id,
        changes,
      });
    return tenantsRepository.findCurrent(tx);
  });
}

export function getSubscription() {
  return withReadTransaction((tx) => getSubscriptionWithUsage(tx));
}
