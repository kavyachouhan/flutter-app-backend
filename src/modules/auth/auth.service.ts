import { env } from '../../config/env.js';
import {
  withReadTransaction,
  withTransaction,
  withUnscopedTransaction,
  type Tx,
} from '../../db/tx.js';
import { requireAuthContext } from '../../lib/context.js';
import { AuthError, ErrorCode, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { createLogger } from '../../lib/logger.js';
import { devicesRepository } from '../devices/devices.repository.js';
import { authRepository, type LoginMembership } from './auth.repository.js';
import type { DevLoginBody, DeviceInput } from './auth.schemas.js';
import { issueOtp, verifyOtp } from './otp.js';
import { permissionsFor } from './permissions.js';
import { normalizePhone } from './phone.js';
import {
  generateRefreshToken,
  hashRefreshToken,
  signAccessToken,
  signIdentityToken,
} from './tokens.js';

const log = createLogger('auth');

export interface Session {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  userId: string;
  tenantId: string;
  role: LoginMembership['role'];
  outletIds: string[] | null;
  deviceId: string;
}

export interface Identity {
  identityToken: string;
  identityTokenExpiresAt: string;
  userId: string;
  tenants: LoginMembership[];
}

export function requestOtp(phoneInput: string) {
  return issueOtp(normalizePhone(phoneInput));
}

async function identify(phone: string, name: string | null): Promise<Identity> {
  const { userId, tenants } = await withUnscopedTransaction(async (tx) => {
    const user = await authRepository.ensureUser(tx, { id: newId(), phone, name });
    if (!user.isActive) {
      throw new ForbiddenError('This account has been disabled.', ErrorCode.ACCOUNT_DISABLED);
    }
    await authRepository.recordLogin(tx, user.userId);
    return { userId: user.userId, tenants: await authRepository.findMemberships(tx, user.userId) };
  });

  const identity = await signIdentityToken(userId);
  return {
    identityToken: identity.token,
    identityTokenExpiresAt: identity.expiresAt.toISOString(),
    userId,
    tenants,
  };
}

export async function verifyOtpAndIdentify(phoneInput: string, code: string): Promise<Identity> {
  const phone = normalizePhone(phoneInput);
  await verifyOtp(phone, code);
  return identify(phone, null);
}

export function listTenantsForUser(userId: string): Promise<LoginMembership[]> {
  return withUnscopedTransaction((tx) => authRepository.findMemberships(tx, userId));
}

async function issueSession(
  tx: Tx,
  membership: LoginMembership,
  userId: string,
  deviceId: string,
  refreshTokenId: string,
): Promise<Session> {
  const refreshToken = generateRefreshToken();
  const refreshExpiresAt = await authRepository.insertRefreshToken(tx, {
    id: refreshTokenId,
    userId,
    deviceId,
    tokenHash: hashRefreshToken(refreshToken),
    ttlDays: env.REFRESH_TOKEN_TTL_DAYS,
  });
  const access = await signAccessToken({
    userId,
    tenantId: membership.tenantId,
    role: membership.role,
    outletIds: membership.outletIds,
    deviceId,
  });

  return {
    accessToken: access.token,
    accessTokenExpiresAt: access.expiresAt.toISOString(),
    refreshToken,
    refreshTokenExpiresAt: refreshExpiresAt.toISOString(),
    userId,
    tenantId: membership.tenantId,
    role: membership.role,
    outletIds: membership.outletIds,
    deviceId,
  };
}

export async function createSession(
  userId: string,
  input: { tenantId: string; device: DeviceInput },
): Promise<Session> {
  const membership = (await listTenantsForUser(userId)).find((m) => m.tenantId === input.tenantId);
  if (!membership) throw new NotFoundError('Tenant');

  return withTransaction(
    async (tx) => {
      const device = await devicesRepository.upsertForSession(tx, {
        id: newId(),
        userId,
        device: input.device,
      });
      if (!device.isActive) {
        throw new ForbiddenError('This device has been deactivated.', ErrorCode.ACCOUNT_DISABLED);
      }
      return issueSession(tx, membership, userId, device.id, newId());
    },
    { tenantId: input.tenantId, retries: 0 },
  );
}

/**
 * Rotating refresh with reuse detection. A token presented after it was
 * rotated was copied, so the device's whole session is revoked — unless it
 * arrives within the grace window, which is a client retrying over a flaky
 * connection rather than theft.
 */
export async function refreshSession(refreshToken: string): Promise<Session> {
  const invalid = () => new AuthError('The refresh token is invalid.', ErrorCode.TOKEN_INVALID);
  const record = await withUnscopedTransaction((tx) =>
    authRepository.findRefreshToken(tx, hashRefreshToken(refreshToken)),
  );
  if (!record) throw invalid();

  if (record.revokedAt) {
    const secondsSinceRevoked = (Date.now() - record.revokedAt.getTime()) / 1000;
    if (record.replacedBy && secondsSinceRevoked > env.REFRESH_TOKEN_REUSE_GRACE_SECONDS) {
      await withTransaction(
        (tx) => authRepository.revokeForDevice(tx, record.deviceId, 'reuse_detected'),
        {
          tenantId: record.tenantId,
        },
      );
      log.warn(
        { tenantId: record.tenantId, deviceId: record.deviceId },
        'Refresh token reuse detected',
      );
    }
    throw invalid();
  }
  if (record.expiresAt <= new Date()) {
    throw new AuthError('The refresh token has expired.', ErrorCode.TOKEN_EXPIRED);
  }

  // Re-read the membership so role, outlet and deactivation changes apply now.
  const membership = (await listTenantsForUser(record.userId)).find(
    (m) => m.tenantId === record.tenantId,
  );

  return withTransaction(
    async (tx) => {
      if (!membership) {
        await authRepository.revokeForUser(tx, record.userId, 'membership_removed');
        throw invalid();
      }
      const device = await devicesRepository.findById(tx, record.deviceId);
      if (!device?.isActive) throw invalid();

      const nextId = newId();
      const session = await issueSession(tx, membership, record.userId, record.deviceId, nextId);
      if (!(await authRepository.rotateRefreshToken(tx, record.id, nextId))) throw invalid();
      return session;
    },
    { tenantId: record.tenantId, retries: 0 },
  );
}

export async function logout(allDevices: boolean): Promise<void> {
  const auth = requireAuthContext();
  await withTransaction((tx) =>
    allDevices
      ? authRepository.revokeForUser(tx, auth.userId, 'logout_all')
      : authRepository.revokeForDevice(tx, auth.deviceId, 'logout'),
  );
}

export async function getMe() {
  const auth = requireAuthContext();
  const user = await withReadTransaction((tx) => authRepository.findUserProfile(tx, auth.userId));
  if (!user) throw new NotFoundError('User');
  return {
    user,
    tenantId: auth.tenantId,
    role: auth.role,
    outletIds: auth.outletIds,
    deviceId: auth.deviceId,
    permissions: permissionsFor(auth.role),
  };
}

export async function devLogin(
  input: DevLoginBody,
): Promise<{ identity: Identity; session?: Session }> {
  const identity = await identify(normalizePhone(input.phone), input.name ?? null);
  if (!input.tenantId || !input.device) return { identity };
  return {
    identity,
    session: await createSession(identity.userId, {
      tenantId: input.tenantId,
      device: input.device,
    }),
  };
}
