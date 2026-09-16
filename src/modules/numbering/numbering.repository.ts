import type { Tx } from '../../db/tx.js';
import type { SequenceRange } from '../../domain/numbering/series.js';
import type { DocumentType, ListSeriesQuery } from './numbering.schemas.js';

export interface SeriesRow {
  id: string;
  outletId: string;
  counterId: string | null;
  documentType: DocumentType;
  fyStartYear: number;
  prefix: string;
  includeOutletCode: boolean;
  includeCounterCode: boolean;
  includeFinancialYear: boolean;
  padding: number;
  separator: string;
  nextSeq: number;
  isActive: boolean;
  outletCode: string;
  counterCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BlockRow {
  id: string;
  seriesId: string;
  deviceId: string;
  startSeq: number;
  endSeq: number;
  consumedUpTo: number | null;
  expiresAt: Date;
}

export type NewSeries = Omit<
  SeriesRow,
  'isActive' | 'outletCode' | 'counterCode' | 'createdAt' | 'updatedAt'
>;

const SERIES_COLUMNS = `
  s.id, s.outlet_id AS "outletId", s.counter_id AS "counterId", s.document_type AS "documentType",
  s.fy_start_year AS "fyStartYear", s.prefix, s.include_outlet_code AS "includeOutletCode",
  s.include_counter_code AS "includeCounterCode", s.include_financial_year AS "includeFinancialYear",
  s.padding, s.separator, s.next_seq AS "nextSeq", s.is_active AS "isActive",
  o.code AS "outletCode", c.code AS "counterCode", s.created_at AS "createdAt", s.updated_at AS "updatedAt"`;

const SERIES_FROM = `
  FROM document_series s
  JOIN outlets o ON o.id = s.outlet_id
  LEFT JOIN counters c ON c.id = s.counter_id`;

const BLOCK_COLUMNS = `
  id, series_id AS "seriesId", device_id AS "deviceId", start_seq AS "startSeq", end_seq AS "endSeq",
  consumed_up_to AS "consumedUpTo", expires_at AS "expiresAt"`;

export const numberingRepository = {
  findSeries(tx: Tx, id: string, forUpdate = false): Promise<SeriesRow | undefined> {
    return tx.one<SeriesRow>(
      `SELECT ${SERIES_COLUMNS} ${SERIES_FROM} WHERE s.id = $1 AND s.deleted_at IS NULL ${forUpdate ? 'FOR UPDATE OF s' : ''}`,
      [id],
    );
  },

  listSeries(
    tx: Tx,
    filter: ListSeriesQuery,
    restrictTo: readonly string[] | null,
  ): Promise<SeriesRow[]> {
    return tx.many<SeriesRow>(
      `SELECT ${SERIES_COLUMNS} ${SERIES_FROM}
       WHERE s.deleted_at IS NULL
         AND ($1::uuid IS NULL OR s.outlet_id = $1)
         AND ($2::uuid IS NULL OR s.counter_id = $2)
         AND ($3::text IS NULL OR s.document_type = $3)
         AND ($4::int IS NULL OR s.fy_start_year = $4)
         AND ($5::uuid[] IS NULL OR s.outlet_id = ANY($5::uuid[]))
       ORDER BY s.fy_start_year DESC, o.code, c.code NULLS FIRST, s.document_type`,
      [
        filter.outletId ?? null,
        filter.counterId ?? null,
        filter.documentType ?? null,
        filter.fyStartYear ?? null,
        restrictTo ? [...restrictTo] : null,
      ],
    );
  },

  async insertSeries(tx: Tx, s: NewSeries): Promise<void> {
    await tx.query(
      `INSERT INTO document_series (id, tenant_id, outlet_id, counter_id, document_type, fy_start_year, prefix,
         include_outlet_code, include_counter_code, include_financial_year, padding, separator, next_seq, is_active)
       VALUES ($1, app.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true)`,
      [
        s.id,
        s.outletId,
        s.counterId,
        s.documentType,
        s.fyStartYear,
        s.prefix,
        s.includeOutletCode,
        s.includeCounterCode,
        s.includeFinancialYear,
        s.padding,
        s.separator,
        s.nextSeq,
      ],
    );
  },

  async setNextSeq(tx: Tx, id: string, nextSeq: number): Promise<void> {
    await tx.query('UPDATE document_series SET next_seq = $2 WHERE id = $1', [id, nextSeq]);
  },

  async insertBlock(
    tx: Tx,
    b: {
      id: string;
      seriesId: string;
      deviceId: string;
      startSeq: number;
      endSeq: number;
      ttlHours: number;
    },
  ): Promise<BlockRow> {
    const row = await tx.one<BlockRow>(
      `INSERT INTO number_blocks (id, tenant_id, series_id, device_id, start_seq, end_seq, expires_at)
       VALUES ($1, app.current_tenant_id(), $2, $3, $4, $5, now() + make_interval(hours => $6::int))
       RETURNING ${BLOCK_COLUMNS}`,
      [b.id, b.seriesId, b.deviceId, b.startSeq, b.endSeq, b.ttlHours],
    );
    if (!row) throw new Error('number block insert returned no row');
    return row;
  },

  /** The row lock serialises two uploads using numbers from the same block. */
  lockBlockForSequence(
    tx: Tx,
    seriesId: string,
    deviceId: string,
    sequenceNo: number,
  ): Promise<BlockRow | undefined> {
    return tx.one<BlockRow>(
      `SELECT ${BLOCK_COLUMNS} FROM number_blocks
       WHERE series_id = $1 AND device_id = $2 AND $3 BETWEEN start_seq AND end_seq
       FOR UPDATE`,
      [seriesId, deviceId, sequenceNo],
    );
  },

  // GREATEST ignores NULL, so the first consumption simply records the number.
  async markConsumed(tx: Tx, blockId: string, sequenceNo: number): Promise<void> {
    await tx.query(
      'UPDATE number_blocks SET consumed_up_to = GREATEST(consumed_up_to, $2) WHERE id = $1',
      [blockId, sequenceNo],
    );
  },

  listLiveBlocks(tx: Tx, deviceId: string): Promise<BlockRow[]> {
    return tx.many<BlockRow>(
      `SELECT ${BLOCK_COLUMNS} FROM number_blocks
       WHERE device_id = $1 AND expires_at > now() AND (consumed_up_to IS NULL OR consumed_up_to < end_seq)
       ORDER BY series_id, start_seq`,
      [deviceId],
    );
  },

  /**
   * Reserved numbers with no invoice, grouped into ranges. A live block only
   * counts up to what the device has consumed; an expired block counts in full.
   * Consecutive numbers share `seq - row_number()`, which forms the ranges.
   */
  findInvoiceGaps(tx: Tx, seriesId: string): Promise<SequenceRange[]> {
    return tx.many<SequenceRange>(
      `WITH reserved AS (
         SELECT generate_series(
                  b.start_seq,
                  CASE WHEN b.expires_at <= now() THEN b.end_seq ELSE COALESCE(b.consumed_up_to, b.start_seq - 1) END
                ) AS seq
         FROM number_blocks b WHERE b.series_id = $1
       ),
       missing AS (
         SELECT r.seq FROM reserved r
         WHERE NOT EXISTS (SELECT 1 FROM invoices i WHERE i.series_id = $1 AND i.sequence_no = r.seq)
       )
       SELECT min(seq) AS "from", max(seq) AS "to"
       FROM (SELECT seq, seq - row_number() OVER (ORDER BY seq) AS grp FROM missing) grouped
       GROUP BY grp
       ORDER BY 1`,
      [seriesId],
    );
  },

  async outletCodeInUse(tx: Tx, outletId: string): Promise<boolean> {
    const row = await tx.one<{ inUse: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM document_series
                      WHERE outlet_id = $1 AND include_outlet_code AND deleted_at IS NULL) AS "inUse"`,
      [outletId],
    );
    return row?.inUse ?? false;
  },

  async counterCodeInUse(tx: Tx, counterId: string): Promise<boolean> {
    const row = await tx.one<{ inUse: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM document_series
                      WHERE counter_id = $1 AND include_counter_code AND deleted_at IS NULL) AS "inUse"`,
      [counterId],
    );
    return row?.inUse ?? false;
  },
};
