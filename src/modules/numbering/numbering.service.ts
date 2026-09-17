import { env } from '../../config/env.js';
import { withReadTransaction, withTransaction, type Tx } from '../../db/tx.js';
import {
  financialYearStarting,
  maxSequenceFor,
  remainingInBlock,
  validateSeriesFormat,
  type FinancialYear,
  type SeriesFormat,
} from '../../domain/numbering/series.js';
import { requireAuthContext } from '../../lib/context.js';
import { ErrorCode, NotFoundError, UnprocessableError, ValidationError } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { createLogger } from '../../lib/logger.js';
import { accessibleOutletIds, assertOutletAccess } from '../../middleware/authorize.js';
import { recordAudit } from '../audit/audit.js';
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

/** Declared in GSTR-1 Table 13 as cancelled or unused numbers. */
export function listGaps(seriesId: string) {
  return withReadTransaction(async (tx) => {
    const series = await numberingRepository.findSeries(tx, seriesId);
    if (!series) throw new NotFoundError('Series');
    assertOutletAccess(series.outletId);
    return numberingRepository.findGaps(tx, seriesId);
  });
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
 * Called from every pull. For each series the device is issuing from, leases a
 * fresh block when the remaining numbers fall below the threshold, and in the
 * last weeks of the financial year makes sure next year's series exists and
 * the device holds a block on it — so a till that goes offline on 31 March
 * still bills legally on 1 April.
 */
export async function topUpLeasesForDevice(
  tx: Tx,
  deviceId: string,
  options: TopUpOptions,
): Promise<BlockRow[]> {
  const live = await numberingRepository.listLiveBlocks(tx, deviceId);
  if (live.length === 0) return [];

  const settings = await tenantsRepository.getSettings(tx);
  const remainingBySeries = new Map<string, number>();
  for (const block of live) {
    remainingBySeries.set(
      block.seriesId,
      (remainingBySeries.get(block.seriesId) ?? 0) + remainingInBlock(block),
    );
  }

  const leased: BlockRow[] = [];
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
