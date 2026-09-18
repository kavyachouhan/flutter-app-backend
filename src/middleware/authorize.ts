import type { RequestHandler } from 'express';
import { requireAuthContext } from '../lib/context.js';
import { ErrorCode, ForbiddenError } from '../lib/errors.js';
import { hasPermission, type Permission } from '../modules/auth/permissions.js';

export function requirePermission(permission: Permission): RequestHandler {
  return (_req, _res, next) => {
    const { role } = requireAuthContext();
    if (!hasPermission(role, permission)) {
      next(
        new ForbiddenError(undefined, ErrorCode.INSUFFICIENT_ROLE, {
          details: { required: permission },
        }),
      );
      return;
    }
    next();
  };
}

/** Members scoped to specific outlets cannot act on the others. */
export function assertOutletAccess(outletId: string): void {
  const { outletIds } = requireAuthContext();
  if (outletIds !== null && !outletIds.includes(outletId)) {
    throw new ForbiddenError(
      'You do not have access to this outlet.',
      ErrorCode.OUTLET_NOT_PERMITTED,
    );
  }
}

/** null means unrestricted. */
export function accessibleOutletIds(): readonly string[] | null {
  return requireAuthContext().outletIds;
}
