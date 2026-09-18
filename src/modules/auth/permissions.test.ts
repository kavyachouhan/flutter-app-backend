import { describe, expect, it } from 'vitest';
import { PERMISSIONS, ROLES, canManageRole, hasPermission, permissionsFor } from './permissions.js';

describe('permissions', () => {
  it('grants the owner everything', () => {
    expect(permissionsFor('owner')).toEqual([...PERMISSIONS]);
  });

  it('keeps tenant management with the owner', () => {
    expect(hasPermission('manager', 'tenant:manage')).toBe(false);
    expect(hasPermission('manager', 'invoices:void')).toBe(true);
  });

  it('lets a cashier bill but not void or adjust stock', () => {
    expect(hasPermission('cashier', 'invoices:create')).toBe(true);
    expect(hasPermission('cashier', 'numbering:lease')).toBe(true);
    expect(hasPermission('cashier', 'invoices:void')).toBe(false);
    expect(hasPermission('cashier', 'stock:adjust')).toBe(false);
  });

  it('gives accountants and viewers read access only', () => {
    for (const role of ['accountant', 'viewer'] as const) {
      expect(permissionsFor(role).every((p) => p.endsWith(':read'))).toBe(true);
    }
    expect(hasPermission('accountant', 'audit:read')).toBe(true);
    expect(hasPermission('viewer', 'audit:read')).toBe(false);
  });

  it('only lets an owner assign or modify the owner role', () => {
    for (const actor of ROLES) {
      expect(canManageRole(actor, 'owner')).toBe(actor === 'owner');
    }
    expect(canManageRole('manager', 'cashier')).toBe(true);
    expect(canManageRole('cashier', 'viewer')).toBe(false);
  });
});
