/**
 * Price lists and the discount policy.
 *
 * The resolution itself lives in `src/domain/pricing/resolve.ts` and is pure,
 * because the till runs the same code offline. This module's job is to load
 * what that function needs — which list applies to this customer, which
 * entries it holds, what the item costs here — and to keep the stored policy
 * coherent.
 */
import { withReadTransaction, withTransaction, type Tx } from '../../db/tx.js';
import {
  mergeDiscountPolicy,
  resolvePrice,
  type DiscountPolicy,
  type PriceList,
  type PriceListEntry,
  type ResolvedPrice,
} from '../../domain/pricing/resolve.js';
import { requireAuthContext } from '../../lib/context.js';
import { ConflictError, ErrorCode, NotFoundError, UnprocessableError } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { buildPage, parsePage } from '../../lib/pagination.js';
import { accessibleOutletIds, assertOutletAccess } from '../../middleware/authorize.js';
import { diffFields, recordAudit } from '../audit/audit.js';
import { assertFeature } from '../entitlements/entitlements.js';
import { customersRepository } from '../customers/customers.repository.js';
import { tenantsRepository } from '../tenants/tenants.repository.js';
import { discountsRepository, type DiscountPolicyRow } from './discounts.repository.js';
import { priceListsRepository, type PriceListRow } from './price-lists.repository.js';
import type {
  CreatePriceListBody,
  ListDiscountApprovalsQuery,
  ListPriceListsQuery,
  PutDiscountPolicyBody,
  PutPriceListItemsBody,
  ResolvePriceQuery,
  UpdatePriceListBody,
} from './price-lists.schemas.js';

/** pg hands back NUMERIC as a string; nothing downstream should see one. */
const num = (value: string | null): number | undefined =>
  value === null ? undefined : Number(value);

function toPriceList(row: PriceListRow): PriceList {
  return {
    id: row.id,
    basis: row.basis,
    basisValue: Number(row.basisValue),
    minPriceFloor: row.minPriceFloor ?? undefined,
  };
}

async function requireList(tx: Tx, id: string): Promise<PriceListRow> {
  const list = await priceListsRepository.find(tx, id);
  if (!list) throw new NotFoundError('Price list');
  return list;
}

export async function listPriceLists(query: ListPriceListsQuery) {
  const page = parsePage(query);
  const rows = await withReadTransaction((tx) =>
    priceListsRepository.list(
      tx,
      { kind: query.kind, includeInactive: query.includeInactive ?? false },
      page.limit,
      page.cursor,
    ),
  );
  return buildPage(rows, page.limit, (row) => ({ k: row.name, id: row.id }));
}

export function getPriceList(id: string) {
  return withReadTransaction((tx) => requireList(tx, id));
}

export function createPriceList(body: CreatePriceListBody) {
  return withTransaction(async (tx) => {
    await assertFeature(tx, 'price_lists');

    // Client-generated id, so a replayed create returns what is there rather
    // than making a second list — the contract every master follows.
    const existing = await priceListsRepository.find(tx, body.id);
    if (existing) return existing;

    await priceListsRepository.insert(tx, {
      id: body.id,
      name: body.name,
      kind: body.kind,
      basis: body.basis,
      basisValue: body.basisValue,
      minPriceFloor: body.minPriceFloor ?? null,
      isDefault: body.isDefault ?? false,
      effectiveFrom: body.effectiveFrom ?? null,
      effectiveTo: body.effectiveTo ?? null,
      isActive: body.isActive ?? true,
    });
    if (body.isDefault) await priceListsRepository.clearDefaultExcept(tx, body.id);

    await recordAudit(tx, {
      action: 'price_list.created',
      entityType: 'price_list',
      entityId: body.id,
      metadata: { name: body.name, kind: body.kind, basis: body.basis },
    });
    return requireList(tx, body.id);
  });
}

export function updatePriceList(id: string, patch: UpdatePriceListBody) {
  return withTransaction(async (tx) => {
    await assertFeature(tx, 'price_lists');
    const before = await requireList(tx, id);

    await priceListsRepository.update(tx, id, patch);
    if (patch.isDefault) await priceListsRepository.clearDefaultExcept(tx, id);

    // Changing a list changes what every customer on it pays, so the trail
    // records the before and after, not just that something was touched.
    const changes = diffFields(before, patch);
    if (changes) {
      await recordAudit(tx, {
        action: 'price_list.updated',
        entityType: 'price_list',
        entityId: id,
        changes,
      });
    }
    return requireList(tx, id);
  });
}

export function deletePriceList(id: string) {
  return withTransaction(async (tx) => {
    await assertFeature(tx, 'price_lists');
    await requireList(tx, id);

    // Deleting a list out from under the customers on it would silently
    // reprice them to the item price, which is a quiet margin change nobody
    // asked for. Reassign them first.
    const customers = await priceListsRepository.countCustomers(tx, id);
    if (customers > 0) {
      throw new ConflictError(
        `${customers} customer(s) are priced on this list. Move them to another list first.`,
        ErrorCode.CONFLICT,
        { details: { customers } },
      );
    }

    await priceListsRepository.softDelete(tx, id);
    await recordAudit(tx, {
      action: 'price_list.deleted',
      entityType: 'price_list',
      entityId: id,
    });
  });
}

export async function listPriceListItems(id: string, query: { limit?: number; cursor?: string }) {
  const page = parsePage(query);
  const rows = await withReadTransaction(async (tx) => {
    await requireList(tx, id);
    return priceListsRepository.listItems(tx, id, page.limit, page.cursor);
  });
  return buildPage(rows, page.limit, (row) => ({ k: row.itemName, id: row.itemId }));
}

export function putPriceListItems(id: string, body: PutPriceListItemsBody) {
  return withTransaction(async (tx) => {
    await assertFeature(tx, 'price_lists');
    await requireList(tx, id);

    if (body.replace) await priceListsRepository.deleteAllItems(tx, id);
    await priceListsRepository.upsertItems(tx, id, body.items);

    await recordAudit(tx, {
      action: 'price_list.items_set',
      entityType: 'price_list',
      entityId: id,
      metadata: { count: body.items.length, replaced: body.replace },
    });
    return { priceListId: id, count: body.items.length, replaced: body.replace };
  });
}

export function deletePriceListItem(id: string, itemId: string) {
  return withTransaction(async (tx) => {
    await assertFeature(tx, 'price_lists');
    await requireList(tx, id);
    await priceListsRepository.deleteItem(tx, id, itemId);
    await recordAudit(tx, {
      action: 'price_list.item_removed',
      entityType: 'price_list',
      entityId: id,
      metadata: { itemId },
    });
  });
}

/**
 * What this customer pays for this item at this quantity, right now.
 *
 * The till warms its cache from this and then prices offline with the mirrored
 * pure resolver, which is why the answer carries `source` and `priceListId`:
 * the device needs to know not just the number but which rule produced it, so
 * it can reproduce the same answer without asking again.
 */
export function resolveItemPrice(query: ResolvePriceQuery): Promise<ResolvedPrice> {
  if (query.outletId) assertOutletAccess(query.outletId);

  return withReadTransaction(async (tx) => {
    const settings = await tenantsRepository.getSettings(tx);
    const today = businessDateIn(settings.timezone);

    const item = await priceListsRepository.findPricedItem(
      tx,
      query.itemId,
      query.outletId ?? null,
    );
    if (!item) throw new NotFoundError('Item');

    const list = await resolveListFor(tx, query, today);
    const entries: PriceListEntry[] = list
      ? (await priceListsRepository.entriesFor(tx, list.id, query.itemId)).map((row) => ({
          unitPrice: row.unitPrice,
          minQuantity: row.minQuantity,
          pricesIncludeTax: row.pricesIncludeTax,
        }))
      : [];

    return resolvePrice({
      item: {
        salePrice: item.salePrice,
        pricesIncludeTax: item.pricesIncludeTax,
        averageCost: item.averageCost ?? undefined,
      },
      quantity: query.quantity,
      priceList: list ? toPriceList(list) : undefined,
      entries,
    });
  });
}

/**
 * Which list prices this sale: the one asked for, else the customer's, else
 * the tenant default. A list outside its effective window prices nothing, and
 * resolution falls through to the item rather than charging a rate that has
 * expired.
 */
async function resolveListFor(
  tx: Tx,
  query: { customerId?: string | undefined; priceListId?: string | undefined },
  on: string,
): Promise<PriceListRow | undefined> {
  if (query.priceListId) {
    return priceListsRepository.findEffective(tx, query.priceListId, on);
  }
  if (query.customerId) {
    const customer = await customersRepository.find(tx, query.customerId);
    if (customer?.priceListId) {
      const assigned = await priceListsRepository.findEffective(tx, customer.priceListId, on);
      if (assigned) return assigned;
    }
  }
  return priceListsRepository.findDefault(tx, on);
}

/** Today in the tenant's timezone, which is the date a price list is live on. */
function businessDateIn(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/**
 * Resolves what each line of a bill *should* have cost, for the invoice path.
 *
 * Returns a map keyed by line id. Used two ways on upload: to record which
 * list priced each line, so a margin report reads a historical fact rather
 * than re-deriving against today's prices, and to notice that the device
 * charged something else — which is reported, never corrected. The device
 * priced from the list it held at the time and the list may have moved since;
 * rewriting the figure would make the invoice disagree with the printed bill
 * the customer is holding.
 */
export async function resolveLinePrices(
  tx: Tx,
  input: {
    outletId: string;
    customerId: string | null | undefined;
    documentDate: string;
    lines: readonly { id: string; itemId: string | null | undefined; quantity: number }[];
  },
): Promise<Map<string, ResolvedPrice>> {
  const resolved = new Map<string, ResolvedPrice>();
  const itemIds = [...new Set(input.lines.flatMap((l) => (l.itemId ? [l.itemId] : [])))];
  if (itemIds.length === 0) return resolved;

  const list = await resolveListFor(
    tx,
    input.customerId ? { customerId: input.customerId } : {},
    input.documentDate,
  );

  const entriesByItem = new Map<string, PriceListEntry[]>();
  if (list) {
    for (const row of await priceListsRepository.entriesForItems(tx, list.id, itemIds)) {
      const existing = entriesByItem.get(row.itemId) ?? [];
      existing.push({
        unitPrice: row.unitPrice,
        minQuantity: row.minQuantity,
        pricesIncludeTax: row.pricesIncludeTax,
      });
      entriesByItem.set(row.itemId, existing);
    }
  }

  const items = await priceListsRepository.findPricedItems(tx, itemIds, input.outletId);
  for (const line of input.lines) {
    if (!line.itemId) continue;
    const item = items.get(line.itemId);
    if (!item) continue;
    resolved.set(
      line.id,
      resolvePrice({
        item: {
          salePrice: item.salePrice,
          pricesIncludeTax: item.pricesIncludeTax,
          averageCost: item.averageCost ?? undefined,
        },
        quantity: line.quantity,
        priceList: list ? toPriceList(list) : undefined,
        entries: entriesByItem.get(line.itemId) ?? [],
      }),
    );
  }
  return resolved;
}

// --- Discount policy -------------------------------------------------------

function toPolicy(row: DiscountPolicyRow | undefined): Partial<DiscountPolicy> {
  if (!row) return {};
  return {
    maxLineDiscountPercent: num(row.maxLineDiscountPercent),
    maxBillDiscountPercent: num(row.maxBillDiscountPercent),
    maxDiscountAmount: row.maxDiscountAmount ?? undefined,
    minMarginPercent: num(row.minMarginPercent),
    requireApprovalAbovePercent: num(row.requireApprovalAbovePercent),
  };
}

/**
 * The policy in force at an outlet: the tenant-wide row with the outlet's
 * overrides merged over it field by field.
 *
 * Exported because the invoice path needs it on every create. Returns the
 * approver permission alongside, since the policy names who may approve and
 * the invoice path has to check against that rather than a constant.
 */
export async function effectivePolicyFor(
  tx: Tx,
  outletId: string | null,
): Promise<{ policy: DiscountPolicy; approverPermission: string }> {
  const rows = await discountsRepository.scopedPolicies(tx, outletId);
  const tenantWide = rows.find((row) => row.outletId === null);
  const outletRow = rows.find((row) => row.outletId !== null);
  return {
    policy: mergeDiscountPolicy(toPolicy(tenantWide), toPolicy(outletRow)),
    approverPermission:
      outletRow?.approverPermission ?? tenantWide?.approverPermission ?? 'discounts:approve',
  };
}

export function getDiscountPolicies() {
  return withReadTransaction(async (tx) => {
    const rows = await discountsRepository.scopedPolicies(tx, null);
    return rows;
  });
}

export function putDiscountPolicy(body: PutDiscountPolicyBody) {
  const outletId = body.outletId ?? null;
  if (outletId) assertOutletAccess(outletId);

  return withTransaction(async (tx) => {
    await assertFeature(tx, 'discount_rules');

    const { outletId: _scope, ...patch } = body;
    let row = await discountsRepository.findByScope(tx, outletId);
    if (!row) {
      const id = newId();
      await discountsRepository.insertPolicy(tx, {
        id,
        outletId,
        approverPermission: body.approverPermission ?? 'discounts:approve',
      });
      row = await discountsRepository.findByScope(tx, outletId);
    }
    if (!row) throw new UnprocessableError('The discount policy could not be created.');

    await discountsRepository.updatePolicy(tx, row.id, patch);
    const after = await discountsRepository.findByScope(tx, outletId);

    const changes = diffFields(row, patch);
    if (changes) {
      await recordAudit(tx, {
        action: 'discount_policy.updated',
        entityType: 'discount_policy',
        entityId: row.id,
        changes,
        metadata: { outletId },
      });
    }
    return after;
  });
}

export async function listDiscountApprovals(query: ListDiscountApprovalsQuery) {
  const page = parsePage(query);
  const rows = await withReadTransaction((tx) =>
    discountsRepository.listApprovals(
      tx,
      {
        from: query.from,
        to: query.to,
        approvedBy: query.approvedBy,
        invoiceId: query.invoiceId,
      },
      accessibleOutletIds(),
      page.limit,
      page.cursor,
    ),
  );
  return buildPage(rows, page.limit, (row) => ({
    k: row.approvedAt.toISOString(),
    id: row.id,
  }));
}

/** Kept so the module's own routes can report who the caller is to the audit. */
export function currentActor(): string {
  return requireAuthContext().userId;
}
