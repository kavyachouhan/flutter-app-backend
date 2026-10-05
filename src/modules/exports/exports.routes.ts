import { Router } from 'express';
import { signDownload } from '../../lib/storage.js';
import { requirePermission } from '../../middleware/authorize.js';
import { validate, validated } from '../../middleware/validate.js';
import * as exportsService from './exports.service.js';
import { createExportBody, labelPayloadBody } from './exports.schemas.js';

export const exportsRouter: Router = Router();
export const labelsRouter: Router = Router();

/**
 * An export reads whatever it exports, so it is gated on the permission for
 * that data rather than on one blanket export permission: `reports:read` is
 * the closest existing fit for "may take a bulk extract of business data",
 * and it is already withheld from nobody who can see the data on screen.
 */
const create = { body: createExportBody };
exportsRouter.post('/', requirePermission('reports:read'), validate(create), async (req, res) => {
  const { body } = validated<typeof create>(req);
  const result = await exportsService.createExport(body);
  // Signed here rather than in the service so the service stays testable
  // without a storage round trip.
  const link = await signDownload(result.objectKey);
  res.status(201).json({ data: { ...result, downloadUrl: link.url, expiresAt: link.expiresAt } });
});

labelsRouter.get('/templates', requirePermission('catalogue:read'), (_req, res) => {
  res.json({ data: exportsService.listLabelTemplates() });
});

const labels = { body: labelPayloadBody };
labelsRouter.post(
  '/payload',
  requirePermission('catalogue:read'),
  validate(labels),
  async (req, res) => {
    const { body } = validated<typeof labels>(req);
    res.json({ data: await exportsService.buildLabelPayload(body) });
  },
);
