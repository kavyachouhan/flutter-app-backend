import { Router } from 'express';
import { env } from '../../config/env.js';
import { getContext } from '../../lib/context.js';
import { signDownload, signUpload } from '../../lib/storage.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { validate, validated } from '../../middleware/validate.js';
import { downloadUrlQuery, signUploadBody } from './uploads.schemas.js';

export const uploadsRouter: Router = Router();

/**
 * No `requirePermission`: holding a valid session is the bar.
 *
 * Every role that can do anything at all needs to attach something — a
 * cashier photographs an expense receipt, an owner uploads a logo — and the
 * object is useless until it is referenced by a record whose own write is
 * permission-checked. Gating the signing step as well would mean maintaining
 * a second, parallel permission model for files.
 *
 * The real controls are the tenant-prefixed key, the per-kind content-type
 * and size policy in src/lib/storage.ts, and this limiter.
 */
const signLimiter = rateLimit({
  name: 'upload-sign',
  points: env.RATE_LIMIT_UPLOAD_SIGN_POINTS,
  windowSeconds: env.RATE_LIMIT_UPLOAD_SIGN_WINDOW_SECONDS,
  key: () => getContext()?.tenantId,
});

const sign = { body: signUploadBody };
uploadsRouter.post('/sign', signLimiter, validate(sign), async (req, res) => {
  const { body } = validated<typeof sign>(req);
  res.status(201).json({
    data: await signUpload(body.kind, body.contentType, body.sizeBytes),
  });
});

const url = { query: downloadUrlQuery };
uploadsRouter.get('/url', signLimiter, validate(url), async (req, res) => {
  const { query } = validated<typeof url>(req);
  res.json({ data: await signDownload(query.key) });
});
