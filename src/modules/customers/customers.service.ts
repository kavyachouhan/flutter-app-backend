import { withReadTransaction, withTransaction, type Tx } from '../../db/tx.js';
import { requireAuthContext } from '../../lib/context.js';
import { NotFoundError, UnprocessableError } from '../../lib/errors.js';
import { buildPage, parsePage } from '../../lib/pagination.js';
import { diffFields, recordAudit } from '../audit/audit.js';
import { normalizePhone } from '../auth/phone.js';
import { customersRepository, type CustomerAddressRow, type CustomerRow } from './customers.repository.js';
import type {
  CreateCustomerBody,
  ListCustomersQuery,
  UpdateCustomerBody,
  UpsertCustomerAddressBody,
} from './customers.schemas.js';
import type { z } from 'zod';
import type { pageQuery } from '../../lib/pagination.js';

async function requireCustomer(tx: Tx, id: string): Promise<CustomerRow> {
  const customer = await customersRepository.find(tx, id);
  if (!customer) throw new NotFoundError('Customer');
  return customer;
}

const optionalPhone = (phone: string | null | undefined) =>
  phone === undefined || phone === null ? phone : normalizePhone(phone);

export async function listCustomers(query: ListCustomersQuery) {
  const page = parsePage(query);
  const rows = await withReadTransaction((tx) =>
    customersRepository.list(tx, query.q, page.limit, page.cursor),
  );
  return buildPage(rows, page.limit, (row) => ({ k: row.name, id: row.id }));
}

export function getCustomer(id: string) {
  return withReadTransaction((tx) => requireCustomer(tx, id));
}

export function createCustomer(body: CreateCustomerBody) {
  const auth = requireAuthContext();
  const phone = optionalPhone(body.phone) ?? null;

  return withTransaction(async (tx) => {
    const existing = await customersRepository.find(tx, body.id);
    if (existing) return existing;

    await customersRepository.insert(tx, {
      id: body.id,
      name: body.name,
      phone,
      email: body.email ?? null,
      gstin: body.gstin ?? null,
      gstTreatment: body.gstTreatment ?? null,
      uin: body.uin ?? null,
      countryCode: body.countryCode ?? 'IN',
      stateCode: body.stateCode ?? null,
      addressLine1: body.addressLine1 ?? null,
      addressLine2: body.addressLine2 ?? null,
      city: body.city ?? null,
      pincode: body.pincode ?? null,
      creditLimit: body.creditLimit ?? null,
      priceListId: body.priceListId ?? null,
      notes: body.notes ?? null,
    });

    // A balance carried over from a paper khata or another app.
    if (body.openingBalance) {
      await customersRepository.insertLedgerEntries(tx, [
        {
          customerId: body.id,
          entryType: 'opening_balance',
          debit: Math.max(body.openingBalance, 0),
          credit: Math.max(-body.openingBalance, 0),
          referenceType: null,
          referenceId: null,
          occurredAt: new Date().toISOString(),
          note: null,
          createdBy: auth.userId,
        },
      ]);
    }
    return requireCustomer(tx, body.id);
  });
}

export function updateCustomer(id: string, patch: UpdateCustomerBody) {
  const normalized = { ...patch, phone: optionalPhone(patch.phone) };
  return withTransaction(async (tx) => {
    const before = await requireCustomer(tx, id);
    await customersRepository.update(tx, id, normalized);
    const changes = diffFields(before, normalized);
    if (changes && 'creditLimit' in changes) {
      await recordAudit(tx, {
        action: 'customer.credit_limit_changed',
        entityType: 'customer',
        entityId: id,
        changes,
      });
    }
    return requireCustomer(tx, id);
  });
}

export function listCustomerAddresses(customerId: string): Promise<CustomerAddressRow[]> {
  return withReadTransaction(async (tx) => {
    await requireCustomer(tx, customerId);
    return customersRepository.listAddresses(tx, customerId);
  });
}

export function upsertCustomerAddress(body: UpsertCustomerAddressBody): Promise<CustomerAddressRow> {
  return withTransaction(async (tx) => {
    await requireCustomer(tx, body.customerId);
    const existing = await customersRepository.findAddress(tx, body.id);
    if (existing && existing.customerId !== body.customerId) {
      throw new NotFoundError('Delivery address');
    }
    const row: CustomerAddressRow = {
      id: body.id,
      customerId: body.customerId,
      label: body.label ?? null,
      line1: body.line1,
      line2: body.line2 ?? null,
      city: body.city,
      countryCode: body.countryCode ?? 'IN',
      stateCode: body.stateCode ?? null,
      postalCode: body.postalCode ?? null,
      shipToGstin: body.shipToGstin ?? null,
      isDefault: body.isDefault ?? false,
    };
    await customersRepository.upsertAddress(tx, row);
    return row;
  });
}

export function deleteCustomerAddress(customerId: string, addressId: string): Promise<void> {
  return withTransaction(async (tx) => {
    const existing = await customersRepository.findAddress(tx, addressId);
    if (!existing || existing.customerId !== customerId) throw new NotFoundError('Delivery address');
    await customersRepository.softDeleteAddress(tx, addressId);
  });
}

export function deleteCustomer(id: string) {
  return withTransaction(async (tx) => {
    const customer = await requireCustomer(tx, id);
    if (customer.balance !== 0) {
      throw new UnprocessableError(
        'Settle this customer’s balance before deleting them.',
        undefined,
        {
          details: { balance: customer.balance },
        },
      );
    }
    await customersRepository.softDelete(tx, id);
    await recordAudit(tx, { action: 'customer.deleted', entityType: 'customer', entityId: id });
  });
}

export async function getStatement(id: string, query: z.infer<typeof pageQuery>) {
  const page = parsePage(query);
  const rows = await withReadTransaction(async (tx) => {
    await requireCustomer(tx, id);
    return customersRepository.statement(tx, id, page.limit, page.cursor);
  });
  return buildPage(rows, page.limit, (row) => ({ k: row.occurredAt.toISOString(), id: row.id }));
}
