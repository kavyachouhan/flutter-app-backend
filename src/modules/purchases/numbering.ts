/**
 * Numbering for documents the shop keys in rather than issues from a till.
 *
 * Sales invoices lease blocks to devices so a till can number a bill
 * offline. Purchases, debit notes, purchase orders and delivery challans are
 * entered on a connected screen, so they take their number from the series
 * directly.
 *
 * A series is provisioned on first use. Requiring a shopkeeper to configure
 * numbering before they can enter their first purchase bill would be a
 * setup step with no decision in it — the default prefix is fine, and the
 * numbering module is still there to change it afterwards.
 */
import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import type { Tx } from '../../db/tx.js';
import { requireAuthContext } from '../../lib/context.js';
import { ErrorCode, UnprocessableError, ValidationError } from '../../lib/errors.js';
import {
  financialYearOf,
  financialYearStarting,
  formatDocumentNumber,
  pickFittingFormat,
} from '../../domain/numbering/series.js';
import { outletsRepository } from '../outlets/outlets.repository.js';
import { tenantsRepository } from '../tenants/tenants.repository.js';
import { numberingRepository, type SeriesRow } from '../numbering/numbering.repository.js';
import { toSeriesFormat } from '../numbering/numbering.service.js';

export type KeyedDocumentType = 'purchase_bill' | 'debit_note' | 'purchase_order' | 'sales_order' | 'delivery_challan' | 'estimate' | 'proforma_invoice';

const DEFAULT_PREFIX: Record<KeyedDocumentType, string> = {
  purchase_bill: 'PB',
  debit_note: 'DN',
  purchase_order: 'PO',
  delivery_challan: 'DC',
  sales_order: 'SO',
  estimate: 'EST',
  proforma_invoice: 'PI',
};

async function ensureSeries(
  tx: Tx,
  outletId: string,
  documentType: KeyedDocumentType,
  fyStartYear: number,
): Promise<SeriesRow> {
  const existing = await numberingRepository.findSeriesByScope(tx, {
    outletId,
    counterId: null,
    documentType,
    fyStartYear,
  });
  if (existing) return existing;

  const outlet = await outletsRepository.findOutlet(tx, outletId);
  // The outlet code only earns its characters when there is a second branch to
  // distinguish, and the 16-character legal limit has none to spare:
  // PB/MAIN/26-27/0001 is eighteen. `pickFittingFormat` drops segments in the
  // order that keeps numbers unique for longest.
  const outlets = await outletsRepository.listOutlets(tx, null);
  const settings = await tenantsRepository.getSettings(tx);
  const format = pickFittingFormat(
    {
      prefix: DEFAULT_PREFIX[documentType],
      outletCode: outlets.length > 1 ? (outlet?.code ?? undefined) : undefined,
      includeFinancialYear: true,
      padding: 4,
      separator: '/',
    },
    financialYearStarting(fyStartYear, settings.fyStartMonth),
    {
      maxLength: env.DOCUMENT_NUMBER_MAX_LENGTH,
      minSequenceHeadroom: env.DOCUMENT_SEQUENCE_MIN_HEADROOM,
    },
  );

  const id = randomUUID();
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

  const created = await numberingRepository.findSeries(tx, id);
  if (!created) throw new Error('series insert returned no row');
  return created;
}

export interface AllocatedNumber {
  readonly seriesId: string;
  readonly sequenceNo: number;
  readonly documentNumber: string;
  readonly fyStartYear: number;
}

/**
 * Allocates the next number for a keyed document.
 *
 * `documentDate` decides the financial year, so a bill dated in March takes
 * a number from that year's series even if it is entered in April.
 */
export async function allocateNumber(
  tx: Tx,
  input: {
    outletId: string;
    documentType: KeyedDocumentType;
    documentDate: string;
    fyStartMonth: number;
    seriesId?: string | undefined;
  },
): Promise<AllocatedNumber> {
  const fy = financialYearOf(input.documentDate, input.fyStartMonth);

  const series = input.seriesId
    ? await numberingRepository.findSeries(tx, input.seriesId)
    : await ensureSeries(tx, input.outletId, input.documentType, fy.startYear);

  if (!series) throw new Error('series not found');

  const sequenceNo = await numberingRepository.allocateSequence(tx, series.id);
  return {
    seriesId: series.id,
    sequenceNo,
    documentNumber: formatDocumentNumber(
      toSeriesFormat(series),
      fy,
      sequenceNo,
      env.DOCUMENT_NUMBER_MAX_LENGTH,
    ),
    fyStartYear: fy.startYear,
  };
}

/**
 * The number for a keyed document, from one of two places.
 *
 * Online, the server takes the next one off the series (`allocateNumber`). A device that
 * made the document offline already numbered it from a block leased to it, exactly as an
 * invoice is numbered: the document names the series and the sequence it used, and that
 * must be a number this device was actually leased and has not used (`NUMBER_NOT_LEASED`
 * otherwise). Either way the number is final the moment the document exists.
 *
 * A request naming only one of `seriesId` and `sequenceNo` is a mistake, not a choice.
 */
export async function numberForDocument(
  tx: Tx,
  input: {
    outletId: string;
    documentType: KeyedDocumentType;
    documentDate: string;
    fyStartMonth: number;
    seriesId?: string | undefined;
    sequenceNo?: number | undefined;
  },
): Promise<AllocatedNumber> {
  const { seriesId, sequenceNo } = input;
  if (seriesId === undefined && sequenceNo === undefined) return allocateNumber(tx, input);
  if (seriesId === undefined || sequenceNo === undefined) {
    throw new ValidationError('seriesId and sequenceNo go together.', {
      details: { field: seriesId === undefined ? 'seriesId' : 'sequenceNo' },
    });
  }

  const auth = requireAuthContext();
  const series = await numberingRepository.findSeries(tx, seriesId);
  if (!series || series.outletId !== input.outletId || series.documentType !== input.documentType) {
    throw new UnprocessableError(
      `The series is not a ${input.documentType.replace('_', ' ')} series for this outlet.`,
    );
  }
  const fy = financialYearOf(input.documentDate, input.fyStartMonth);
  if (fy.startYear !== series.fyStartYear) {
    throw new UnprocessableError('The document date falls outside the series financial year.');
  }

  const block = await numberingRepository.lockBlockForSequence(
    tx,
    series.id,
    auth.deviceId,
    sequenceNo,
  );
  if (!block) {
    throw new UnprocessableError(
      `Sequence ${sequenceNo} is not leased to this device.`,
      ErrorCode.NUMBER_NOT_LEASED,
    );
  }
  await numberingRepository.markConsumed(tx, block.id, sequenceNo);

  return {
    seriesId: series.id,
    sequenceNo,
    documentNumber: formatDocumentNumber(
      toSeriesFormat(series),
      fy,
      sequenceNo,
      env.DOCUMENT_NUMBER_MAX_LENGTH,
    ),
    fyStartYear: fy.startYear,
  };
}
