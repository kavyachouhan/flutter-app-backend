import { Router } from 'express';
import { env } from './config/env.js';
import { getContext } from './lib/context.js';
import { requireAccessToken, requireIdentityToken } from './middleware/authenticate.js';
import { rateLimit } from './middleware/rate-limit.js';
import { auditRouter } from './modules/audit/audit.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { devAuthRouter } from './modules/auth/dev.routes.js';
import { catalogueRouter } from './modules/catalogue/catalogue.routes.js';
import { customersRouter } from './modules/customers/customers.routes.js';
import { devicesRouter } from './modules/devices/devices.routes.js';
import { invoicesRouter } from './modules/invoices/invoices.routes.js';
import { membersRouter } from './modules/members/members.routes.js';
import { numberingRouter } from './modules/numbering/numbering.routes.js';
import { outletsRouter } from './modules/outlets/outlets.routes.js';
import { paymentsRouter } from './modules/payments/payments.routes.js';
import { stockRouter } from './modules/stock/stock.routes.js';
import { onboardingRouter, tenantRouter } from './modules/tenants/tenants.routes.js';
import { createOpenApiRouter } from './openapi/routes.js';

export function createV1Router(): Router {
  const router = Router();

  // Before auth: the spec and its UI carry no tenant data.
  if (env.OPENAPI_ENABLED) router.use(createOpenApiRouter());

  router.use('/auth', authRouter);

  // In production the dev-login handler is never attached to any path, in
  // addition to env.ts refusing to boot with the bypass enabled.
  if (env.isDevelopment && env.AUTH_DEV_BYPASS) {
    router.use('/auth', devAuthRouter);
  }

  router.use('/onboarding', requireIdentityToken(), onboardingRouter);

  const tenantScoped = Router();
  tenantScoped.use(
    requireAccessToken(),
    rateLimit({
      name: 'api',
      points: env.RATE_LIMIT_API_POINTS,
      windowSeconds: env.RATE_LIMIT_API_WINDOW_SECONDS,
      // Per tenant, so one busy shop cannot exhaust another's allowance.
      key: () => getContext()?.tenantId,
    }),
  );
  tenantScoped.use('/tenant', tenantRouter);
  tenantScoped.use('/members', membersRouter);
  tenantScoped.use('/devices', devicesRouter);
  tenantScoped.use(outletsRouter);
  tenantScoped.use(catalogueRouter);
  tenantScoped.use('/customers', customersRouter);
  tenantScoped.use('/numbering', numberingRouter);
  tenantScoped.use('/invoices', invoicesRouter);
  tenantScoped.use('/payments', paymentsRouter);
  tenantScoped.use('/stock', stockRouter);
  tenantScoped.use('/audit', auditRouter);

  router.use(tenantScoped);
  return router;
}
