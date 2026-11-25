import type { Request, RequestHandler } from 'express';
import { enrichContext, getContext } from '../lib/context.js';
import { AuthError, ErrorCode } from '../lib/errors.js';
import { isAccessRevoked } from '../modules/auth/revocations.js';
import { verifyAccessToken, verifyIdentityToken } from '../modules/auth/tokens.js';

function bearerToken(req: Request): string {
  const match = /^Bearer\s+(\S+)$/i.exec(req.header('authorization') ?? '');
  if (!match?.[1]) throw new AuthError();
  return match[1];
}

/**
 * Stateless: role and outlet changes, and device deactivation, take effect at
 * the next refresh, so staleness is bounded by ACCESS_TOKEN_TTL_SECONDS. That
 * trade avoids a database read on every request from every till.
 *
 * The exception is a deleted business or a deleted sign-in, which must stop
 * at once: those leave a Redis mark (modules/auth/revocations.ts) checked here.
 * TOKEN_INVALID makes the app sign out rather than try a refresh.
 */
export function requireAccessToken(): RequestHandler {
  return async (req, _res, next) => {
    const claims = await verifyAccessToken(bearerToken(req));
    if (await isAccessRevoked(claims.tenantId, claims.userId)) {
      throw new AuthError('This account was deleted.', ErrorCode.TOKEN_INVALID);
    }
    enrichContext({
      tenantId: claims.tenantId,
      userId: claims.userId,
      role: claims.role,
      outletIds: claims.outletIds,
      deviceId: claims.deviceId,
    });
    next();
  };
}

/** For the post-OTP steps that happen before a tenant is chosen. */
export function requireIdentityToken(): RequestHandler {
  return async (req, _res, next) => {
    const { userId } = await verifyIdentityToken(bearerToken(req));
    enrichContext({ userId });
    next();
  };
}

export function identityUserId(): string {
  const userId = getContext()?.userId;
  if (!userId) throw new Error('Identity route reached without requireIdentityToken().');
  return userId;
}
