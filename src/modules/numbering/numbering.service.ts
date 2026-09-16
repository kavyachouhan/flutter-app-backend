import { env } from '../../config/env.js';
import { withReadTransaction, withTransaction } from '../../db/tx.js';
import {
  financialYearStarting,
  maxSequenceFor,
  validateSeriesFormat,
  type FinancialYear,
  type SeriesFormat,
} from '../../domain/numbering/series.js';
import { requireAuthContext } from '../../lib/context.js';
import { ErrorCode, NotFoundError, UnprocessableError, ValidationError } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { accessibleOutletIds, assertOutletAccess } from '../../middleware/authorize.js';
import { recordAudit } from '../audit/audit.js';
import { outletsRepository } from '../outlets/outlets.repository.js';
import { tenantsRepository } from '../tenants/tenants.repository.js';
import { numberingRepository, type SeriesRow } from './numbering.repository.js';
import type { CreateSeriesBody, LeaseBody, ListSeriesQuery } from './numbering.schemas.js';

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
 * Reserves the next contiguous range for the calling device. The series row is
 * locked, so concurrent leases are handed consecutive, non-overlapping blocks;
 * the exclusion constraint on number_blocks backs this up in the database.
 */
export function leaseBlock(seriesId: string, body: LeaseBody) {
  const auth = requireAuthContext();

  return withTransaction(async (tx) => {
    const series = await numberingRepository.findSeries(tx, seriesId, true);
    if (!series) throw new NotFoundError('Series');
    assertOutletAccess(series.outletId);
    if (!series.isActive) throw new UnprocessableError('This series is inactive.');

    const settings = await tenantsRepository.getSettings(tx);
    const fy = financialYearStarting(series.fyStartYear, settings.fyStartMonth);
    const ceiling = maxSequenceFor(toSeriesFormat(series), fy, env.DOCUMENT_NUMBER_MAX_LENGTH);
    if (series.nextSeq > ceiling) {
      throw new UnprocessableError(
        'This series has used every number its format can print. Create a new series.',
        ErrorCode.NUMBER_BLOCK_EXHAUSTED,
      );
    }

    const size = Math.min(
      body.blockSize ?? env.NUMBER_BLOCK_SIZE_DEFAULT,
      env.NUMBER_BLOCK_SIZE_MAX,
    );
    const endSeq = Math.min(series.nextSeq + size - 1, ceiling);

    const block = await numberingRepository.insertBlock(tx, {
      id: newId(),
      seriesId,
      deviceId: auth.deviceId,
      startSeq: series.nextSeq,
      endSeq,
      ttlHours: env.NUMBER_BLOCK_TTL_HOURS,
    });
    await numberingRepository.setNextSeq(tx, seriesId, endSeq + 1);

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
    // Only invoices are issued so far; other document types have no table to check against yet.
    if (series.documentType !== 'invoice') {
      throw new UnprocessableError('Gap reporting is available for invoice series only.');
    }
    return numberingRepository.findInvoiceGaps(tx, seriesId);
  });
}
