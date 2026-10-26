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
  'suppliers:read',
  'suppliers:write',
  'terms:read',
  'terms:write',
  'purchases:read',
  'purchases:create',
  'purchases:void',
  'sales_orders:read',
  'sales_orders:create',
  'sales_orders:update',
  // Cancelling or closing an order refunds its advance, which is money out.
  'sales_orders:cancel',
  'sales_orders:delete',
  'debit_notes:read',
  'debit_notes:create',
  'debit_notes:void',
  'expenses:read',
  'expenses:write',
  'expenses:void',
  'day_close:read',
  'day_close:create',
  'stock:read',
  'stock:adjust',
  // Bulk import rewrites the price list wholesale, so it sits with the
  // owner/manager tier rather than with catalogue:write.
  'imports:read',
  'imports:write',
  'price_lists:read',
  // Changing a price list changes what every customer on it pays, and a bulk
  // revision does it across the catalogue, so this sits with the owner/manager
  // tier rather than with catalogue:write.
  'price_lists:write',
  'discount_policies:read',
  'discount_policies:manage',
  // Authorise a discount that breaches the policy. Held by whoever the shop
  // decides approves — the policy names the permission, so a shop can move it
  // without a code change.
  'discounts:approve',
  'gst:read',
  // Preparing and recording a return as filed. Separate from reports:financial
  // because a return is a declaration to the department, not a view of the
  // shop's own numbers — an accountant reads it, an owner files it.
  'gst:manage',
  'numbering:read',
  'numbering:manage',
  'numbering:lease',
  'audit:read',
  'reports:read',
  // Margin and profit. Withheld from cashiers, who can still run the day book.
  'reports:financial',
  // Pull the change stream / push offline operations. Each pushed operation
  // is additionally checked against its own permission (e.g. invoices:create).
  'sync:read',
  'sync:write',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const READ_ONLY: Permission[] = PERMISSIONS.filter((p) => p.endsWith(':read'));

const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  owner: new Set(PERMISSIONS),
  // A manager runs the shop day to day, so they can cancel or close an order (and
  // refund its advance), but editing or deleting a taken order is the owner's call.
  manager: new Set(
    PERMISSIONS.filter(
      (p) => p !== 'tenant:manage' && p !== 'sales_orders:update' && p !== 'sales_orders:delete',
    ),
  ),
  // No purchasing: a cashier who can enter a purchase bill can inflate stock
  // and create a payable, neither of which is a till function. They also do
  // not get suppliers:read, because the supplier ledger is what the shop
  // owes, not something a counter needs to see.
  cashier: new Set<Permission>([
    'tenant:read',
    'catalogue:read',
    'customers:read',
    'customers:write',
    // A cashier picks a saved T&C at the till; managing the list is withheld.
    'terms:read',
    'invoices:read',
    'invoices:create',
    // Takes orders and advances at the counter; changing or deleting one is
    // withheld because that reverses a payment.
    'sales_orders:read',
    'sales_orders:create',
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
    // Needed to price a customer correctly at the till. Writing a list and
    // approving a breach are both withheld — that is the point of the cap.
    'price_lists:read',
    'discount_policies:read',
    'numbering:read',
    'numbering:lease',
    'sync:read',
    'sync:write',
    'reports:read',
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
