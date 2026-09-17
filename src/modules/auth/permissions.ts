/**
 * Role-based access control. Permissions are checked, never roles, so adding
 * a role is a change to this table and nowhere else.
 */

export const ROLES = ['owner', 'manager', 'cashier', 'accountant', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'tenant:read',
  'tenant:manage',
  'subscription:read',
  'members:read',
  'members:manage',
  'outlets:manage',
  'counters:manage',
  'devices:read',
  'devices:manage',
  'catalogue:read',
  'catalogue:write',
  'customers:read',
  'customers:write',
  'invoices:read',
  'invoices:create',
  'invoices:void',
  'payments:read',
  'payments:create',
  'payments:void',
  'credit_notes:read',
  'credit_notes:create',
  'credit_notes:void',
  'expenses:read',
  'expenses:write',
  'expenses:void',
  'day_close:read',
  'day_close:create',
  'stock:read',
  'stock:adjust',
  'numbering:read',
  'numbering:manage',
  'numbering:lease',
  'audit:read',
  // Pull the change stream / push offline operations. Each pushed operation
  // is additionally checked against its own permission (e.g. invoices:create).
  'sync:read',
  'sync:write',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const READ_ONLY: Permission[] = PERMISSIONS.filter((p) => p.endsWith(':read'));

const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  owner: new Set(PERMISSIONS),
  manager: new Set(PERMISSIONS.filter((p) => p !== 'tenant:manage')),
  cashier: new Set<Permission>([
    'tenant:read',
    'catalogue:read',
    'customers:read',
    'customers:write',
    'invoices:read',
    'invoices:create',
    'payments:read',
    'payments:create',
    'credit_notes:read',
    'credit_notes:create',
    // A cashier records the day's petty cash and counts their own drawer.
    'expenses:read',
    'expenses:write',
    'day_close:read',
    'day_close:create',
    'stock:read',
    'numbering:read',
    'numbering:lease',
    'sync:read',
    'sync:write',
  ]),
  accountant: new Set<Permission>([...READ_ONLY, 'audit:read']),
  viewer: new Set<Permission>(READ_ONLY.filter((p) => p !== 'audit:read')),
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

/** Sent to clients so they can hide actions the user cannot perform. */
export function permissionsFor(role: Role): Permission[] {
  return PERMISSIONS.filter((permission) => ROLE_PERMISSIONS[role].has(permission));
}

/**
 * Only an owner may create or modify an owner, so a manager cannot promote
 * themselves or lock the owner out of their own business.
 */
export function canManageRole(actor: Role, target: Role): boolean {
  if (target === 'owner') return actor === 'owner';
  return hasPermission(actor, 'members:manage');
}
