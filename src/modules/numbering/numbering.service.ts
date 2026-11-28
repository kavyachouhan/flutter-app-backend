import { env } from '../../config/env.js';
import { withReadTransaction, withTransaction, type Tx } from '../../db/tx.js';
import {
  financialYearOf,
  financialYearStarting,
  formatDocumentNumber,
  pickFittingFormat,
  maxSequenceFor,
  remainingInBlock,
  validateSeriesFormat,
  type FinancialYear,
  type SeriesFormat,
} from '../../domain/numbering/series.js';
import {
  cancellationDate,
  groupUnused,
  type UnusedNumber,
  type UnusedRange,
} from '../../domain/numbering/unused.js';
import { requireAuthContext } from '../../lib/context.js';
import { ErrorCode, NotFoundError, UnprocessableError, ValidationError } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { createLogger } from '../../lib/logger.js';
import { accessibleOutletIds, assertOutletAccess } from '../../middleware/authorize.js';
import { recordAudit } from '../audit/audit.js';
import { hasPermission, type Permission } from '../auth/permissions.js';
import { devicesRepository } from '../devices/devices.repository.js';
import { isFeatureEnabled, type Feature } from '../entitlements/entitlements.js';
import { gstr1FiledFor } from '../gst/filing-state.js';
import { outletsRepository } from '../outlets/outlets.repository.js';
import { tenantsRepository } from '../tenants/tenants.repository.js';
import { numberingRepository, type BlockRow, type SeriesRow } from './numbering.repository.js';
import type { CreateSeriesBody, LeaseBody, ListSeriesQuery } from './numbering.schemas.js';

const log = createLogger('numbering');

export function toSeriesFormat(series: SeriesRow): SeriesFormat {
  return {
    prefix: series.prefix,
    outletCode: series.includeOutletCode ? series.outletCode : undefined,
    counterCode: series.includeCounterCode && series.counterCode ? series.counterCode : undefined,
    includeFinancialYear: series.includeFinancialYear,
    padding: series.padding,
    separator: series.separator,
  };
}

/** Everything a device needs to render numbers from this series while offline. */
function seriesView(series: SeriesRow, fy: FinancialYear) {
  return {
    ...series,
    financialYear: fy,
    maxSequence: maxSequenceFor(toSeriesFormat(series), fy, env.DOCUMENT_NUMBER_MAX_LENGTH),
    maxLength: env.DOCUMENT_NUMBER_MAX_LENGTH,
  };
}

export function createSeries(body: CreateSeriesBody) {
  assertOutletAccess(body.outletId);

  return withTransaction(async (tx) => {
    const settings = await tenantsRepository.getSettings(tx);
    const fy = financialYearStarting(body.fyStartYear, settings.fyStartMonth);

    const existing = await numberingRepository.findSeries(tx, body.id);
    if (existing) return seriesView(existing, fy);

    const outlet = await outletsRepository.findOutlet(tx, body.outletId);
    if (!outlet) throw new NotFoundError('Outlet');

    const counter = body.counterId
      ? await outletsRepository.findCounter(tx, body.counterId)
      : undefined;
    if (body.counterId && counter?.outletId !== body.outletId) throw new NotFoundError('Counter');
    if (body.includeCounterCode && !counter) {
      throw new ValidationError('includeCounterCode requires a counter-level series.');
    }

    const format: SeriesFormat = {
      prefix: body.prefix,
      outletCode: body.includeOutletCode ? outlet.code : undefined,
      counterCode: body.includeCounterCode ? counter?.code : undefined,
      includeFinancialYear: body.includeFinancialYear,
      padding: body.padding,
      separator: body.separator,
    };
    validateSeriesFormat(format, fy, {
      maxLength: env.DOCUMENT_NUMBER_MAX_LENGTH,
      minSequenceHeadroom: env.DOCUMENT_SEQUENCE_MIN_HEADROOM,
    });
    if (body.startingSequence > maxSequenceFor(format, fy, env.DOCUMENT_NUMBER_MAX_LENGTH)) {
      throw new ValidationError('The starting sequence is beyond what this format can print.');
    }

    await numberingRepository.insertSeries(tx, {
      id: body.id,
      outletId: body.outletId,
      counterId: body.counterId,
      documentType: body.documentType,
      fyStartYear: body.fyStartYear,
      prefix: body.prefix,
      includeOutletCode: body.includeOutletCode,
      includeCounterCode: body.includeCounterCode,
      includeFinancialYear: body.includeFinancialYear,
      padding: body.padding,
      separator: body.separator,
      nextSeq: body.startingSequence,
    });
    await recordAudit(tx, {
      action: 'series.created',
      entityType: 'document_series',
      entityId: body.id,
    });

    const series = await numberingRepository.findSeries(tx, body.id);
    if (!series) throw new NotFoundError('Series');
    return seriesView(series, fy);
  });
}

export function listSeries(query: ListSeriesQuery) {
  if (query.outletId) assertOutletAccess(query.outletId);
  return withReadTransaction(async (tx) => {
    const settings = await tenantsRepository.getSettings(tx);
    const rows = await numberingRepository.listSeries(tx, query, accessibleOutletIds());
    return rows.map((row) =>
      seriesView(row, financialYearStarting(row.fyStartYear, settings.fyStartMonth)),
    );
  });
}

/**
 * Reserves the next contiguous range of a (row-locked) series for a device.
 * Concurrent leases are handed consecutive, non-overlapping blocks; the
 * exclusion constraint on number_blocks backs this up in the database.
 * Returns undefined when the series has printed every number its format allows.
 */
async function leaseInTx(
  tx: Tx,
  series: SeriesRow,
  fy: FinancialYear,
  deviceId: string,
  requestedSize: number | undefined,
): Promise<BlockRow | undefined> {
  const ceiling = maxSequenceFor(toSeriesFormat(series), fy, env.DOCUMENT_NUMBER_MAX_LENGTH);
  if (series.nextSeq > ceiling) return undefined;

  const size = Math.min(requestedSize ?? env.NUMBER_BLOCK_SIZE_DEFAULT, env.NUMBER_BLOCK_SIZE_MAX);
  const endSeq = Math.min(series.nextSeq + size - 1, ceiling);

  const block = await numberingRepository.insertBlock(tx, {
    id: newId(),
    seriesId: series.id,
    deviceId,
    startSeq: series.nextSeq,
    endSeq,
    ttlHours: env.NUMBER_BLOCK_TTL_HOURS,
  });
  await numberingRepository.setNextSeq(tx, series.id, endSeq + 1);
  return block;
}

export function leaseBlock(seriesId: string, body: LeaseBody) {
  const auth = requireAuthContext();

  return withTransaction(async (tx) => {
    const series = await numberingRepository.findSeries(tx, seriesId, true);
    if (!series) throw new NotFoundError('Series');
    assertOutletAccess(series.outletId);
    if (!series.isActive) throw new UnprocessableError('This series is inactive.');

    const settings = await tenantsRepository.getSettings(tx);
    const fy = financialYearStarting(series.fyStartYear, settings.fyStartMonth);
    const block = await leaseInTx(tx, series, fy, auth.deviceId, body.blockSize);
    if (!block) {
      throw new UnprocessableError(
        'This series has used every number its format can print. Create a new series.',
        ErrorCode.NUMBER_BLOCK_EXHAUSTED,
      );
    }
    return { block, series: seriesView(series, fy) };
  });
}

export function listMyLeases() {
  const auth = requireAuthContext();
  return withReadTransaction((tx) => numberingRepository.listLiveBlocks(tx, auth.deviceId));
}

/**
 * Reserved numbers of a series that no document used and that are not yet
 * declared cancelled, as ranges, each saying whether it can be declared now:
 * `cancellable`, `in_use` (a live block still being billed from) or
 * `device_offline` (the block expired but its device has not been online since,
 * so it may hold bills not yet sent).
 */
export function listGaps(seriesId: string): Promise<UnusedRange[]> {
  return withReadTransaction(async (tx) => {
    const series = await numberingRepository.findSeries(tx, seriesId);
    if (!series) throw new NotFoundError('Series');
    assertOutletAccess(series.outletId);
    return groupUnused(await numberingRepository.unusedNumbers(tx, seriesId));
  });
}

export interface SeriesCancellation {
  seriesId: string;
  /** Ranges declared cancelled by this call. */
  cancelled: UnusedRange[];
  /** Ranges that must wait (in use, or the device has not been online since). */
  waiting: UnusedRange[];
}

/**
 * Declares a series' cancellable unused numbers cancelled, in the caller's
 * transaction. Locks the series (one declaration at a time per series), then
 * the blocks involved (the lock an upload takes before using a number), then
 * reads which numbers are unused, so a document that committed first is seen
 * and its number is left alone; one that comes after is refused.
 *
 * `onlyDeviceId` limits it to one device's blocks (a device being removed).
 */
async function cancelInSeries(
  tx: Tx,
  seriesId: string,
  reason: 'device_removed' | 'unused_block',
  onlyDeviceId?: string,
): Promise<SeriesCancellation | undefined> {
  const series = await numberingRepository.findSeries(tx, seriesId, true);
  if (!series) return undefined;

  const candidates = await numberingRepository.unusedNumbers(tx, seriesId, onlyDeviceId);
  const blockIds = [
    ...new Set(candidates.filter((n) => n.status === 'cancellable').map((n) => n.blockId)),
  ];
  await numberingRepository.lockBlocks(tx, blockIds);

  // Re-read under the locks: what is unused now is what may be declared.
  const unused = blockIds.length
    ? await numberingRepository.unusedNumbers(tx, seriesId, onlyDeviceId)
    : candidates;
  const cancellable = unused.filter((n) => n.status === 'cancellable');
  const waiting = groupUnused(unused.filter((n) => n.status !== 'cancellable'));
  if (cancellable.length === 0) return { seriesId, cancelled: [], waiting };

  const settings = await tenantsRepository.getSettings(tx);
  const fy = financialYearStarting(series.fyStartYear, settings.fyStartMonth);
  const format = toSeriesFormat(series);
  const facts = await numberingRepository.seriesGstFacts(tx, seriesId);
  const gstin = await numberingRepository.gstinOf(tx, facts?.registrationId ?? null);
  const today = await numberingRepository.businessToday(tx);

  const dayOfBlock = new Map<string, string>();
  for (const b of await numberingRepository.blockDates(
    tx,
    seriesId,
    cancellable.map((n) => n.blockId).filter((id, i, all) => all.indexOf(id) === i),
  )) {
    const base = b.lastDocumentDate ?? b.leasedOn;
    dayOfBlock.set(
      b.blockId,
      cancellationDate({
        lastDocumentDate: b.lastDocumentDate,
        leasedOn: b.leasedOn,
        today,
        periodFiled: await gstr1FiledFor(tx, gstin, base),
      }),
    );
  }

  let createdBy: string | null = null;
  try {
    createdBy = requireAuthContext().userId;
  } catch {
    createdBy = null;
  }

  await numberingRepository.insertCancelledNumbers(
    tx,
    cancellable.map((n: UnusedNumber) => ({
      id: newId(),
      seriesId,
      blockId: n.blockId,
      sequenceNo: n.seq,
      documentNumber: formatDocumentNumber(format, fy, n.seq, env.DOCUMENT_NUMBER_MAX_LENGTH),
      seriesFamily: facts?.seriesFamily ?? 'non_gst',
      registrationId: facts?.registrationId ?? null,
      cancelledOn: dayOfBlock.get(n.blockId) ?? today,
      reason,
      createdBy,
    })),
  );

  const cancelled = groupUnused(cancellable);
  await recordAudit(tx, {
    action: 'series.numbers_cancelled',
    entityType: 'document_series',
    entityId: seriesId,
    metadata: {
      reason,
      ...(onlyDeviceId ? { deviceId: onlyDeviceId } : {}),
      count: cancellable.length,
      ranges: cancelled.map((r) => ({ from: r.from, to: r.to })),
    },
  });
  log.info({ seriesId, reason, count: cancellable.length }, 'Declared unused numbers cancelled');
  return { seriesId, cancelled, waiting };
}

/**
 * Declares cancelled every unused number that nothing can still be issued
 * under, in one series or in every series the caller can see, so GSTR-1
 * Table 13 accounts for them instead of reporting a gap. Numbers that must
 * still wait are returned, with why. Each series is its own transaction, so a
 * large business does not hold every block lock at once.
 */
export async function cancelUnusedNumbers(input: { seriesId?: string }) {
  const seriesIds = await withReadTransaction(async (tx) => {
    if (input.seriesId) {
      const series = await numberingRepository.findSeries(tx, input.seriesId);
      if (!series) throw new NotFoundError('Series');
      assertOutletAccess(series.outletId);
      return [series.id];
    }
    return numberingRepository.seriesWithBlocks(tx, accessibleOutletIds());
  });

  const series: SeriesCancellation[] = [];
  for (const id of seriesIds) {
    const result = await withTransaction((tx) => cancelInSeries(tx, id, 'unused_block'));
    if (result && (result.cancelled.length > 0 || result.waiting.length > 0)) series.push(result);
  }
  const count = (ranges: UnusedRange[]) => ranges.reduce((n, r) => n + r.count, 0);
  return {
    cancelled: series.reduce((n, s) => n + count(s.cancelled), 0),
    waiting: series.reduce((n, s) => n + count(s.waiting), 0),
    series,
  };
}

/**
 * A removed device will never sync again, so nothing more can be issued from
 * its blocks: they stop being live, and their unused numbers are declared
 * cancelled, in the caller's (deactivation) transaction.
 */
export async function cancelNumbersOfRemovedDevice(tx: Tx, deviceId: string): Promise<number> {
  await numberingRepository.expireBlocksOfDevice(tx, deviceId);
  let total = 0;
  for (const seriesId of await numberingRepository.seriesOfDevice(tx, deviceId)) {
    const result = await cancelInSeries(tx, seriesId, 'device_removed', deviceId);
    total += result?.cancelled.reduce((n, r) => n + r.count, 0) ?? 0;
  }
  return total;
}

// --- Offline continuity: top-ups and financial-year rollover -----------------

export interface TopUpOptions {
  /** Lease a fresh block when a device holds fewer numbers than this for a series. */
  threshold: number;
  /** Days before the FY ends at which next year's series is created and pre-leased. */
  rolloverLeadDays: number;
  now: Date;
}

/**
 * The successor of `series` in the next financial year: same scope and format,
 * starting at 1. Created only once; the scope unique index makes a race a
 * DUPLICATE conflict, which the caller treats as "already exists".
 */
async function ensureSuccessorSeries(tx: Tx, series: SeriesRow): Promise<SeriesRow | undefined> {
  const scope = {
    outletId: series.outletId,
    counterId: series.counterId,
    documentType: series.documentType,
    fyStartYear: series.fyStartYear + 1,
  };
  const existing = await numberingRepository.findSeriesByScope(tx, scope);
  if (existing) return existing;

  const id = newId();
  await numberingRepository.insertSeries(tx, {
    id,
    ...scope,
    prefix: series.prefix,
    includeOutletCode: series.includeOutletCode,
    includeCounterCode: series.includeCounterCode,
    includeFinancialYear: series.includeFinancialYear,
    padding: series.padding,
    separator: series.separator,
    nextSeq: 1,
  });
  await recordAudit(tx, {
    action: 'series.rolled_over',
    entityType: 'document_series',
    entityId: id,
    metadata: { predecessorId: series.id, fyStartYear: scope.fyStartYear },
  });
  log.info({ seriesId: series.id, successorId: id }, 'Created next financial-year series');
  return numberingRepository.findSeries(tx, id, true);
}

/**
 * Document types a till issues itself, and the prefix each gets when the shop
 * has not set one up.
 *
 * Keyed documents provision their series on first use (see
 * `purchases/numbering.ts`); a leased one cannot, because the device needs
 * both the series and a block on it *before* it goes offline. So these are
 * provisioned on first pull instead. Credit notes matter most here: a return
 * is a legal obligation, and until this existed a shop could not issue its
 * first one without hand-creating a series it had no reason to know about.
 */
const BOOTSTRAP_SERIES: Record<LeasedDocumentType, string> = {
  invoice: 'INV',
  credit_note: 'CN',
  sales_debit_note: 'SDN',
  financial_credit_note: 'FCN',
  estimate: 'EST',
  proforma_invoice: 'PI',
  sales_order: 'SO',
  purchase_order: 'PO',
  purchase_bill: 'PB',
  debit_note: 'DN',
};

/**
 * Estimates, proforma invoices, sales orders and purchase orders can also be made offline, so a device holds
 * blocks for them too. Unlike an invoice, though, they are not for every plan or every
 * role: a block leased to a device that may not use it would just sit there. A device is
 * leased one only when its plan includes the feature and its user may create the document.
 */
const LEASE_REQUIREMENTS: Partial<
  Record<LeasedDocumentType, { feature: Feature; permission: Permission }>
> = {
  estimate: { feature: 'sales_orders', permission: 'estimates:create' },
  proforma_invoice: { feature: 'sales_orders', permission: 'proforma_invoices:create' },
  sales_order: { feature: 'sales_orders', permission: 'sales_orders:create' },
  purchase_order: { feature: 'purchases', permission: 'purchases:create' },
  purchase_bill: { feature: 'purchases', permission: 'purchases:create' },
  debit_note: { feature: 'purchases', permission: 'debit_notes:create' },
};

type LeasedDocumentType =
  | 'invoice'
  | 'credit_note'
  | 'sales_debit_note'
  | 'financial_credit_note'
  | 'estimate'
  | 'proforma_invoice'
  | 'sales_order'
  | 'purchase_order'
  | 'purchase_bill'
  | 'debit_note';

async function mayLease(tx: Tx, documentType: LeasedDocumentType): Promise<boolean> {
  const need = LEASE_REQUIREMENTS[documentType];
  if (!need) return true;
  let role;
  try {
    role = requireAuthContext().role;
  } catch {
    return false;
  }
  return hasPermission(role, need.permission) && (await isFeatureEnabled(tx, need.feature));
}

/**
 * Makes sure the outlet has a live series for `documentType` in this financial
 * year, creating an outlet-scoped one if it has none.
 *
 * Deliberately a no-op when any series already issues this type for the
 * outlet, including a per-counter one: a shop that chose counter-wise
 * numbering must not find an outlet-wide series appearing beside it.
 */
async function ensureBootstrapSeries(
  tx: Tx,
  outletId: string,
  documentType: keyof typeof BOOTSTRAP_SERIES,
  fyStartYear: number,
): Promise<SeriesRow | undefined> {
  const existing = await numberingRepository.findSeriesForDocumentType(
    tx,
    outletId,
    documentType,
    fyStartYear,
  );
  if (existing) return numberingRepository.findSeries(tx, existing.id, true);

  const outlet = await outletsRepository.findOutlet(tx, outletId);
  // Only a shop with more than one outlet needs the outlet code in its
  // numbers, and including it costs characters that the 16-character legal
  // limit does not have to spare. A single-branch shop gets INV/26-27/0001.
  const outlets = await outletsRepository.listOutlets(tx, null);
  const format = pickFittingFormat(
    {
      prefix: BOOTSTRAP_SERIES[documentType],
      outletCode: outlets.length > 1 ? (outlet?.code ?? undefined) : undefined,
      includeFinancialYear: true,
      padding: 4,
      separator: '/',
    },
    financialYearStarting(fyStartYear, (await tenantsRepository.getSettings(tx)).fyStartMonth),
    {
      maxLength: env.DOCUMENT_NUMBER_MAX_LENGTH,
      minSequenceHeadroom: env.DOCUMENT_SEQUENCE_MIN_HEADROOM,
    },
  );

  const id = newId();
  await numberingRepository.insertSeries(tx, {
    id,
    outletId,
    counterId: null,
    documentType,
    fyStartYear,
    prefix: format.prefix,
    includeOutletCode: format.outletCode !== undefined,
    includeCounterCode: false,
    includeFinancialYear: format.includeFinancialYear,
    padding: format.padding,
    separator: format.separator,
    nextSeq: 1,
  });
  await recordAudit(tx, {
    action: 'series.provisioned',
    entityType: 'document_series',
    entityId: id,
    metadata: { outletId, documentType, fyStartYear },
  });
  log.info({ seriesId: id, outletId, documentType }, 'Provisioned a document series on first pull');
  return numberingRepository.findSeries(tx, id, true);
}

/**
 * Leases the device its first block on each series a till must be able to
 * issue from, so a freshly registered device can bill and take returns
 * offline without a numbering setup step.
 */
async function bootstrapLeases(
  tx: Tx,
  deviceId: string,
  fyStartMonth: number,
  live: readonly BlockRow[],
): Promise<BlockRow[]> {
  // A device onboarded moments ago has no outlet binding: onboarding creates
  // the device and the outlet in one transaction and does not link them. So
  // fall back to the default outlet, which is the only one a single-branch
  // shop has — without this the bootstrap silently does nothing in exactly
  // the case it exists for.
  const device = await devicesRepository.findById(tx, deviceId);
  const outletId = device?.outletId ?? (await outletsRepository.findDefaultOutlet(tx))?.id;
  if (!outletId) return [];

  const fy = financialYearOf(businessDateOf(new Date()), fyStartMonth);

  // Keyed on the document type, not the series id: a shop numbering per
  // counter has several invoice series, and a device holding a block on any
  // of them can already bill. Matching on ids would lease it a second one.
  const held = new Set<string>();
  for (const block of live) {
    const series = await numberingRepository.findSeries(tx, block.seriesId);
    if (series && series.fyStartYear === fy.startYear) held.add(series.documentType);
  }

  const leased: BlockRow[] = [];
  for (const documentType of Object.keys(BOOTSTRAP_SERIES) as (keyof typeof BOOTSTRAP_SERIES)[]) {
    if (held.has(documentType)) continue;
    if (!(await mayLease(tx, documentType))) continue;
    const series = await ensureBootstrapSeries(tx, outletId, documentType, fy.startYear);
    if (!series) continue;
    const block = await leaseInTx(tx, series, fy, deviceId, undefined);
    if (block) leased.push(block);
  }
  return leased;
}

/** Today in UTC, as the date string the financial-year helpers take. */
function businessDateOf(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Called from every pull. Makes sure the device holds a block on each series a
 * till issues from; for each series it is already issuing from, leases a fresh
 * block when the remaining numbers fall below the threshold; and in the last
 * weeks of the financial year makes sure next year's series exists and the
 * device holds a block on it — so a till that goes offline on 31 March still
 * bills legally on 1 April.
 */
export async function topUpLeasesForDevice(
  tx: Tx,
  deviceId: string,
  options: TopUpOptions,
): Promise<BlockRow[]> {
  const settings = await tenantsRepository.getSettings(tx);
  const live = await numberingRepository.listLiveBlocks(tx, deviceId);

  const bootstrapped = await bootstrapLeases(tx, deviceId, settings.fyStartMonth, live);
  if (live.length === 0) return bootstrapped;

  const remainingBySeries = new Map<string, number>();
  for (const block of live) {
    remainingBySeries.set(
      block.seriesId,
      (remainingBySeries.get(block.seriesId) ?? 0) + remainingInBlock(block),
    );
  }

  const leased: BlockRow[] = [...bootstrapped];
  const leadMs = options.rolloverLeadDays * 24 * 60 * 60 * 1000;

  for (const [seriesId, remaining] of remainingBySeries) {
    const series = await numberingRepository.findSeries(tx, seriesId, true);
    if (!series?.isActive) continue;
    const fy = financialYearStarting(series.fyStartYear, settings.fyStartMonth);

    if (remaining < options.threshold) {
      const block = await leaseInTx(tx, series, fy, deviceId, undefined);
      if (block) leased.push(block);
    }

    // Successor handling: within the lead window of this series' FY end, and
    // only when the device does not already hold a block on the successor.
    const fyEnd = new Date(`${fy.endDate}T23:59:59.999Z`).getTime();
    if (fyEnd - options.now.getTime() <= leadMs && fyEnd >= options.now.getTime()) {
      const successor = await ensureSuccessorSeries(tx, series);
      if (successor && !remainingBySeries.has(successor.id)) {
        const nextFy = financialYearStarting(successor.fyStartYear, settings.fyStartMonth);
        const block = await leaseInTx(tx, successor, nextFy, deviceId, undefined);
        if (block) leased.push(block);
      }
    }
  }
  return leased;
}
