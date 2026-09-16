import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  generateRefreshToken,
  hashRefreshToken,
  signAccessToken,
  signIdentityToken,
  verifyAccessToken,
  verifyIdentityToken,
} from './tokens.js';
import { ErrorCode } from '../../lib/errors.js';

const claims = {
  userId: randomUUID(),
  tenantId: randomUUID(),
  role: 'cashier' as const,
  outletIds: [randomUUID()],
  deviceId: randomUUID(),
};

describe('tokens', () => {
  it('round-trips access token claims', async () => {
    const { token } = await signAccessToken(claims);
    await expect(verifyAccessToken(token)).resolves.toEqual(claims);
  });

  it('refuses an identity token where an access token is required, and vice versa', async () => {
    const identity = await signIdentityToken(claims.userId);
    const access = await signAccessToken(claims);
    await expect(verifyAccessToken(identity.token)).rejects.toMatchObject({
      code: ErrorCode.TOKEN_INVALID,
    });
    await expect(verifyIdentityToken(access.token)).rejects.toMatchObject({
      code: ErrorCode.TOKEN_INVALID,
    });
    await expect(verifyIdentityToken(identity.token)).resolves.toEqual({ userId: claims.userId });
  });

  it('rejects a tampered token', async () => {
    const { token } = await signAccessToken(claims);
    const [header, payload, signature] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload ?? '', 'base64url').toString()),
        role: 'owner',
      }),
    ).toString('base64url');
    await expect(verifyAccessToken(`${header}.${forged}.${signature}`)).rejects.toMatchObject({
      code: ErrorCode.TOKEN_INVALID,
    });
  });

  it('generates unique refresh tokens with a stable hash', () => {
    const a = generateRefreshToken();
    expect(a).not.toBe(generateRefreshToken());
    expect(hashRefreshToken(a)).toBe(hashRefreshToken(a));
    expect(hashRefreshToken(a)).not.toContain(a);
  });
});
