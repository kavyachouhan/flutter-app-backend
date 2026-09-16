import { withReadTransaction, withTransaction, type Tx } from '../../db/tx.js';
import { NotFoundError, UnprocessableError } from '../../lib/errors.js';
import { accessibleOutletIds, assertOutletAccess } from '../../middleware/authorize.js';
import { diffFields, recordAudit } from '../audit/audit.js';
import { assertQuota } from '../entitlements/entitlements.js';
import { numberingRepository } from '../numbering/numbering.repository.js';
import { outletsRepository, type CounterRow, type OutletRow } from './outlets.repository.js';
import type {
  CreateCounterBody,
  CreateOutletBody,
  UpdateCounterBody,
  UpdateOutletBody,
} from './outlets.schemas.js';

async function requireOutlet(tx: Tx, id: string, forUpdate = false): Promise<OutletRow> {
  const outlet = await outletsRepository.findOutlet(tx, id, forUpdate);
  if (!outlet) throw new NotFoundError('Outlet');
  return outlet;
}

async function requireCounter(tx: Tx, id: string, forUpdate = false): Promise<CounterRow> {
  const counter = await outletsRepository.findCounter(tx, id, forUpdate);
  if (!counter) throw new NotFoundError('Counter');
  return counter;
}

export function listOutlets() {
  return withReadTransaction((tx) => outletsRepository.listOutlets(tx, accessibleOutletIds()));
}

export function createOutlet(body: CreateOutletBody) {
  return withTransaction(async (tx) => {
    const existing = await outletsRepository.findOutlet(tx, body.id);
    if (existing) return existing;

    await assertQuota(tx, 'outlets');
    if (body.isDefault) await outletsRepository.clearDefaultOutlet(tx);
    await outletsRepository.insertOutlet(tx, {
      id: body.id,
      name: body.name,
      code: body.code,
      gstin: body.gstin ?? null,
      stateCode: body.stateCode ?? null,
      addressLine1: body.addressLine1 ?? null,
      addressLine2: body.addressLine2 ?? null,
      city: body.city ?? null,
      pincode: body.pincode ?? null,
      phone: body.phone ?? null,
      isActive: body.isActive ?? true,
      isDefault: body.isDefault ?? false,
    });
    await recordAudit(tx, { action: 'outlet.created', entityType: 'outlet', entityId: body.id });
    return requireOutlet(tx, body.id);
  });
}

export function updateOutlet(id: string, patch: UpdateOutletBody) {
  assertOutletAccess(id);
  return withTransaction(async (tx) => {
    const before = await requireOutlet(tx, id, true);

    if (before.isDefault && (patch.isDefault === false || patch.isActive === false)) {
      throw new UnprocessableError('Make another outlet the default first.');
    }
    // Series that print the outlet code would change the format of an in-flight
    // number sequence mid-year.
    if (
      patch.code !== undefined &&
      patch.code !== before.code &&
      (await numberingRepository.outletCodeInUse(tx, id))
    ) {
      throw new UnprocessableError(
        'This outlet code is printed in a document series and cannot change.',
      );
    }
    if (patch.isDefault && !before.isDefault) await outletsRepository.clearDefaultOutlet(tx);

    await outletsRepository.updateOutlet(tx, id, patch);
    const changes = diffFields(before, patch);
    if (changes)
      await recordAudit(tx, {
        action: 'outlet.updated',
        entityType: 'outlet',
        entityId: id,
        changes,
      });
    return requireOutlet(tx, id);
  });
}

export function deleteOutlet(id: string) {
  assertOutletAccess(id);
  return withTransaction(async (tx) => {
    const outlet = await requireOutlet(tx, id, true);
    if (outlet.isDefault) throw new UnprocessableError('The default outlet cannot be deleted.');
    if ((await outletsRepository.countLiveCounters(tx, id)) > 0) {
      throw new UnprocessableError('Delete this outlet’s counters first.');
    }
    await outletsRepository.softDeleteOutlet(tx, id);
    await recordAudit(tx, { action: 'outlet.deleted', entityType: 'outlet', entityId: id });
  });
}

export function listCounters(outletId: string | undefined) {
  if (outletId) assertOutletAccess(outletId);
  return withReadTransaction((tx) =>
    outletsRepository.listCounters(tx, outletId, accessibleOutletIds()),
  );
}

export function createCounter(body: CreateCounterBody) {
  assertOutletAccess(body.outletId);
  return withTransaction(async (tx) => {
    const existing = await outletsRepository.findCounter(tx, body.id);
    if (existing) return existing;

    await requireOutlet(tx, body.outletId);
    await assertQuota(tx, 'counters');
    if (body.isDefault) await outletsRepository.clearDefaultCounter(tx, body.outletId);
    await outletsRepository.insertCounter(tx, {
      id: body.id,
      outletId: body.outletId,
      name: body.name,
      code: body.code,
      isActive: body.isActive ?? true,
      isDefault: body.isDefault ?? false,
    });
    await recordAudit(tx, { action: 'counter.created', entityType: 'counter', entityId: body.id });
    return requireCounter(tx, body.id);
  });
}

export function updateCounter(id: string, patch: UpdateCounterBody) {
  return withTransaction(async (tx) => {
    const before = await requireCounter(tx, id, true);
    assertOutletAccess(before.outletId);

    if (before.isDefault && (patch.isDefault === false || patch.isActive === false)) {
      throw new UnprocessableError('Make another counter the default first.');
    }
    if (
      patch.code !== undefined &&
      patch.code !== before.code &&
      (await numberingRepository.counterCodeInUse(tx, id))
    ) {
      throw new UnprocessableError(
        'This counter code is printed in a document series and cannot change.',
      );
    }
    if (patch.isDefault && !before.isDefault)
      await outletsRepository.clearDefaultCounter(tx, before.outletId);

    await outletsRepository.updateCounter(tx, id, patch);
    const changes = diffFields(before, patch);
    if (changes)
      await recordAudit(tx, {
        action: 'counter.updated',
        entityType: 'counter',
        entityId: id,
        changes,
      });
    return requireCounter(tx, id);
  });
}

export function deleteCounter(id: string) {
  return withTransaction(async (tx) => {
    const counter = await requireCounter(tx, id, true);
    assertOutletAccess(counter.outletId);
    if (counter.isDefault) throw new UnprocessableError('The default counter cannot be deleted.');
    await outletsRepository.softDeleteCounter(tx, id);
    await recordAudit(tx, { action: 'counter.deleted', entityType: 'counter', entityId: id });
  });
}
