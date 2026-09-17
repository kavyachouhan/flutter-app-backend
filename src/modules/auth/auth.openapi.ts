import { z } from 'zod';
import { env } from '../../config/env.js';
import {
  errorResponses,
  permissionSchema,
  platformSchema,
  roleSchema,
} from '../../openapi/common.js';
import {
  accessTokenSecurity,
  dataEnvelope,
  identityTokenSecurity,
  jsonResponse,
  noContent,
  registry,
  timestamp,
  uuid,
} from '../../openapi/registry.js';
import {
  createSessionBody,
  devLoginBody,
  logoutBody,
  otpRequestBody,
  otpVerifyBody,
  refreshBody,
} from './auth.schemas.js';

export const otpIssuedSchema = registry.register(
  'OtpIssued',
  z.object({
    channel: z.enum(['sms', 'whatsapp', 'voice']),
    maskedDestination: z.string().openapi({ example: '+••••••••3210' }),
    expiresInSeconds: z.number().int(),
    resendAfterSeconds: z.number().int(),
  }),
);

export const loginMembershipSchema = registry.register(
  'LoginMembership',
  z.object({
    tenantId: uuid,
    tenantName: z.string(),
    role: roleSchema,
    outletIds: z.array(uuid).nullable().openapi({ description: 'null = every outlet.' }),
  }),
);

export const identitySchema = registry.register(
  'Identity',
  z.object({
    identityToken: z.string(),
    identityTokenExpiresAt: timestamp,
    userId: uuid,
    tenants: z.array(loginMembershipSchema),
  }),
);

export const sessionSchema = registry.register(
  'Session',
  z.object({
    accessToken: z.string(),
    accessTokenExpiresAt: timestamp,
    refreshToken: z.string(),
    refreshTokenExpiresAt: timestamp,
    userId: uuid,
    tenantId: uuid,
    role: roleSchema,
    outletIds: z.array(uuid).nullable(),
    deviceId: uuid,
  }),
);

export const userProfileSchema = registry.register(
  'UserProfile',
  z.object({
    id: uuid,
    phone: z.string(),
    name: z.string().nullable(),
    email: z.string().nullable(),
    locale: z.string().nullable(),
  }),
);

export const meSchema = registry.register(
  'Me',
  z.object({
    user: userProfileSchema,
    tenantId: uuid,
    role: roleSchema,
    outletIds: z.array(uuid).nullable(),
    deviceId: uuid,
    permissions: z.array(permissionSchema),
  }),
);

registry.register('DeviceInput', createSessionBody.shape.device);
void platformSchema;

registry.registerPath({
  method: 'post',
  path: '/v1/auth/otp/request',
  tags: ['Auth'],
  summary: 'Send a one-time code',
  description:
    'Rate limited per IP and per phone. The response says which channel carried the code so the app never assumes SMS.',
  request: { body: { content: { 'application/json': { schema: otpRequestBody } } } },
  responses: {
    202: jsonResponse('Code sent.', dataEnvelope(otpIssuedSchema)),
    ...errorResponses(422),
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/auth/otp/verify',
  tags: ['Auth'],
  summary: 'Verify the code',
  description: 'Returns an identity token and the businesses this phone belongs to.',
  request: { body: { content: { 'application/json': { schema: otpVerifyBody } } } },
  responses: { 200: jsonResponse('Verified.', dataEnvelope(identitySchema)), ...errorResponses() },
});

registry.registerPath({
  method: 'post',
  path: '/v1/auth/sessions',
  tags: ['Auth'],
  summary: 'Open a session in a business',
  description: 'Registers (or re-attaches) the device and returns access + refresh tokens.',
  security: identityTokenSecurity,
  request: { body: { content: { 'application/json': { schema: createSessionBody } } } },
  responses: {
    201: jsonResponse('Session opened.', dataEnvelope(sessionSchema)),
    ...errorResponses(),
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/auth/refresh',
  tags: ['Auth'],
  summary: 'Rotate the refresh token',
  description:
    'Presenting an already-rotated token outside the reuse grace window revokes the device session.',
  request: { body: { content: { 'application/json': { schema: refreshBody } } } },
  responses: { 200: jsonResponse('Rotated.', dataEnvelope(sessionSchema)), ...errorResponses() },
});

registry.registerPath({
  method: 'post',
  path: '/v1/auth/logout',
  tags: ['Auth'],
  summary: 'Revoke this device, or every device',
  security: accessTokenSecurity,
  request: { body: { content: { 'application/json': { schema: logoutBody } } } },
  responses: { 204: noContent('Revoked.'), ...errorResponses() },
});

registry.registerPath({
  method: 'get',
  path: '/v1/auth/me',
  tags: ['Auth'],
  summary: 'Who am I in this business',
  security: accessTokenSecurity,
  responses: {
    200: jsonResponse('Profile, role and permissions.', dataEnvelope(meSchema)),
    ...errorResponses(),
  },
});

if (env.isDevelopment && env.AUTH_DEV_BYPASS) {
  registry.registerPath({
    method: 'post',
    path: '/v1/auth/dev-login',
    tags: ['Development'],
    summary: 'Sign in without an OTP (development only)',
    request: { body: { content: { 'application/json': { schema: devLoginBody } } } },
    responses: {
      200: jsonResponse(
        'Identity, plus a session when tenantId and device are given.',
        dataEnvelope(z.object({ identity: identitySchema, session: sessionSchema.optional() })),
      ),
      ...errorResponses(),
    },
  });
}
