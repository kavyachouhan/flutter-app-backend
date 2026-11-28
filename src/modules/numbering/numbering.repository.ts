import type { Tx } from '../../db/tx.js';
import {
  ABANDONED_AFTER_DAYS,
  CONTACT_GRACE_HOURS,
  type UnusedNumber,
} from '../../domain/numbering/unused.js';
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

export interface CancelledNumberInsert {
  id: string;
  seriesId: string;
  blockId: string;
  sequenceNo: number;
  documentNumber: string;
  seriesFamily: string;
  registrationId: string | null;
  cancelledOn: string;
  reason: 'device_removed' | 'unused_block';
  createdBy: string | null;
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

  /** The series that continues `outletId/counterId/documentType` in a given financial year, if any. */
  findSeriesByScope(
    tx: Tx,
    scope: {
      outletId: string;
      counterId: string | null;
      documentType: string;
      fyStartYear: number;
    },
  ): Promise<SeriesRow | undefined> {
    return tx.one<SeriesRow>(
      `SELECT ${SERIES_COLUMNS} ${SERIES_FROM}
       WHERE s.deleted_at IS NULL AND s.outlet_id = $1 AND s.counter_id IS NOT DISTINCT FROM $2
         AND s.document_type = $3 AND s.fy_start_year = $4`,
      [scope.outletId, scope.counterId, scope.documentType, scope.fyStartYear],
    );
  },

  /**
   * Any live series issuing `documentType` for an outlet in a financial year,
   * whatever its counter scope.
   *
   * `findSeriesByScope` answers a narrower question — the series for one exact
   * scope — and is the right one when continuing a known series. This one
   * exists for provisioning: a shop that already numbers invoices per counter
   * must not have an outlet-wide series created underneath it. Outlet-scoped
   * rows sort first so the answer is stable when both exist.
   */
  findSeriesForDocumentType(
    tx: Tx,
    outletId: string,
    documentType: string,
    fyStartYear: number,
  ): Promise<SeriesRow | undefined> {
    return tx.one<SeriesRow>(
      `SELECT ${SERIES_COLUMNS} ${SERIES_FROM}
       WHERE s.deleted_at IS NULL AND s.is_active AND s.outlet_id = $1
         AND s.document_type = $2 AND s.fy_start_year = $3
       ORDER BY s.counter_id NULLS FIRST, s.created_at
       LIMIT 1`,
      [outletId, documentType, fyStartYear],
    );
  },

  async setNextSeq(tx: Tx, id: string, nextSeq: number): Promise<void> {
    await tx.query('UPDATE document_series SET next_seq = $2 WHERE id = $1', [id, nextSeq]);
  },

  /**
   * Takes the next number from a series, server-side.
   *
   * Sales invoices lease blocks to devices because a till must number a bill
   * with no network. Purchases, debit notes and the like are keyed in on a
   * connected screen, so they can take a number directly — and should, since
   * a lease that expires unused leaves a reported gap in the series for no
   * reason.
   *
   * The UPDATE ... RETURNING is atomic: two concurrent entries are serialised
   * by the row lock the update takes, so neither can read the same number.
   */
  async allocateSequence(tx: Tx, seriesId: string): Promise<number> {
    const row = await tx.one<{ sequenceNo: number }>(
      `UPDATE document_series SET next_seq = next_seq + 1
       WHERE id = $1 RETURNING next_seq - 1 AS "sequenceNo"`,
      [seriesId],
    );
    if (!row) throw new Error('series allocation returned no row');
    return Number(row.sequenceNo);
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

  /**
   * The row lock serialises two uploads using numbers from the same block, and
   * an upload against the declaration that a number was never used
   * (`lockBlocks` takes the same lock). A number declared cancelled is not the
   * device's to use any more, so it is refused like one never leased.
   *
   * The cancellation check is its own statement, run once the lock is held: in
   * READ COMMITTED each statement sees what was committed before it began, so
   * it sees a cancellation that committed while this upload waited for the lock.
   */
  async lockBlockForSequence(
    tx: Tx,
    seriesId: string,
    deviceId: string,
    sequenceNo: number,
  ): Promise<BlockRow | undefined> {
    const block = await tx.one<BlockRow>(
      `SELECT ${BLOCK_COLUMNS} FROM number_blocks
       WHERE series_id = $1 AND device_id = $2 AND $3 BETWEEN start_seq AND end_seq
       FOR UPDATE`,
      [seriesId, deviceId, sequenceNo],
    );
    if (!block) return undefined;
    const cancelled = await tx.one<{ cancelled: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM cancelled_document_numbers
                      WHERE series_id = $1 AND sequence_no = $2) AS cancelled`,
      [seriesId, sequenceNo],
    );
    return cancelled?.cancelled ? undefined : block;
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
   * Every reserved number of a series that no document used and nobody has
   * declared cancelled, with whether it may be declared now (the rule is in
   * domain/numbering/unused.ts).
   *
   * A live block of an active device only counts up to what that device has
   * used: the rest is still ahead of it. An expired block, or any block of a
   * removed device, counts in full. "Used" means a document of any type with
   * this series and number, or an issue attempt refused at sync (that number
   * is already in the registry as rejected_before_issue).
   *
   * `onlyDeviceId` narrows it to one device's blocks.
   */
  unusedNumbers(tx: Tx, seriesId: string, onlyDeviceId?: string): Promise<UnusedNumber[]> {
    return tx.many<UnusedNumber>(
      `WITH blk AS (
         SELECT b.id, b.start_seq, b.end_seq, b.consumed_up_to, b.expires_at,
                (d.is_active AND d.deleted_at IS NULL) AS device_active,
                GREATEST(d.last_seen_at, s.last_pull_at, s.last_push_at) AS last_contact
         FROM number_blocks b
         JOIN devices d ON d.id = b.device_id
         LEFT JOIN device_sync_state s ON s.device_id = b.device_id AND s.tenant_id = b.tenant_id
         WHERE b.series_id = $1 AND ($2::uuid IS NULL OR b.device_id = $2)
       ),
       reserved AS (
         SELECT blk.id AS block_id, gs.seq::bigint AS seq,
                CASE
                  WHEN NOT blk.device_active THEN 'cancellable'
                  WHEN blk.expires_at > now() THEN 'in_use'
                  WHEN blk.last_contact > blk.expires_at + make_interval(hours => $3::int)
                    OR blk.expires_at <= now() - make_interval(days => $4::int) THEN 'cancellable'
                  ELSE 'device_offline'
                END AS status
         FROM blk
         CROSS JOIN LATERAL generate_series(
           blk.start_seq,
           CASE WHEN blk.expires_at <= now() OR NOT blk.device_active THEN blk.end_seq
                ELSE COALESCE(blk.consumed_up_to, blk.start_seq - 1) END
         ) AS gs(seq)
       ),
       used AS (
         SELECT sequence_no AS seq FROM invoices WHERE series_id = $1
         UNION ALL SELECT sequence_no FROM credit_notes WHERE series_id = $1
         UNION ALL SELECT sequence_no FROM sales_debit_notes WHERE series_id = $1
         UNION ALL SELECT sequence_no FROM financial_credit_notes WHERE series_id = $1
         UNION ALL SELECT sequence_no FROM debit_notes WHERE series_id = $1
         UNION ALL SELECT sequence_no FROM purchase_orders WHERE series_id = $1
         UNION ALL SELECT sequence_no FROM purchase_bills WHERE series_id = $1
         UNION ALL SELECT sequence_no FROM delivery_challans WHERE series_id = $1
         UNION ALL SELECT sequence_no FROM sales_orders WHERE series_id = $1
         UNION ALL SELECT sequence_no FROM estimates WHERE series_id = $1
         UNION ALL SELECT sequence_no FROM proforma_invoices WHERE series_id = $1
         UNION ALL SELECT sequence_no FROM document_issue_rejections WHERE series_id = $1
         UNION ALL SELECT sequence_no FROM cancelled_document_numbers WHERE series_id = $1
       )
       SELECT r.block_id AS "blockId", r.seq::int AS seq, r.status
       FROM reserved r
       WHERE NOT EXISTS (SELECT 1 FROM used u WHERE u.seq = r.seq)
       ORDER BY r.seq`,
      [seriesId, onlyDeviceId ?? null, CONTACT_GRACE_HOURS, ABANDONED_AFTER_DAYS],
    );
  },

  /** Series with at least one block, among the outlets the caller may see (null: all). */
  async seriesWithBlocks(tx: Tx, restrictTo: readonly string[] | null): Promise<string[]> {
    const rows = await tx.many<{ id: string }>(
      `SELECT s.id FROM document_series s
       WHERE s.deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM number_blocks b WHERE b.series_id = s.id)
         AND ($1::uuid[] IS NULL OR s.outlet_id = ANY($1::uuid[]))
       ORDER BY s.fy_start_year, s.id`,
      [restrictTo ? [...restrictTo] : null],
    );
    return rows.map((r) => r.id);
  },

  /** Series a device holds blocks on. */
  async seriesOfDevice(tx: Tx, deviceId: string): Promise<string[]> {
    const rows = await tx.many<{ seriesId: string }>(
      `SELECT DISTINCT series_id AS "seriesId" FROM number_blocks WHERE device_id = $1 ORDER BY 1`,
      [deviceId],
    );
    return rows.map((r) => r.seriesId);
  },

  /**
   * Takes the row lock on blocks before declaring their numbers cancelled: the
   * same lock an upload takes before it uses a number (`lockBlockForSequence`),
   * so the two never interleave. Ordered, so two callers cannot deadlock.
   */
  async lockBlocks(tx: Tx, blockIds: readonly string[]): Promise<void> {
    if (blockIds.length === 0) return;
    await tx.query(
      'SELECT id FROM number_blocks WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
      [[...blockIds]],
    );
  },

  /** A removed device's blocks stop being live, so no top-up or lease list counts them. */
  async expireBlocksOfDevice(tx: Tx, deviceId: string): Promise<void> {
    await tx.query(
      'UPDATE number_blocks SET expires_at = now() WHERE device_id = $1 AND expires_at > now()',
      [deviceId],
    );
  },

  /** Table 13 facts of a series: its family and the registration it numbers for. */
  seriesGstFacts(
    tx: Tx,
    seriesId: string,
  ): Promise<{ seriesFamily: string; registrationId: string | null } | undefined> {
    return tx.one(
      `SELECT COALESCE(
                -- An invoice series may issue bills of supply: use the family its documents carry.
                (SELECT n.series_family FROM gst_document_numbers n
                   JOIN invoices i ON n.document_table = 'invoices' AND n.document_id = i.id
                  WHERE i.series_id = s.id ORDER BY i.sequence_no DESC LIMIT 1),
                s.series_family) AS "seriesFamily",
              s.registration_id AS "registrationId"
       FROM document_series s
       WHERE s.id = $1`,
      [seriesId],
    );
  },

  /** The GSTIN of a registration, for the filed-period check. */
  async gstinOf(tx: Tx, registrationId: string | null): Promise<string | null> {
    if (!registrationId) return null;
    const row = await tx.one<{ gstin: string }>(
      'SELECT gstin FROM gst_registrations WHERE id = $1',
      [registrationId],
    );
    return row?.gstin ?? null;
  },

  /**
   * Per block: the last day it was billed from (latest dated document numbered
   * inside it), and the day it was leased, both in the business's calendar.
   */
  blockDates(
    tx: Tx,
    seriesId: string,
    blockIds: readonly string[],
  ): Promise<{ blockId: string; lastDocumentDate: string | null; leasedOn: string }[]> {
    return tx.many(
      `WITH docs AS (
         SELECT sequence_no, document_date FROM invoices WHERE series_id = $1
         UNION ALL SELECT sequence_no, document_date FROM credit_notes WHERE series_id = $1
         UNION ALL SELECT sequence_no, document_date FROM sales_debit_notes WHERE series_id = $1
         UNION ALL SELECT sequence_no, document_date FROM financial_credit_notes WHERE series_id = $1
       )
       SELECT b.id AS "blockId",
              (SELECT to_char(max(d.document_date), 'YYYY-MM-DD') FROM docs d
                WHERE d.sequence_no BETWEEN b.start_seq AND b.end_seq) AS "lastDocumentDate",
              to_char((b.created_at AT TIME ZONE t.timezone)::date, 'YYYY-MM-DD') AS "leasedOn"
       FROM number_blocks b
       JOIN tenants t ON t.id = b.tenant_id
       WHERE b.series_id = $1 AND b.id = ANY($2::uuid[])`,
      [seriesId, [...blockIds]],
    );
  },

  /** Today in the business's calendar. */
  async businessToday(tx: Tx): Promise<string> {
    const row = await tx.one<{ today: string }>(
      `SELECT to_char((now() AT TIME ZONE timezone)::date, 'YYYY-MM-DD') AS today
       FROM tenants WHERE id = app.current_tenant_id()`,
    );
    if (!row) throw new Error('tenant not found for the business date');
    return row.today;
  },

  async insertCancelledNumbers(tx: Tx, rows: readonly CancelledNumberInsert[]): Promise<void> {
    if (rows.length === 0) return;
    await tx.query(
      `INSERT INTO cancelled_document_numbers (id, tenant_id, series_id, block_id, sequence_no, document_number,
         series_family, registration_id, cancelled_on, reason, created_by)
       SELECT id, app.current_tenant_id(), series_id, block_id, sequence_no, document_number,
              series_family, registration_id, cancelled_on, reason, created_by
       FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::bigint[], $5::text[], $6::text[], $7::uuid[],
                   $8::date[], $9::text[], $10::uuid[])
         AS t(id, series_id, block_id, sequence_no, document_number, series_family, registration_id,
              cancelled_on, reason, created_by)`,
      [
        rows.map((r) => r.id),
        rows.map((r) => r.seriesId),
        rows.map((r) => r.blockId),
        rows.map((r) => r.sequenceNo),
        rows.map((r) => r.documentNumber),
        rows.map((r) => r.seriesFamily),
        rows.map((r) => r.registrationId),
        rows.map((r) => r.cancelledOn),
        rows.map((r) => r.reason),
        rows.map((r) => r.createdBy),
      ],
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
