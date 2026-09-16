import { Router, type Request } from 'express';
import { env } from '../../config/env.js';
import {
  identityUserId,
  requireAccessToken,
  requireIdentityToken,
} from '../../middleware/authenticate.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { validate, validated } from '../../middleware/validate.js';
import * as authService from './auth.service.js';
import {
  createSessionBody,
  logoutBody,
  otpRequestBody,
  otpVerifyBody,
  refreshBody,
} from './auth.schemas.js';
import { normalizePhone } from './phone.js';

const byIp = (req: Request) => req.ip;

// Keyed on the normalised number, otherwise "+91 98…" and "98…" would be
// separate buckets and formatting variations would multiply the allowance.
const byPhone = (req: Request): string | undefined => {
  const phone: unknown = (req.body as { phone?: unknown } | undefined)?.phone;
  if (typeof phone !== 'string') return undefined;
  try {
    return normalizePhone(phone);
  } catch {
    return phone;
  }
};

export const authRouter: Router = Router();

const otpRequest = { body: otpRequestBody };
authRouter.post(
  '/otp/request',
  rateLimit({
    name: 'otp-request-ip',
    points: env.RATE_LIMIT_OTP_REQUEST_POINTS,
    windowSeconds: env.RATE_LIMIT_OTP_REQUEST_WINDOW_SECONDS,
    key: byIp,
  }),
  rateLimit({
    name: 'otp-request-phone',
    points: env.RATE_LIMIT_OTP_REQUEST_POINTS,
    windowSeconds: env.RATE_LIMIT_OTP_REQUEST_WINDOW_SECONDS,
    key: byPhone,
  }),
  validate(otpRequest),
  async (req, res) => {
    const { body } = validated<typeof otpRequest>(req);
    res.status(202).json({ data: await authService.requestOtp(body.phone) });
  },
);

const otpVerify = { body: otpVerifyBody };
authRouter.post(
  '/otp/verify',
  rateLimit({
    name: 'otp-verify-ip',
    points: env.RATE_LIMIT_OTP_VERIFY_POINTS,
    windowSeconds: env.RATE_LIMIT_OTP_VERIFY_WINDOW_SECONDS,
    key: byIp,
  }),
  rateLimit({
    name: 'otp-verify-phone',
    points: env.RATE_LIMIT_OTP_VERIFY_POINTS,
    windowSeconds: env.RATE_LIMIT_OTP_VERIFY_WINDOW_SECONDS,
    key: byPhone,
  }),
  validate(otpVerify),
  async (req, res) => {
    const { body } = validated<typeof otpVerify>(req);
    res.json({ data: await authService.verifyOtpAndIdentify(body.phone, body.code) });
  },
);

const createSession = { body: createSessionBody };
authRouter.post('/sessions', requireIdentityToken(), validate(createSession), async (req, res) => {
  const { body } = validated<typeof createSession>(req);
  res.status(201).json({ data: await authService.createSession(identityUserId(), body) });
});

const refresh = { body: refreshBody };
authRouter.post(
  '/refresh',
  rateLimit({
    name: 'refresh-ip',
    points: env.RATE_LIMIT_REFRESH_POINTS,
    windowSeconds: env.RATE_LIMIT_REFRESH_WINDOW_SECONDS,
    key: byIp,
  }),
  validate(refresh),
  async (req, res) => {
    const { body } = validated<typeof refresh>(req);
    res.json({ data: await authService.refreshSession(body.refreshToken) });
  },
);

const logout = { body: logoutBody };
authRouter.post('/logout', requireAccessToken(), validate(logout), async (req, res) => {
  const { body } = validated<typeof logout>(req);
  await authService.logout(body.allDevices ?? false);
  res.status(204).end();
});

authRouter.get('/me', requireAccessToken(), async (_req, res) => {
  res.json({ data: await authService.getMe() });
});
