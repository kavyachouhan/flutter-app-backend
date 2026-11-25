import { Router } from 'express';
import { env } from '../../config/env.js';
import { getContext } from '../../lib/context.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { validate, validated } from '../../middleware/validate.js';
import { accountDeletionBody } from './account.schemas.js';
import * as accountService from './account.service.js';

export const accountRouter: Router = Router();

const deletion = { body: accountDeletionBody };

/**
 * No permission check beyond being signed in: anyone may delete their own
 * sign-in, and the service allows only an owner to delete the business.
 * Rate-limited like code verification, since it verifies a code.
 */
accountRouter.post(
  '/deletion',
  rateLimit({
    name: 'account-deletion-user',
    points: env.RATE_LIMIT_OTP_VERIFY_POINTS,
    windowSeconds: env.RATE_LIMIT_OTP_VERIFY_WINDOW_SECONDS,
    key: () => getContext()?.userId,
  }),
  validate(deletion),
  async (req, res) => {
    const { body } = validated<typeof deletion>(req);
    res.json({ data: await accountService.requestAccountDeletion(body) });
  },
);
