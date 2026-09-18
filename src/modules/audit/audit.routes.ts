import { Router } from 'express';
import { requirePermission } from '../../middleware/authorize.js';
import { validate, validated } from '../../middleware/validate.js';
import * as auditService from './audit.service.js';
import { listAuditQuery } from './audit.schemas.js';

export const auditRouter: Router = Router();

// Read-only by design: audit_log revokes UPDATE and DELETE, so there is no
// route that could rewrite history.
const list = { query: listAuditQuery };
auditRouter.get('/', requirePermission('audit:read'), validate(list), async (req, res) => {
  const { query } = validated<typeof list>(req);
  res.json(await auditService.listAudit(query));
});
