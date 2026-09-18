/**
 * DEVELOPMENT ONLY. Mounted by v1-router.ts only when APP_ENV=development and
 * AUTH_DEV_BYPASS=true; env.ts refuses to boot production with the bypass on.
 * In production this router is never attached to a path at all.
 */
import { Router } from 'express';
import { validate, validated } from '../../middleware/validate.js';
import { devLoginBody } from './auth.schemas.js';
import { devLogin } from './auth.service.js';

export const devAuthRouter: Router = Router();

const schemas = { body: devLoginBody };
devAuthRouter.post('/dev-login', validate(schemas), async (req, res) => {
  const { body } = validated<typeof schemas>(req);
  res.json({ data: await devLogin(body) });
});
