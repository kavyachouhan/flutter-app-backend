import { z } from 'zod';
import { errorResponses } from '../../openapi/common.js';
import {
  accessTokenSecurity,
  dataEnvelope,
  identityTokenSecurity,
  jsonResponse,
  registry,
  timestamp,
  uuid,
} from '../../openapi/registry.js';
import { loginMembershipSchema, sessionSchema } from '../auth/auth.openapi.js';
import { createTenantBody, updateTenantBody } from './tenants.schemas.js';

export const tenantSchema = registry.register(
  'Tenant',
  z.object({
    id: uuid,
    name: z.string(),
    legalName: z.string().nullable(),
    isGstRegistered: z.boolean(),
    gstin: z.string().nullable(),
    isComposition: z.boolean(),
    pan: z.string().nullable(),
    stateCode: z.string(),
    addressLine1: z.string().nullable(),
    addressLine2: z.string().nullable(),
    city: z.string().nullable(),
    pincode: z.string().nullable(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
    locale: z.string(),
    timezone: z.string(),
    currencyCode: z.string(),
    currencySymbol: z.string(),
    fyStartMonth: z.number().int(),
    allowNegativeStock: z.boolean(),
    defaultPricesIncludeTax: z.boolean(),
    status: z.string(),
    createdAt: timestamp,
    updatedAt: timestamp,
  }),
);

export const subscriptionSchema = registry.register(
  'Subscription',
  z.object({
    plan: z.string(),
    status: z.string(),
    maxUsers: z.number().int().nullable(),
    maxOutlets: z.number().int().nullable(),
    maxCounters: z.number().int().nullable(),
    maxItems: z.number().int().nullable(),
    features: z.record(z.unknown()).openapi({
      description:
        'Feature grants: key → true/false. Wildcards `group.*` and `*` are honoured; an explicit false wins.',
    }),
    trialEndsAt: timestamp.nullable(),
    currentPeriodEnd: timestamp.nullable(),
    usage: z.object({
      users: z.number().int(),
      outlets: z.number().int(),
      counters: z.number().int(),
      items: z.number().int(),
    }),
  }),
);

registry.registerPath({
  method: 'get',
  path: '/v1/onboarding/tenants',
  tags: ['Onboarding'],
  summary: 'Businesses this phone belongs to',
  security: identityTokenSecurity,
  responses: {
    200: jsonResponse('Memberships.', dataEnvelope(z.array(loginMembershipSchema))),
    ...errorResponses(),
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/onboarding/tenants',
  tags: ['Onboarding'],
  summary: 'Create a business',
  description:
    'Creates the tenant, its free subscription, the first outlet and counter, makes the caller owner, and opens a session on the given device.',
  security: identityTokenSecurity,
  request: { body: { content: { 'application/json': { schema: createTenantBody } } } },
  responses: {
    201: jsonResponse(
      'Created.',
      dataEnvelope(z.object({ tenant: tenantSchema, session: sessionSchema })),
    ),
    ...errorResponses(409),
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/tenant',
  tags: ['Tenant'],
  summary: 'Current business profile',
  security: accessTokenSecurity,
  responses: { 200: jsonResponse('Tenant.', dataEnvelope(tenantSchema)), ...errorResponses() },
});

registry.registerPath({
  method: 'patch',
  path: '/v1/tenant',
  tags: ['Tenant'],
  summary: 'Update the business profile',
  security: accessTokenSecurity,
  request: { body: { content: { 'application/json': { schema: updateTenantBody } } } },
  responses: { 200: jsonResponse('Updated.', dataEnvelope(tenantSchema)), ...errorResponses() },
});

registry.registerPath({
  method: 'get',
  path: '/v1/tenant/subscription',
  tags: ['Tenant'],
  summary: 'Plan, quotas, feature grants and live usage',
  security: accessTokenSecurity,
  responses: {
    200: jsonResponse('Subscription.', dataEnvelope(subscriptionSchema)),
    ...errorResponses(),
  },
});
