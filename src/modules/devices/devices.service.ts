import { withReadTransaction, withTransaction, type Tx } from '../../db/tx.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { assertOutletAccess } from '../../middleware/authorize.js';
import { diffFields, recordAudit } from '../audit/audit.js';
import { authRepository } from '../auth/auth.repository.js';
import { outletsRepository } from '../outlets/outlets.repository.js';
import { devicesRepository, type DeviceRow } from './devices.repository.js';
import type { UpdateDeviceBody } from './devices.schemas.js';

async function requireDevice(tx: Tx, id: string): Promise<DeviceRow> {
  const device = await devicesRepository.findById(tx, id);
  if (!device) throw new NotFoundError('Device');
  return device;
}

export function listDevices() {
  return withReadTransaction((tx) => devicesRepository.list(tx));
}

export function updateDevice(id: string, patch: UpdateDeviceBody) {
  return withTransaction(async (tx) => {
    const before = await requireDevice(tx, id);
    const outletId = patch.outletId === undefined ? before.outletId : patch.outletId;
    const counterId = patch.counterId === undefined ? before.counterId : patch.counterId;

    if (outletId) {
      assertOutletAccess(outletId);
      if (!(await outletsRepository.findOutlet(tx, outletId))) throw new NotFoundError('Outlet');
    }
    if (counterId) {
      const counter = await outletsRepository.findCounter(tx, counterId);
      if (!counter) throw new NotFoundError('Counter');
      if (counter.outletId !== outletId) {
        throw new ValidationError('The counter does not belong to the device outlet.');
      }
    }

    await devicesRepository.update(tx, id, patch);
    const changes = diffFields(before, patch);
    if (changes)
      await recordAudit(tx, {
        action: 'device.updated',
        entityType: 'device',
        entityId: id,
        changes,
      });
    return requireDevice(tx, id);
  });
}

/** Revokes refresh tokens too, so the device is locked out at its next refresh. */
export function deactivateDevice(id: string) {
  return withTransaction(async (tx) => {
    await requireDevice(tx, id);
    await devicesRepository.deactivate(tx, id);
    await authRepository.revokeForDevice(tx, id, 'device_deactivated');
    await recordAudit(tx, { action: 'device.deactivated', entityType: 'device', entityId: id });
    return requireDevice(tx, id);
  });
}
