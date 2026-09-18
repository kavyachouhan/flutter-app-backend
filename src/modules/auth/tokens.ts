import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { SignJWT, errors as joseErrors, jwtVerify, type JWTPayload } from 'jose';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { AuthError, ErrorCode } from '../../lib/errors.js';
import { ROLES, type Role } from './permissions.js';

const ALGORITHM = 'HS256';
const secret = new TextEncoder().encode(env.JWT_SECRET);

export interface AccessTokenClaims {
  userId: string;
  tenantId: string;
  role: Role;
  outletIds: string[] | null;
  deviceId: string;
}

// `typ` stops an identity token — issued after OTP, before a tenant is chosen —
// from being replayed where an access token is required.
const accessPayload = z.object({
  typ: z.literal('access'),
  sub: z.string().uuid(),
  tid: z.string().uuid(),
  role: z.enum(ROLES),
  oids: z.array(z.string().uuid()).nullable(),
  did: z.string().uuid(),
});

const identityPayload = z.object({
  typ: z.literal('identity'),
  sub: z.string().uuid(),
});

export interface SignedToken {
  token: string;
  expiresAt: Date;
}

async function sign(
  claims: Record<string, unknown>,
  subject: string,
  ttlSeconds: number,
): Promise<SignedToken> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + ttlSeconds;
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: ALGORITHM })
    .setSubject(subject)
    .setIssuer(env.JWT_ISSUER)
    .setAudience(env.JWT_AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .setJti(randomUUID())
    .sign(secret);
  return { token, expiresAt: new Date(expiresAt * 1000) };
}

async function verify(token: string): Promise<JWTPayload> {
  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      algorithms: [ALGORITHM],
    });
    return payload;
  } catch (error) {
    if (error instanceof joseErrors.JWTExpired) {
      throw new AuthError('The token has expired.', ErrorCode.TOKEN_EXPIRED);
    }
    throw new AuthError('The token is invalid.', ErrorCode.TOKEN_INVALID);
  }
}

export function signAccessToken(claims: AccessTokenClaims): Promise<SignedToken> {
  return sign(
    {
      typ: 'access',
      tid: claims.tenantId,
      role: claims.role,
      oids: claims.outletIds,
      did: claims.deviceId,
    },
    claims.userId,
    env.ACCESS_TOKEN_TTL_SECONDS,
  );
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  const parsed = accessPayload.safeParse(await verify(token));
  if (!parsed.success) throw new AuthError('The token is invalid.', ErrorCode.TOKEN_INVALID);
  const { sub, tid, role, oids, did } = parsed.data;
  return { userId: sub, tenantId: tid, role, outletIds: oids, deviceId: did };
}

export function signIdentityToken(userId: string): Promise<SignedToken> {
  return sign({ typ: 'identity' }, userId, env.IDENTITY_TOKEN_TTL_SECONDS);
}

export async function verifyIdentityToken(token: string): Promise<{ userId: string }> {
  const parsed = identityPayload.safeParse(await verify(token));
  if (!parsed.success) throw new AuthError('The token is invalid.', ErrorCode.TOKEN_INVALID);
  return { userId: parsed.data.sub };
}

export function generateRefreshToken(): string {
  return randomBytes(env.REFRESH_TOKEN_BYTES).toString('base64url');
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
