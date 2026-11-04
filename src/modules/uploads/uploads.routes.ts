import { Router } from 'express';
import { env } from '../../config/env.js';
import { getContext } from '../../lib/context.js';
import { signDownload, signUpload } from '../../lib/storage.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { validate, validated } from '../../middleware/validate.js';
import { assertKeyBelongsToTenant } from '../../lib/storage.js';
import { downloadUrlQuery, downloadUrlsBody, signUploadBody } from './uploads.schemas.js';

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

/**
 * Read URLs for many keys at once. A key that is not this business's is a 403
 * for the whole call, checked before anything is signed. A key whose object is
 * gone (deleted, or never finished uploading) comes back with `url: null` so one
 * missing photo does not blank a whole list.
 */
const urls = { body: downloadUrlsBody };
uploadsRouter.post('/urls', signLimiter, validate(urls), async (req, res) => {
  const { body } = validated<typeof urls>(req);
  const keys = [...new Set(body.keys)];
  for (const key of keys) assertKeyBelongsToTenant(key);

  const settled = await Promise.allSettled(keys.map((key) => signDownload(key)));
  res.json({
    data: keys.map((key, index) => {
      const result = settled[index];
      return result?.status === 'fulfilled'
        ? { key, url: result.value.url, expiresAt: result.value.expiresAt }
        : { key, url: null, expiresAt: null };
    }),
  });
});
