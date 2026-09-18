import { withReadTransaction, withTransaction, type Tx } from '../../db/tx.js';
import { requireAuthContext } from '../../lib/context.js';
import {
  ConflictError,
  ErrorCode,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
  ValidationError,
} from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { diffFields, recordAudit } from '../audit/audit.js';
import { authRepository } from '../auth/auth.repository.js';
import { canManageRole, type Role } from '../auth/permissions.js';
import { normalizePhone } from '../auth/phone.js';
import { assertQuota } from '../entitlements/entitlements.js';
import { membersRepository, type MemberRow } from './members.repository.js';
import type { AddMemberBody, UpdateMemberBody } from './members.schemas.js';

async function requireMember(tx: Tx, id: string, forUpdate = false): Promise<MemberRow> {
  const member = await membersRepository.findById(tx, id, forUpdate);
  if (!member) throw new NotFoundError('Member');
  return member;
}

function assertCanManage(target: Role): void {
  if (!canManageRole(requireAuthContext().role, target)) {
    throw new ForbiddenError(
      `You cannot manage members with the ${target} role.`,
      ErrorCode.INSUFFICIENT_ROLE,
    );
  }
}

async function assertOutletsExist(
  tx: Tx,
  outletIds: readonly string[] | null | undefined,
): Promise<void> {
  if (!outletIds) return;
  const unique = [...new Set(outletIds)];
  if ((await membersRepository.countExistingOutlets(tx, unique)) !== unique.length) {
    throw new ValidationError('One or more outlets do not exist.', {
      details: { fields: { outletIds: 'unknown outlet' } },
    });
  }
}

/** A business must always have an owner who can manage billing and staff. */
async function assertNotLastOwner(tx: Tx, member: MemberRow): Promise<void> {
  if (member.role !== 'owner' || !member.isActive) return;
  const owners = await membersRepository.lockActiveOwnerIds(tx);
  if (owners.length <= 1) {
    throw new UnprocessableError(
      'A business needs at least one active owner.',
      ErrorCode.LAST_OWNER,
    );
  }
}

export function listMembers() {
  return withReadTransaction((tx) => membersRepository.list(tx));
}

export function addMember(body: AddMemberBody) {
  assertCanManage(body.role);
  const phone = normalizePhone(body.phone);

  return withTransaction(async (tx) => {
    await assertOutletsExist(tx, body.outletIds);
    await assertQuota(tx, 'users');

    const user = await authRepository.ensureUser(tx, {
      id: newId(),
      phone,
      name: body.name ?? null,
    });
    if (await membersRepository.findByUser(tx, user.userId)) {
      throw new ConflictError('This person is already a member.', ErrorCode.DUPLICATE);
    }

    const id = newId();
    await membersRepository.insert(tx, {
      id,
      userId: user.userId,
      role: body.role,
      outletIds: body.outletIds,
    });
    await recordAudit(tx, {
      action: 'member.added',
      entityType: 'membership',
      entityId: id,
      metadata: { role: body.role, outletIds: body.outletIds },
    });
    return requireMember(tx, id);
  });
}

export function updateMember(id: string, patch: UpdateMemberBody) {
  return withTransaction(async (tx) => {
    const before = await requireMember(tx, id, true);
    assertCanManage(before.role);
    if (patch.role) assertCanManage(patch.role);
    await assertOutletsExist(tx, patch.outletIds);

    const losesOwnership =
      (patch.role !== undefined && patch.role !== 'owner') || patch.isActive === false;
    if (losesOwnership) await assertNotLastOwner(tx, before);

    if (patch.isActive === true && !before.isActive) await assertQuota(tx, 'users');

    await membersRepository.update(tx, id, patch);
    // Deactivation revokes sessions immediately; role and outlet changes apply
    // at the next refresh, which re-reads the membership.
    if (patch.isActive === false)
      await authRepository.revokeForUser(tx, before.userId, 'membership_deactivated');

    const changes = diffFields(before, patch);
    if (changes)
      await recordAudit(tx, {
        action: 'member.updated',
        entityType: 'membership',
        entityId: id,
        changes,
      });
    return requireMember(tx, id);
  });
}

export function removeMember(id: string) {
  return withTransaction(async (tx) => {
    const member = await requireMember(tx, id, true);
    assertCanManage(member.role);
    await assertNotLastOwner(tx, member);

    await membersRepository.softDelete(tx, id);
    await authRepository.revokeForUser(tx, member.userId, 'membership_removed');
    await recordAudit(tx, { action: 'member.removed', entityType: 'membership', entityId: id });
  });
}
