import { Router } from 'express';
import { identityUserId } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/authorize.js';
import { validate, validated } from '../../middleware/validate.js';
import { listTenantsForUser } from '../auth/auth.service.js';
import * as tenantsService from './tenants.service.js';
import { createTenantBody, updateTenantBody } from './tenants.schemas.js';

/** Mounted behind requireIdentityToken: the user has verified OTP but has no tenant session yet. */
export const onboardingRouter: Router = Router();

onboardingRouter.get('/tenants', async (_req, res) => {
  res.json({ data: await listTenantsForUser(identityUserId()) });
});

const create = { body: createTenantBody };
onboardingRouter.post('/tenants', validate(create), async (req, res) => {
  const { body } = validated<typeof create>(req);
  res.status(201).json({ data: await tenantsService.onboardTenant(identityUserId(), body) });
});

export const tenantRouter: Router = Router();

tenantRouter.get('/', requirePermission('tenant:read'), async (_req, res) => {
  res.json({ data: await tenantsService.getTenant() });
});

const update = { body: updateTenantBody };
tenantRouter.patch('/', requirePermission('tenant:manage'), validate(update), async (req, res) => {
  const { body } = validated<typeof update>(req);
  res.json({ data: await tenantsService.updateTenant(body) });
});

tenantRouter.get('/subscription', requirePermission('subscription:read'), async (_req, res) => {
  res.json({ data: await tenantsService.getSubscription() });
});
