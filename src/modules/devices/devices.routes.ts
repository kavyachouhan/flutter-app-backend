import { Router } from 'express';
import { requirePermission } from '../../middleware/authorize.js';
import { validate, validated } from '../../middleware/validate.js';
import { idParams } from '../../lib/validators.js';
import * as devicesService from './devices.service.js';
import { updateDeviceBody } from './devices.schemas.js';

export const devicesRouter: Router = Router();

devicesRouter.get('/', requirePermission('devices:read'), async (_req, res) => {
  res.json({ data: await devicesService.listDevices() });
});

const update = { params: idParams, body: updateDeviceBody };
devicesRouter.patch(
  '/:id',
  requirePermission('devices:manage'),
  validate(update),
  async (req, res) => {
    const { params, body } = validated<typeof update>(req);
    res.json({ data: await devicesService.updateDevice(params.id, body) });
  },
);

const byId = { params: idParams };
devicesRouter.post(
  '/:id/deactivate',
  requirePermission('devices:manage'),
  validate(byId),
  async (req, res) => {
    const { params } = validated<typeof byId>(req);
    res.json({ data: await devicesService.deactivateDevice(params.id) });
  },
);
