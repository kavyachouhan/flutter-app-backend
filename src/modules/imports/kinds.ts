/**
 * What differs between importing items, customers and suppliers.
 *
 * The three-phase pipeline (ingest → analyse → apply, src/modules/imports/
 * imports.service.ts) is the same for every kind. What a kind supplies is:
 *
 *   columns   its spreadsheet contract (src/domain/import/*-columns.ts)
 *   analyse   how a parsed row finds the existing record it updates, and
 *             what a creating row claims so a second row cannot create the
 *             same record twice
 *   write     how one reviewed row becomes a database change
 *
 * Matching follows the order a shopkeeper would use themselves:
 *   items      code → barcode → name
 *   parties    phone → GSTIN → name
 *
 * Fields marked `createOnly` (opening stock, opening balance) are applied
 * when a record is created and never to one that exists: re-importing last
 * month's file must not add the stock or the balance a second time. The row
 * says so in a note rather than silently dropping the number.
 */
import { randomUUID } from 'node:crypto';
import type { Tx } from '../../db/tx.js';
import type {
  ColumnDefinition,
  ColumnSet,
  ParsedRow,
  ParsedValue,
} from '../../domain/import/columns.js';
import { ITEM_COLUMN_SET, parseItemRow } from '../../domain/import/item-columns.js';
import {
  CUSTOMER_COLUMN_SET,
  SUPPLIER_COLUMN_SET,
  parsePartyRow,
} from '../../domain/import/party-columns.js';
import { ValidationError } from '../../lib/errors.js';
import { normalizePhone } from '../auth/phone.js';
import type { Permission } from '../auth/permissions.js';
import { catalogueRepository } from '../catalogue/catalogue.repository.js';
import { customersRepository } from '../customers/customers.repository.js';
import type { Feature } from '../entitlements/entitlements.js';
import { stockRepository } from '../stock/stock.repository.js';
import { suppliersRepository } from '../suppliers/suppliers.repository.js';
import { tenantsRepository } from '../tenants/tenants.repository.js';
import {
  importsRepository,
  type AnalysedRow,
  type ImportJobRowRecord,
  type MatchCandidate,
  type MatchRule,
  type PartyCandidate,
} from './imports.repository.js';

export type ImportableKind = 'items' | 'customers' | 'suppliers';

type Values = Record<string, ParsedValue>;

export interface ParsedChunkRow {
  rowNo: number;
  values: Values;
  errors: Record<string, string>;
  notes: string[];
}

export interface AnalyseContext {
  jobId: string;
  outletId: string | null;
}

export interface WriteContext {
  outletId: string | null;
  userId: string;
}

export interface KindHandler {
  readonly kind: ImportableKind;
  /** "item", "customer" — for messages. */
  readonly noun: string;
  readonly columns: ColumnSet;
  /** Needed on top of imports:write, because the import creates records of this kind. */
  readonly permission: Permission | null;
  /** Plan features the kind needs, on top of bulk import itself. */
  readonly features: readonly Feature[];
  parse(cells: readonly string[], map: Record<string, number>): ParsedRow;
  analyse(tx: Tx, rows: readonly ParsedChunkRow[], context: AnalyseContext): Promise<AnalysedRow[]>;
  /** Loaded once per apply chunk and handed to every write. */
  prepareWrite(tx: Tx): Promise<unknown>;
  /** Changes the column-by-column diff cannot see (an added barcode). */
  extraDiff?(
    existing: Record<string, unknown>,
    values: Values,
  ): Record<string, { from: unknown; to: unknown }>;
  write(tx: Tx, row: ImportJobRowRecord, context: WriteContext, prepared: unknown): Promise<void>;
}

// ---------------------------------------------------------------------------
// Shared judging
// ---------------------------------------------------------------------------

export interface Judgement {
  rowNo: number;
  parsed: ParsedChunkRow;
  match: { id: string; rule: MatchRule; existing: Record<string, unknown> } | null;
  dedupeKeys: string[];
}

/**
 * Decides what one row will do, and why.
 *
 * [claimedUpdates] holds records an earlier row of this job already updates;
 * [claimedCreates] what earlier creating rows claimed (key → row number).
 * Both span the whole job, not just this chunk.
 */
export function decide(
  handler: KindHandler,
  judgement: Judgement,
  claimedUpdates: Set<string>,
  claimedCreates: Map<string, number>,
): AnalysedRow {
  const { rowNo, parsed, match, dedupeKeys } = judgement;
  const base = { rowNo, parsed: parsed.values, diff: null };
  const notes = [...parsed.notes];

  if (Object.keys(parsed.errors).length > 0) {
    return {
      ...base,
      action: 'error',
      targetId: null,
      matchRule: null,
      errors: parsed.errors,
      notes: orNull(notes),
      dedupeKeys: null,
    };
  }

  if (match === null) {
    const clash = dedupeKeys.find((key) => claimedCreates.has(key));
    if (clash !== undefined) {
      const field = clash.slice(0, clash.indexOf(':'));
      return {
        ...base,
        action: 'error',
        targetId: null,
        matchRule: null,
        errors: {
          [field]: `Row ${claimedCreates.get(clash)} of this file already adds ${/^[aeiou]/.test(handler.noun) ? 'an' : 'a'} ${handler.noun} with the same ${fieldLabel(field)}`,
        },
        notes: orNull(notes),
        dedupeKeys: null,
      };
    }
    for (const key of dedupeKeys) claimedCreates.set(key, rowNo);
    return {
      ...base,
      action: 'create',
      targetId: null,
      matchRule: null,
      errors: null,
      notes: orNull(notes),
      dedupeKeys,
    };
  }

  // Two rows updating one existing record is a mistake in the file. Saying
  // so is better than applying both and keeping whichever landed last.
  if (claimedUpdates.has(match.id)) {
    return {
      ...base,
      action: 'error',
      targetId: null,
      matchRule: null,
      errors: { name: `Another row in this file already updates the same ${handler.noun}` },
      notes: orNull(notes),
      dedupeKeys: null,
    };
  }
  claimedUpdates.add(match.id);

  for (const column of handler.columns.columns) {
    const value = parsed.values[column.key];
    if (column.createOnly && value !== null && value !== undefined && value !== 0) {
      notes.push(
        `${column.header} is only used for a new ${handler.noun}; this one already exists`,
      );
    }
  }

  const diff = {
    ...diffAgainst(handler.columns.columns, match.existing, parsed.values),
    ...(handler.extraDiff?.(match.existing, parsed.values) ?? {}),
  };
  if (Object.keys(diff).length === 0) {
    return {
      ...base,
      action: 'skip',
      targetId: match.id,
      matchRule: match.rule,
      errors: null,
      notes: orNull(notes),
      dedupeKeys: null,
    };
  }
  return {
    ...base,
    action: 'update',
    targetId: match.id,
    matchRule: match.rule,
    diff,
    errors: null,
    notes: orNull(notes),
    dedupeKeys: null,
  };
}

const orNull = (notes: string[]): string[] | null => (notes.length > 0 ? notes : null);

const fieldLabel = (field: string): string =>
  ({ phone: 'phone number', gstin: 'GSTIN', code: 'code', barcode: 'barcode', name: 'name' })[
    field
  ] ?? field;

/**
 * Only columns the file actually supplied are compared.
 *
 * A price list with no HSN column must not be read as "clear every HSN code",
 * and a blank cell is not an instruction to clear a stored value either. This
 * is the difference between an importer a shop trusts and one it uses once.
 */
function diffAgainst(
  columns: readonly ColumnDefinition[],
  existing: Record<string, unknown>,
  values: Values,
): Record<string, { from: unknown; to: unknown }> {
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const column of columns) {
    if (column.createOnly || column.transient || !(column.key in existing)) continue;
    const next = values[column.key];
    if (next === null || next === undefined) continue;
    const current = existing[column.key] ?? null;
    if (!sameValue(current, next)) diff[column.key] = { from: current, to: next };
  }
  return diff;
}

/**
 * Typed by the value rather than stringified, because `pg` returns NUMERIC
 * as a string: "18.000" from the database and 18 from the file are the same,
 * and reporting them as a change would turn a clean re-import into 500 fake
 * updates.
 */
function sameValue(current: unknown, next: string | number | boolean): boolean {
  if (typeof next === 'number') {
    const asNumber = typeof current === 'number' ? current : Number(current);
    return current !== null && current !== '' && Number.isFinite(asNumber) && asNumber === next;
  }
  if (typeof next === 'boolean') return current === next;
  return typeof current === 'string' && current === next;
}

/** The fields a write may set: everything the file supplied that is stored as-is. */
function storedPatch(
  columns: readonly ColumnDefinition[],
  values: Values,
  skip: ReadonlySet<string>,
) {
  const patch: Record<string, unknown> = {};
  for (const column of columns) {
    if (column.createOnly || column.transient || skip.has(column.key)) continue;
    const value = values[column.key];
    // Undefined means the column was absent; null means the cell was blank.
    // Neither is an instruction to clear a stored value.
    if (value !== undefined && value !== null) patch[column.key] = value;
  }
  return patch;
}

const str = (v: ParsedValue | undefined): string | null =>
  typeof v === 'string' && v !== '' ? v : null;
const num = (v: ParsedValue | undefined): number | null => (typeof v === 'number' ? v : null);

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

const ITEM_SPECIAL = new Set(['barcode', 'category']);

interface ItemWritePrep {
  categories: Map<string, string>;
  defaultPricesIncludeTax: boolean;
}

export const itemsKind: KindHandler = {
  kind: 'items',
  noun: 'item',
  columns: ITEM_COLUMN_SET,
  permission: null,
  features: [],

  parse: (cells, map) => parseItemRow(cells, map),

  extraDiff(existing, values) {
    const diff: Record<string, { from: unknown; to: unknown }> = {};
    const barcode = str(values['barcode']);
    const barcodes = (existing['barcodes'] as string[] | undefined) ?? [];
    if (barcode && !barcodes.includes(barcode)) diff['barcode'] = { from: barcodes, to: barcode };
    return diff;
  },

  async analyse(tx, rows, context) {
    const codes = new Set<string>();
    const barcodes = new Set<string>();
    const names = new Set<string>();
    for (const { values } of rows) {
      const code = str(values['code']);
      const barcode = str(values['barcode']);
      const name = str(values['name']);
      // Codes are unique regardless of case (items_code_uq), so they match that way too.
      if (code) codes.add(code.toLowerCase());
      if (barcode) barcodes.add(barcode);
      if (name) names.add(name.toLowerCase());
    }
    const found = await importsRepository.findMatchCandidates(
      tx,
      [...codes],
      [...barcodes],
      [...names],
    );
    const byCode = new Map<string, MatchCandidate>();
    const byBarcode = new Map<string, MatchCandidate>();
    const byName = new Map<string, MatchCandidate>();
    for (const candidate of found) {
      if (candidate.code) byCode.set(candidate.code.toLowerCase(), candidate);
      for (const barcode of candidate.barcodes) byBarcode.set(barcode, candidate);
      // First wins, so a duplicate name resolves consistently across chunks.
      const key = candidate.name.toLowerCase();
      if (!byName.has(key)) byName.set(key, candidate);
    }

    const settings = await tenantsRepository.getSettings(tx);
    const judgements: Judgement[] = rows.map((parsed) => {
      const code = str(parsed.values['code']);
      const barcode = str(parsed.values['barcode']);
      const name = str(parsed.values['name']);
      let match: Judgement['match'] = null;
      const hit = (candidate: MatchCandidate | undefined, rule: MatchRule) => {
        if (!match && candidate) match = { id: candidate.id, rule, existing: { ...candidate } };
      };
      if (code) hit(byCode.get(code.toLowerCase()), 'code');
      if (barcode) hit(byBarcode.get(barcode), 'barcode');
      if (name) hit(byName.get(name.toLowerCase()), 'name');

      // A barcode belongs to one item. Giving this row's item a barcode that
      // is already on a different one would be refused by the database.
      const owner = barcode ? byBarcode.get(barcode) : undefined;
      const matchedId = (match as Judgement['match'])?.id;
      if (owner && owner.id !== matchedId) {
        parsed.errors['barcode'] = `Barcode ${barcode} already belongs to "${owner.name}"`;
      }
      // An existing service cannot be told to track stock.
      const existingType = (match as Judgement['match'])?.existing['itemType'];
      if (existingType === 'service' && parsed.values['itemType'] !== 'goods') {
        if (parsed.values['trackStock'] === true) {
          parsed.errors['trackStock'] = 'This item is a service, which cannot track stock';
        } else if ('trackStock' in parsed.values) {
          parsed.values['trackStock'] = null;
        }
      }

      const stock = num(parsed.values['openingStock']);
      if (match === null && stock !== null && stock !== 0) {
        if (stock < 0 && !settings.allowNegativeStock) {
          parsed.errors['openingStock'] =
            'Opening stock is below zero, which your settings do not allow. Fix the number or allow negative stock.';
        } else if (parsed.values['trackStock'] === false) {
          parsed.notes.push(
            'Stock is not tracked for this item, so its opening stock is not recorded',
          );
        } else if (context.outletId === null) {
          parsed.notes.push(
            'No outlet was chosen for this import, so opening stock is not recorded',
          );
        }
      }

      const dedupeKeys = [
        ...(code ? [`code:${code.toLowerCase()}`] : []),
        ...(barcode ? [`barcode:${barcode}`] : []),
        ...(!code && !barcode && name ? [`name:${name.toLowerCase()}`] : []),
      ];
      return { rowNo: parsed.rowNo, parsed, match, dedupeKeys };
    });

    return judgeAll(tx, itemsKind, context.jobId, judgements);
  },

  async prepareWrite(tx): Promise<ItemWritePrep> {
    const settings = await tenantsRepository.getSettings(tx);
    return {
      categories: await importsRepository.categoryIdsByName(tx),
      defaultPricesIncludeTax: settings.defaultPricesIncludeTax,
    };
  },

  async write(tx, row, context, prepared) {
    const { categories, defaultPricesIncludeTax } = prepared as ItemWritePrep;
    const values = row.parsed ?? {};
    const categoryId = await resolveCategory(tx, values['category'], categories);
    const barcode = str(values['barcode']);

    if (row.action === 'create') {
      const itemId = randomUUID();
      const itemType = (values['itemType'] as 'goods' | 'service' | null) ?? 'goods';
      // The same default as the item screen: goods track stock, services cannot.
      const trackStock = (values['trackStock'] as boolean | null) ?? itemType === 'goods';
      await catalogueRepository.insertItem(tx, {
        id: itemId,
        categoryId,
        itemType,
        name: String(values['name']),
        code: str(values['code']),
        aliases: [],
        hsnCode: str(values['hsnCode']),
        taxRatePercent: num(values['taxRatePercent']) ?? 0,
        cessRatePercent: num(values['cessRatePercent']) ?? 0,
        unit: str(values['unit']) ?? 'pcs',
        mrp: num(values['mrp']),
        salePrice: num(values['salePrice']) ?? 0,
        discountPercent: num(values['discountPercent']),
        purchasePrice: num(values['purchasePrice']),
        pricesIncludeTax: (values['pricesIncludeTax'] as boolean | null) ?? defaultPricesIncludeTax,
        trackStock,
        reorderLevel: num(values['reorderLevel']),
        // No column for it: an imported item is taxable until someone says
        // otherwise. An exempt item wrongly marked taxable shows up on the
        // first return; the reverse under-reports turnover.
        supplyCategory: 'taxable',
        isActive: true,
        // A spreadsheet carries no photo; one is added from the app afterwards.
        imageObjectKey: null,
      });
      if (barcode) await catalogueRepository.replaceBarcodes(tx, itemId, [barcode]);

      const stock = num(values['openingStock']);
      if (stock !== null && stock !== 0 && trackStock && context.outletId !== null) {
        await stockRepository.insertEntries(tx, [
          {
            id: randomUUID(),
            outletId: context.outletId,
            itemId,
            entryType: 'opening',
            quantityDelta: stock,
            reasonCode: 'opening',
            referenceType: null,
            referenceId: null,
            occurredAt: new Date().toISOString(),
            note: 'Opening stock from an import',
            createdBy: context.userId,
          },
        ]);
      }
      return;
    }

    if (!row.targetId) return;
    const patch = storedPatch(ITEM_COLUMN_SET.columns, values, ITEM_SPECIAL);
    if (categoryId !== null) patch['categoryId'] = categoryId;
    await catalogueRepository.updateItem(tx, row.targetId, patch);

    if (barcode) {
      // Additive: a shop's own barcode and a manufacturer's often coexist,
      // and an import should not silently drop one already on a shelf.
      const existing = await tx.one<{ barcodes: string[] }>(
        `SELECT COALESCE(array_agg(barcode), '{}') AS barcodes FROM item_barcodes
         WHERE item_id = $1 AND deleted_at IS NULL`,
        [row.targetId],
      );
      const all = new Set([...(existing?.barcodes ?? []), barcode]);
      await catalogueRepository.replaceBarcodes(tx, row.targetId, [...all]);
    }
  },
};

/** Categories named in the file are created on demand; a price list rarely lists them separately. */
async function resolveCategory(
  tx: Tx,
  value: unknown,
  categories: Map<string, string>,
): Promise<string | null> {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const key = value.trim().toLowerCase();
  const existing = categories.get(key);
  if (existing) return existing;
  const id = randomUUID();
  await catalogueRepository.insertCategory(tx, {
    id,
    name: value.trim(),
    parentId: null,
    icon: null,
  });
  categories.set(key, id);
  return id;
}

// ---------------------------------------------------------------------------
// Customers and suppliers
// ---------------------------------------------------------------------------

function partyKind(kind: 'customers' | 'suppliers'): KindHandler {
  const customers = kind === 'customers';
  const columns = customers ? CUSTOMER_COLUMN_SET : SUPPLIER_COLUMN_SET;

  const handler: KindHandler = {
    kind,
    noun: customers ? 'customer' : 'supplier',
    columns,
    permission: customers ? 'customers:write' : 'suppliers:write',
    features: customers ? [] : ['purchases'],

    parse(cells, map) {
      const parsed = parsePartyRow(columns, cells, map);
      const phone = parsed.values['phone'];
      if (typeof phone !== 'string') return parsed;
      // The deployment's phone rules (country code, national length), the
      // same ones the customer screen applies, so an imported number and a
      // typed one are the same string and match each other.
      try {
        return { ...parsed, values: { ...parsed.values, phone: normalizePhone(phone) } };
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        return {
          ...parsed,
          errors: { ...parsed.errors, phone: 'Phone must be a valid mobile number' },
        };
      }
    },

    async analyse(tx, rows, context) {
      const phones = new Set<string>();
      const gstins = new Set<string>();
      const names = new Set<string>();
      for (const { values } of rows) {
        const phone = str(values['phone']);
        const gstin = str(values['gstin']);
        const name = str(values['name']);
        if (phone) phones.add(phone);
        if (gstin) gstins.add(gstin);
        if (name) names.add(name.toLowerCase());
      }
      const found = await importsRepository.findPartyCandidates(
        tx,
        kind,
        [...phones],
        [...gstins],
        [...names],
      );
      const byPhone = new Map<string, PartyCandidate>();
      const byGstin = new Map<string, PartyCandidate>();
      const byName = new Map<string, PartyCandidate>();
      for (const candidate of found) {
        if (candidate.phone) byPhone.set(candidate.phone, candidate);
        if (candidate.gstin && !byGstin.has(candidate.gstin))
          byGstin.set(candidate.gstin, candidate);
        const key = candidate.name.toLowerCase();
        if (!byName.has(key)) byName.set(key, candidate);
      }

      const judgements: Judgement[] = rows.map((parsed) => {
        const phone = str(parsed.values['phone']);
        const gstin = str(parsed.values['gstin']);
        const name = str(parsed.values['name']);
        let match: Judgement['match'] = null;
        const hit = (candidate: PartyCandidate | undefined, rule: MatchRule) => {
          if (!match && candidate) match = { id: candidate.id, rule, existing: { ...candidate } };
        };
        if (phone) hit(byPhone.get(phone), 'phone');
        if (gstin) hit(byGstin.get(gstin), 'gstin');
        // A name alone only matches when the row has no phone or GSTIN of
        // its own: two different "Ramesh"es with two different numbers are
        // two people, and merging them would mix their khatas.
        if (!phone && !gstin && name) hit(byName.get(name.toLowerCase()), 'name');

        const dedupeKeys = [
          ...(phone ? [`phone:${phone}`] : []),
          ...(gstin ? [`gstin:${gstin}`] : []),
          ...(!phone && !gstin && name ? [`name:${name.toLowerCase()}`] : []),
        ];
        return { rowNo: parsed.rowNo, parsed, match, dedupeKeys };
      });

      return judgeAll(tx, handler, context.jobId, judgements);
    },

    prepareWrite: () => Promise.resolve(null),

    async write(tx, row, context) {
      const values = row.parsed ?? {};
      if (row.action === 'create') {
        const id = randomUUID();
        const common = {
          id,
          name: String(values['name']),
          phone: str(values['phone']),
          email: str(values['email']),
          gstin: str(values['gstin']),
          stateCode: str(values['stateCode']),
          addressLine1: str(values['addressLine1']),
          addressLine2: str(values['addressLine2']),
          city: str(values['city']),
          pincode: str(values['pincode']),
          notes: str(values['notes']),
          // The import file has no country or UIN columns: an imported party is in India and not
          // a UIN holder, the same defaults as creating one in the app (0038 party columns).
          countryCode: 'IN',
          uin: null,
          gstTreatment: null,
        };
        if (customers) {
          await customersRepository.insert(tx, {
            ...common,
            creditLimit: num(values['creditLimit']),
            priceListId: null,
          });
        } else {
          await suppliersRepository.insert(tx, {
            ...common,
            paymentTermsDays: num(values['paymentTermsDays']),
            leadTimeDays: null,
            isActive: true,
          });
        }

        const balance = num(values['openingBalance']);
        if (balance !== null && balance !== 0) {
          const openingDate = str(values['openingDate']);
          // Midnight UTC is 05:30 IST: the same calendar day for the shop.
          const occurredAt = openingDate
            ? `${openingDate}T00:00:00.000Z`
            : new Date().toISOString();
          const entry = {
            entryType: 'opening_balance' as const,
            referenceType: null,
            referenceId: null,
            occurredAt,
            note: 'Opening balance from an import',
            createdBy: context.userId,
          };
          if (customers) {
            // Positive: the customer owes the shop, a debit on their khata.
            await customersRepository.insertLedgerEntries(tx, [
              {
                ...entry,
                customerId: id,
                debit: Math.max(balance, 0),
                credit: Math.max(-balance, 0),
              },
            ]);
          } else {
            // Positive: the shop owes the supplier, a credit on theirs.
            await suppliersRepository.insertLedgerEntries(tx, [
              {
                ...entry,
                supplierId: id,
                debit: Math.max(-balance, 0),
                credit: Math.max(balance, 0),
              },
            ]);
          }
        }
        return;
      }

      if (!row.targetId) return;
      const patch = storedPatch(columns.columns, values, new Set());
      if (customers) await customersRepository.update(tx, row.targetId, patch);
      else await suppliersRepository.update(tx, row.targetId, patch);
    },
  };
  return handler;
}

/** Seeds the job-wide claims, then decides each row of the chunk in file order. */
async function judgeAll(
  tx: Tx,
  handler: KindHandler,
  jobId: string,
  judgements: readonly Judgement[],
): Promise<AnalysedRow[]> {
  const claimedUpdates = new Set(await importsRepository.claimedTargetIds(tx, jobId));
  const claimedCreates = await importsRepository.claimedCreateKeys(
    tx,
    jobId,
    judgements.flatMap((j) => j.dedupeKeys),
  );
  return judgements.map((j) => decide(handler, j, claimedUpdates, claimedCreates));
}

export const customersKind = partyKind('customers');
export const suppliersKind = partyKind('suppliers');

export const KIND_HANDLERS: Readonly<Record<ImportableKind, KindHandler>> = {
  items: itemsKind,
  customers: customersKind,
  suppliers: suppliersKind,
};

export function handlerFor(kind: string): KindHandler {
  const handler = KIND_HANDLERS[kind as ImportableKind];
  if (!handler) throw new Error(`No import handler for kind "${kind}"`);
  return handler;
}
