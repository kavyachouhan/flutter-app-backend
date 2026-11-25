import { z } from 'zod';
import { errorResponses } from '../../openapi/common.js';
import {
  accessTokenSecurity,
  dataEnvelope,
  jsonResponse,
  registry,
  timestamp,
} from '../../openapi/registry.js';
import { accountDeletionBody } from './account.schemas.js';

registry.registerPath({
  method: 'post',
  path: '/v1/account/deletion',
  tags: ['Account'],
  summary: 'Delete the business, or your own sign-in',
  description: [
    'What the in-app "Delete account" screen calls. First send a code to your own number with',
    '`POST /v1/auth/otp/request`, then send that code here.',
    '',
    '- `business` (owners only): the business is closed at once — every session revoked, every device',
    '  deactivated, every membership removed — and its records are purged within 30 days.',
    '- `login`: removes only your sign-in for this business. Refused with `LAST_OWNER` if you are its',
    '  only owner.',
    '',
    'Either way, if you belong to no other business, your name, email and phone number are erased now.',
  ].join('\n'),
  security: accessTokenSecurity,
  request: { body: { content: { 'application/json': { schema: accountDeletionBody } } } },
  responses: {
    200: jsonResponse(
      'Done. Sign out and remove the local copy.',
      dataEnvelope(
        z.object({
          scope: z.enum(['business', 'login']),
          purgeDueAt: timestamp.nullable().openapi({
            description: "When the business's records will be gone by; null for a login.",
          }),
        }),
      ),
    ),
    ...errorResponses(401, 403, 422),
  },
});
