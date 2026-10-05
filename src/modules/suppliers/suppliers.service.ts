import type { z } from 'zod';
import { withReadTransaction, withTransaction, type Tx } from '../../db/tx.js';
import { requireAuthContext } from '../../lib/context.js';
import { NotFoundError, UnprocessableError } from '../../lib/errors.js';
import { buildPage, parsePage, type pageQuery } from '../../lib/pagination.js';
import { recordAudit } from '../audit/audit.js';
import { normalizePhone } from '../auth/phone.js';
import { assertFeature } from '../entitlements/entitlements.js';
import { tenantsRepository } from '../tenants/tenants.repository.js';
import { suppliersRepository, type SupplierRow } from './suppliers.repository.js';
import type {
  CreateSupplierBody,
  ListSuppliersQuery,
  UpdateSupplierBody,
} from './suppliers.schemas.js';

const AGEING_BUCKETS = ['0-30', '31-60', '61-90', '90+'] as const;

async function requireSupplier(tx: Tx, id: string): Promise<SupplierRow> {
  const supplier = await suppliersRepository.find(tx, id);
  if (!supplier) throw new NotFoundError('Supplier');
  return supplier;
}

const optionalPhone = (phone: string | null | undefined) =>
  phone === undefined || phone === null ? phone : normalizePhone(phone);

export async function listSuppliers(query: ListSuppliersQuery) {
  const page = parsePage(query);
  const rows = await withReadTransaction((tx) =>
    suppliersRepository.list(tx, query.q, query.includeInactive ?? false, page.limit, page.cursor),
  );
  return buildPage(rows, page.limit, (row) => ({ k: row.name, id: row.id }));
}

export function getSupplier(id: string) {
  return withReadTransaction((tx) => requireSupplier(tx, id));
}

export function createSupplier(body: CreateSupplierBody) {
  const auth = requireAuthContext();
  const phone = optionalPhone(body.phone) ?? null;

  return withTransaction(async (tx) => {
    await assertFeature(tx, 'purchases');

    // Client-generated id, so a replayed create returns what is there rather
    // than failing — the same contract as every other master in the system.
    const existing = await suppliersRepository.find(tx, body.id);
    if (existing) return existing;

    await suppliersRepository.insert(tx, {
      id: body.id,
      name: body.name,
      phone,
      email: body.email ?? null,
      gstin: body.gstin ?? null,
      stateCode: body.stateCode ?? null,
      addressLine1: body.addressLine1 ?? null,
      addressLine2: body.addressLine2 ?? null,
      city: body.city ?? null,
      pincode: body.pincode ?? null,
      paymentTermsDays: body.paymentTermsDays ?? null,
      leadTimeDays: body.leadTimeDays ?? null,
      notes: body.notes ?? null,
      isActive: body.isActive ?? true,
    });

    // Carried over from a paper ledger or another app. Positive means the
    // shop owes, which on this ledger is a credit.
    if (body.openingBalance) {
      await suppliersRepository.insertLedgerEntries(tx, [
        {
          supplierId: body.id,
          entryType: 'opening_balance',
          debit: Math.max(-body.openingBalance, 0),
          credit: Math.max(body.openingBalance, 0),
          referenceType: null,
          referenceId: null,
          occurredAt: new Date().toISOString(),
          note: null,
          createdBy: auth.userId,
        },
      ]);
    }
    return requireSupplier(tx, body.id);
  });
}

export function updateSupplier(id: string, patch: UpdateSupplierBody) {
  const normalized = { ...patch, phone: optionalPhone(patch.phone) };
  return withTransaction(async (tx) => {
    await requireSupplier(tx, id);
    await suppliersRepository.update(tx, id, normalized);
    return requireSupplier(tx, id);
  });
}

export function deleteSupplier(id: string) {
  return withTransaction(async (tx) => {
    const supplier = await requireSupplier(tx, id);
    if (supplier.balance !== 0) {
      throw new UnprocessableError(
        'Settle this supplier’s balance before deleting them.',
        undefined,
        {
          details: { balance: supplier.balance },
        },
      );
    }
    await suppliersRepository.softDelete(tx, id);
    await recordAudit(tx, { action: 'supplier.deleted', entityType: 'supplier', entityId: id });
  });
}

export async function getSupplierStatement(id: string, query: z.infer<typeof pageQuery>) {
  const page = parsePage(query);
  const rows = await withReadTransaction(async (tx) => {
    await requireSupplier(tx, id);
    return suppliersRepository.statement(tx, id, page.limit, page.cursor);
  });
  return buildPage(rows, page.limit, (row) => ({ k: row.occurredAt.toISOString(), id: row.id }));
}

/**
 * Payables ageing.
 *
 * Buckets are filled in even when empty, so a client can render four columns
 * without deciding what a missing bucket means, and totals are returned per
 * supplier because that is the unit a shopkeeper acts on — they pay a
 * supplier, not a bucket.
 */
export function getAgeing(supplierId: string | undefined) {
  return withReadTransaction(async (tx) => {
    if (supplierId) await requireSupplier(tx, supplierId);
    const settings = await tenantsRepository.getSettings(tx);
    const rows = await suppliersRepository.ageing(tx, supplierId, settings.timezone);

    const bySupplier = new Map<
      string,
      { supplierId: string; supplierName: string; buckets: Record<string, number>; total: number }
    >();

    for (const row of rows) {
      const entry = bySupplier.get(row.supplierId) ?? {
        supplierId: row.supplierId,
        supplierName: row.supplierName,
        buckets: Object.fromEntries(AGEING_BUCKETS.map((b) => [b, 0])),
        total: 0,
      };
      entry.buckets[row.bucket] = Number(row.amount);
      entry.total += Number(row.amount);
      bySupplier.set(row.supplierId, entry);
    }

    const suppliers = [...bySupplier.values()];
    return {
      buckets: AGEING_BUCKETS,
      suppliers,
      total: suppliers.reduce((sum, s) => sum + s.total, 0),
    };
  });
}

export function getOutstandingBills(supplierId: string) {
  return withReadTransaction(async (tx) => {
    await requireSupplier(tx, supplierId);
    const bills = await suppliersRepository.outstandingBills(tx, supplierId);
    return bills.filter((bill) => bill.outstanding > 0);
  });
}
