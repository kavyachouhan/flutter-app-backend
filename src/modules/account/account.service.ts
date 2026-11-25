/**
 * Deleting an account from inside the app — required by the App Store
 * (guideline 5.1.1(v)) and Google Play.
 *
 * Two kinds of request:
 *
 *   business  An owner closes the whole business. From this moment nobody can
 *             sign in to it or sync it: it is cancelled, every session is
 *             revoked, every device deactivated, every membership removed, and
 *             the members who belong to no other business are erased. The
 *             records themselves are deleted by the purge job
 *             (src/db/purge-deleted-accounts.ts) within PURGE_WITHIN_DAYS.
 *
 *   login     Anyone removes their own sign-in for this business. The business
 *             and its records carry on — they belong to the business, which may
 *             be legally required to keep them. If the person belongs to no
 *             other business, their name, email and phone number are erased.
 *
 * Both need a fresh one-time code sent to the person's own phone: a signed-in
 * phone left on the counter must not be enough to destroy a business.
 */
import { withReadTransaction, withTransaction } from '../../db/tx.js';
import { requireAuthContext } from '../../lib/context.js';
import { ErrorCode, ForbiddenError, NotFoundError, UnprocessableError } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { createLogger } from '../../lib/logger.js';
import { recordAudit } from '../audit/audit.js';
import { authRepository } from '../auth/auth.repository.js';
import { verifyOtp } from '../auth/otp.js';
import { revokeTenantAccess, revokeUserAccess } from '../auth/revocations.js';
import { membersRepository } from '../members/members.repository.js';
import { accountRepository } from './account.repository.js';
import type { AccountDeletionBody } from './account.schemas.js';

const log = createLogger('account');

/** What the Privacy Policy promises: deleted within this many days of the request. */
export const PURGE_WITHIN_DAYS = 30;

export interface AccountDeletionResult {
  scope: AccountDeletionBody['scope'];
  /** When the business's records will be gone by; null for a login, which is done now. */
  purgeDueAt: string | null;
}

export async function requestAccountDeletion(
  body: AccountDeletionBody,
): Promise<AccountDeletionResult> {
  const auth = requireAuthContext();

  const profile = await withReadTransaction((tx) =>
    authRepository.findUserProfile(tx, auth.userId),
  );
  if (!profile) throw new NotFoundError('User');
  // Throws on a wrong, expired or over-used code; attempts are counted.
  await verifyOtp(profile.phone, body.code);

  if (body.scope === 'business') {
    if (auth.role !== 'owner') {
      throw new ForbiddenError(
        'Only an owner can delete the business. You can delete your own sign-in instead.',
        ErrorCode.INSUFFICIENT_ROLE,
      );
    }
    return deleteBusiness(auth.tenantId, auth.userId);
  }
  return deleteLogin(auth.tenantId, auth.userId);
}

async function deleteBusiness(tenantId: string, userId: string): Promise<AccountDeletionResult> {
  const { purgeDueAt } = await withTransaction(async (tx) => {
    // Read before anything is removed: who belongs only to this business.
    const members = await accountRepository.memberUserIds(tx);
    const onlyHere: string[] = [];
    for (const memberId of members) {
      const elsewhere = (await authRepository.findMemberships(tx, memberId)).filter(
        (m) => m.tenantId !== tenantId,
      );
      if (elsewhere.length === 0) onlyHere.push(memberId);
    }

    await recordAudit(tx, {
      action: 'account.business_deletion_requested',
      entityType: 'tenant',
      entityId: tenantId,
      metadata: { members: members.length },
    });
    const recorded = await accountRepository.recordDeletion(tx, {
      id: newId(),
      tenantId,
      userId,
      scope: 'business',
      purgeWithinDays: PURGE_WITHIN_DAYS,
      purged: false,
    });

    // Users are erased while their membership still lets this business update them (users RLS).
    for (const memberId of onlyHere) await accountRepository.eraseUser(tx, memberId);
    await accountRepository.revokeAllSessions(tx, 'business_deleted');
    await accountRepository.deactivateAllDevices(tx);
    await accountRepository.removeAllMemberships(tx);
    await accountRepository.closeTenant(tx, tenantId);
    return recorded;
  });
  // After commit: a request racing the deletion must not be cut off for a
  // deletion that then rolled back. Access tokens already issued stop now,
  // not at their expiry.
  await revokeTenantAccess(tenantId);

  log.info({ tenantId }, 'Business deletion requested; data will be purged');
  return { scope: 'business', purgeDueAt: purgeDueAt.toISOString() };
}

async function deleteLogin(tenantId: string, userId: string): Promise<AccountDeletionResult> {
  await withTransaction(async (tx) => {
    const mine = (await authRepository.findMemberships(tx, userId)).find(
      (m) => m.tenantId === tenantId,
    );
    if (!mine) throw new NotFoundError('Membership');
    if (mine.role === 'owner') {
      // The same rule as removing an owner from the staff screen.
      const owners = await membersRepository.lockActiveOwnerIds(tx);
      if (owners.length <= 1) {
        throw new UnprocessableError(
          'You are the only owner. Delete the business instead, or make someone else an owner first.',
          ErrorCode.LAST_OWNER,
        );
      }
    }

    const elsewhere = (await authRepository.findMemberships(tx, userId)).filter(
      (m) => m.tenantId !== tenantId,
    );

    await recordAudit(tx, {
      action: 'account.login_deleted',
      entityType: 'user',
      entityId: userId,
    });
    await accountRepository.recordDeletion(tx, {
      id: newId(),
      tenantId,
      userId,
      scope: 'login',
      purgeWithinDays: 0,
      purged: true,
    });
    if (elsewhere.length === 0) await accountRepository.eraseUser(tx, userId);
    await authRepository.revokeForUser(tx, userId, 'login_deleted');
    await accountRepository.deactivateDevicesOf(tx, userId);
    await accountRepository.removeMembershipOf(tx, userId);
  });
  await revokeUserAccess(tenantId, userId);

  log.info({ tenantId }, 'Login deleted');
  return { scope: 'login', purgeDueAt: null };
}
