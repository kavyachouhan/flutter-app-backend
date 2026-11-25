import type { Tx } from '../../db/tx.js';
import { buildSet, jsonParam } from '../../db/sql.js';
import type { Cursor } from '../../lib/pagination.js';

export type ImportKind = 'items' | 'customers' | 'suppliers' | 'opening_stock';

export type ImportStatus =
  | 'pending'
  | 'ingesting'
  | 'ingested'
  | 'analysing'
  | 'analysed'
  | 'applying'
  | 'applied'
  | 'failed'
  | 'cancelled'
  | 'expired';

export type RowAction = 'pending' | 'create' | 'update' | 'skip' | 'error';

export type MatchRule = 'code' | 'barcode' | 'name' | 'phone' | 'gstin';

export type MappingSource = 'auto' | 'saved' | 'confirmed';

type ParsedRecord = Record<string, string | number | boolean | null>;

export interface ImportJobRow {
  id: string;
  kind: ImportKind;
  objectKey: string;
  originalFilename: string | null;
  status: ImportStatus;
  columnMap: Record<string, number> | null;
  /** The file's header row, as read. */
  headers: string[] | null;
  layoutKey: string | null;
  mappingSource: MappingSource | null;
  outletId: string | null;
  ingestedRows: number;
  analysedUpToRow: number;
  appliedUpToRow: number;
  totalRows: number;
  createCount: number;
  updateCount: number;
  skipCount: number;
  errorCount: number;
  catalogueFingerprint: string | null;
  errorSummary: unknown;
  createdBy: string | null;
  ingestedAt: Date | null;
  analysedAt: Date | null;
  appliedAt: Date | null;
  lastProgressAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ImportJobRowRecord {
  id: string;
  rowNo: number;
  action: RowAction;
  appliedAt: Date | null;
  targetId: string | null;
  matchRule: MatchRule | null;
  raw: unknown;
  parsed: ParsedRecord | null;
  diff: Record<string, { from: unknown; to: unknown }> | null;
  errors: Record<string, string> | null;
  notes: string[] | null;
}

/** An existing item, reduced to what matching and diffing need. */
export interface MatchCandidate {
  id: string;
  name: string;
  code: string | null;
  barcodes: string[];
  categoryId: string | null;
  itemType: 'goods' | 'service';
  hsnCode: string | null;
  taxRatePercent: number;
  cessRatePercent: number;
  unit: string;
  mrp: number | null;
  salePrice: number;
  purchasePrice: number | null;
  trackStock: boolean;
  reorderLevel: number | null;
  pricesIncludeTax: boolean;
  discountPercent: number | null;
}

/** An existing customer or supplier, reduced to what matching and diffing need. */
export interface PartyCandidate {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  gstin: string | null;
  stateCode: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  pincode: string | null;
  notes: string | null;
  /** Customers only. */
  creditLimit?: number | null;
  /** Suppliers only. */
  paymentTermsDays?: number | null;
}

export interface SavedMapping {
  columnMap: Record<string, number>;
  headers: string[];
}

/** The tables an import writes, for its "did anyone else change this?" fingerprint. */
const FINGERPRINT_TABLES = {
  items: 'items',
  customers: 'customers',
  suppliers: 'suppliers',
} as const;

const JOB_COLUMNS = `
  id, kind, object_key AS "objectKey", original_filename AS "originalFilename", status,
  column_map AS "columnMap", headers, layout_key AS "layoutKey",
  mapping_source AS "mappingSource", outlet_id AS "outletId", ingested_rows AS "ingestedRows", analysed_up_to_row AS "analysedUpToRow",
  applied_up_to_row AS "appliedUpToRow", total_rows AS "totalRows", create_count AS "createCount",
  update_count AS "updateCount", skip_count AS "skipCount", error_count AS "errorCount",
  catalogue_fingerprint AS "catalogueFingerprint", error_summary AS "errorSummary",
  created_by AS "createdBy", ingested_at AS "ingestedAt", analysed_at AS "analysedAt",
  applied_at AS "appliedAt", last_progress_at AS "lastProgressAt",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

const ROW_COLUMNS = `
  id, row_no AS "rowNo", action, applied_at AS "appliedAt", target_id AS "targetId",
  match_rule AS "matchRule", raw, parsed, diff, errors, notes`;

const JOB_UPDATABLE = {
  status: 'status',
  columnMap: 'column_map',
  headers: 'headers',
  layoutKey: 'layout_key',
  mappingSource: 'mapping_source',
  ingestedRows: 'ingested_rows',
  analysedUpToRow: 'analysed_up_to_row',
  appliedUpToRow: 'applied_up_to_row',
  totalRows: 'total_rows',
  createCount: 'create_count',
  updateCount: 'update_count',
  skipCount: 'skip_count',
  errorCount: 'error_count',
  catalogueFingerprint: 'catalogue_fingerprint',
  errorSummary: 'error_summary',
  ingestedAt: 'ingested_at',
  analysedAt: 'analysed_at',
  appliedAt: 'applied_at',
} as const;

const JSON_PATCH_KEYS = new Set(['columnMap', 'errorSummary', 'headers']);

export interface NewImportJob {
  id: string;
  kind: ImportKind;
  objectKey: string;
  originalFilename: string | null;
  outletId: string | null;
  createdBy: string;
}

export interface IngestedRow {
  rowNo: number;
  raw: unknown;
}

export interface AnalysedRow {
  rowNo: number;
  action: Exclude<RowAction, 'pending'>;
  targetId: string | null;
  matchRule: MatchRule | null;
  parsed: ParsedRecord | null;
  diff: Record<string, { from: unknown; to: unknown }> | null;
  errors: Record<string, string> | null;
  notes: string[] | null;
  /** What a creating row claims (e.g. "phone:919876543210"), so a second row cannot claim it too. */
  dedupeKeys: string[] | null;
}

export const importsRepository = {
  async insertJob(tx: Tx, job: NewImportJob): Promise<void> {
    await tx.query(
      `INSERT INTO import_jobs
         (id, tenant_id, kind, object_key, original_filename, outlet_id, status, created_by)
       VALUES ($1, app.current_tenant_id(), $2, $3, $4, $5, 'pending', $6)`,
      [job.id, job.kind, job.objectKey, job.originalFilename, job.outletId, job.createdBy],
    );
  },

  /**
   * `FOR UPDATE` is the whole concurrency story for chunking: two clients (or
   * one double-tapping) serialise on the job row, and the loser sees the
   * cursor the winner already advanced.
   */
  findJob(tx: Tx, id: string, forUpdate = false): Promise<ImportJobRow | undefined> {
    return tx.one<ImportJobRow>(
      `SELECT ${JOB_COLUMNS} FROM import_jobs WHERE id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`,
      [id],
    );
  },

  listJobs(tx: Tx, limit: number, cursor: Cursor | undefined): Promise<ImportJobRow[]> {
    return tx.many<ImportJobRow>(
      `SELECT ${JOB_COLUMNS} FROM import_jobs
       WHERE ($1::timestamptz IS NULL OR (created_at, id) < ($1::timestamptz, $2::uuid))
       ORDER BY created_at DESC, id DESC
       LIMIT $3`,
      [cursor ? String(cursor.k) : null, cursor?.id ?? null, limit + 1],
    );
  },

  /** `lastProgressAt` is always bumped: a chunk that did work must be visible as progress. */
  async updateJob(tx: Tx, id: string, patch: Record<string, unknown>): Promise<void> {
    const prepared: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      prepared[key] = JSON_PATCH_KEYS.has(key) ? jsonParam(value) : value;
    }
    const { clause, values } = buildSet(prepared, JOB_UPDATABLE, 2);
    const assignments = clause ? `${clause}, last_progress_at = now()` : 'last_progress_at = now()';
    await tx.query(`UPDATE import_jobs SET ${assignments} WHERE id = $1`, [id, ...values]);
  },

  /**
   * Raw rows, inserted set-based in batches by the caller.
   *
   * `jsonb_to_recordset` rather than a multi-row VALUES list: the parameter
   * count of a 500-row VALUES exceeds what one statement should carry, and
   * this is the same shape `invoicesRepository.insertLines` uses.
   */
  async insertRows(tx: Tx, jobId: string, rows: readonly IngestedRow[]): Promise<void> {
    if (rows.length === 0) return;
    await tx.query(
      `INSERT INTO import_job_rows (id, tenant_id, job_id, row_no, action, raw)
       SELECT gen_random_uuid(), app.current_tenant_id(), $1, r."rowNo", 'pending', r.raw
       FROM jsonb_to_recordset($2::jsonb) AS r("rowNo" int, raw jsonb)`,
      [jobId, JSON.stringify(rows)],
    );
  },

  /** The next slice of unanalysed rows, in file order. */
  nextPendingRows(tx: Tx, jobId: string, afterRowNo: number, limit: number) {
    return tx.many<{ rowNo: number; raw: unknown }>(
      `SELECT row_no AS "rowNo", raw FROM import_job_rows
       WHERE job_id = $1 AND row_no > $2 AND action = 'pending'
       ORDER BY row_no LIMIT $3`,
      [jobId, afterRowNo, limit],
    );
  },

  async applyAnalysis(tx: Tx, jobId: string, rows: readonly AnalysedRow[]): Promise<void> {
    if (rows.length === 0) return;
    await tx.query(
      `UPDATE import_job_rows r
       SET action = a.action, target_id = a."targetId", match_rule = a."matchRule",
           parsed = a.parsed, diff = a.diff, errors = a.errors, notes = a.notes,
           dedupe_keys = a."dedupeKeys"
       FROM jsonb_to_recordset($2::jsonb) AS a(
         "rowNo" int, action text, "targetId" uuid, "matchRule" text,
         parsed jsonb, diff jsonb, errors jsonb, notes jsonb, "dedupeKeys" text[])
       WHERE r.job_id = $1 AND r.row_no = a."rowNo"`,
      [jobId, JSON.stringify(rows)],
    );
  },

  listRows(
    tx: Tx,
    jobId: string,
    action: string | undefined,
    limit: number,
    cursor: Cursor | undefined,
  ): Promise<ImportJobRowRecord[]> {
    return tx.many<ImportJobRowRecord>(
      `SELECT ${ROW_COLUMNS} FROM import_job_rows
       WHERE job_id = $1
         AND ($2::text IS NULL OR action = $2)
         AND ($3::int IS NULL OR row_no > $3)
       ORDER BY row_no LIMIT $4`,
      [jobId, action ?? null, cursor ? Number(cursor.k) : null, limit + 1],
    );
  },

  /** The next slice of writable rows that have not been applied yet. */
  nextApplicableRows(tx: Tx, jobId: string, limit: number): Promise<ImportJobRowRecord[]> {
    return tx.many<ImportJobRowRecord>(
      `SELECT ${ROW_COLUMNS} FROM import_job_rows
       WHERE job_id = $1 AND applied_at IS NULL AND action IN ('create', 'update')
       ORDER BY row_no LIMIT $2`,
      [jobId, limit],
    );
  },

  async markRowsApplied(tx: Tx, jobId: string, rowNos: readonly number[]): Promise<void> {
    if (rowNos.length === 0) return;
    await tx.query(
      'UPDATE import_job_rows SET applied_at = now() WHERE job_id = $1 AND row_no = ANY($2::int[])',
      [jobId, [...rowNos]],
    );
  },

  async countRemainingApplicable(tx: Tx, jobId: string): Promise<number> {
    const row = await tx.one<{ count: number }>(
      `SELECT count(*)::int AS count FROM import_job_rows
       WHERE job_id = $1 AND applied_at IS NULL AND action IN ('create', 'update')`,
      [jobId],
    );
    return row?.count ?? 0;
  },

  /**
   * Items already claimed by an earlier chunk of this job.
   *
   * The in-memory duplicate check only sees one chunk, but
   * `import_job_rows_target_uq` spans the job — so without seeding the set
   * from here, a file whose duplicate rows straddle a chunk boundary would
   * fail the whole chunk on a unique violation instead of marking one row as
   * an error.
   */
  async claimedTargetIds(tx: Tx, jobId: string): Promise<string[]> {
    const rows = await tx.many<{ targetId: string }>(
      `SELECT target_id AS "targetId" FROM import_job_rows
       WHERE job_id = $1 AND action = 'update' AND target_id IS NOT NULL`,
      [jobId],
    );
    return rows.map((r) => r.targetId);
  },

  async countByAction(tx: Tx, jobId: string): Promise<Record<string, number>> {
    const rows = await tx.many<{ action: string; count: number }>(
      'SELECT action, count(*)::int AS count FROM import_job_rows WHERE job_id = $1 GROUP BY action',
      [jobId],
    );
    return Object.fromEntries(rows.map((r) => [r.action, r.count]));
  },

  /** Forgets every judgement on rows not yet written, for a re-analysis under a new mapping. */
  async resetAnalysis(tx: Tx, jobId: string): Promise<void> {
    await tx.query(
      `UPDATE import_job_rows
       SET action = 'pending', target_id = NULL, match_rule = NULL, parsed = NULL,
           diff = NULL, errors = NULL, notes = NULL, dedupe_keys = NULL
       WHERE job_id = $1 AND applied_at IS NULL`,
      [jobId],
    );
  },

  /**
   * Which of [keys] an earlier creating row of this job already claimed, and
   * on which row - so "same phone as row 4" can be said, across chunks.
   */
  async claimedCreateKeys(
    tx: Tx,
    jobId: string,
    keys: readonly string[],
  ): Promise<Map<string, number>> {
    if (keys.length === 0) return new Map();
    const rows = await tx.many<{ key: string; rowNo: number }>(
      `SELECT k AS key, min(r.row_no)::int AS "rowNo"
       FROM import_job_rows r, unnest(r.dedupe_keys) AS k
       WHERE r.job_id = $1 AND r.action = 'create' AND r.dedupe_keys && $2::text[]
         AND k = ANY($2::text[])
       GROUP BY k`,
      [jobId, [...keys]],
    );
    return new Map(rows.map((r) => [r.key, r.rowNo]));
  },

  /** The first few rows as read, for the column-matching screen's examples. */
  sampleRows(tx: Tx, jobId: string, limit: number): Promise<{ rowNo: number; cells: unknown }[]> {
    return tx.many<{ rowNo: number; cells: unknown }>(
      `SELECT row_no AS "rowNo", raw AS cells FROM import_job_rows
       WHERE job_id = $1 ORDER BY row_no LIMIT $2`,
      [jobId, limit],
    );
  },

  findSavedMapping(tx: Tx, kind: ImportKind, layoutKey: string): Promise<SavedMapping | undefined> {
    return tx.one<SavedMapping>(
      `SELECT column_map AS "columnMap", headers FROM import_column_mappings
       WHERE kind = $1 AND layout_key = $2`,
      [kind, layoutKey],
    );
  },

  async saveMapping(
    tx: Tx,
    kind: ImportKind,
    layoutKey: string,
    headers: readonly string[],
    columnMap: Record<string, number>,
    userId: string,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO import_column_mappings (tenant_id, kind, layout_key, headers, column_map, updated_by)
       VALUES (app.current_tenant_id(), $1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, kind, layout_key)
       DO UPDATE SET column_map = EXCLUDED.column_map, headers = EXCLUDED.headers,
                     updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [kind, layoutKey, jsonParam([...headers]), jsonParam(columnMap), userId],
    );
  },

  /** Turns a row that could not be written into an error, with the reason. */
  async markRowFailed(tx: Tx, jobId: string, rowNo: number, message: string): Promise<void> {
    await tx.query(
      `UPDATE import_job_rows SET action = 'error', target_id = NULL, errors = $3
       WHERE job_id = $1 AND row_no = $2`,
      [jobId, rowNo, jsonParam({ row: message })],
    );
  },

  async deleteRows(tx: Tx, jobId: string): Promise<void> {
    await tx.query('DELETE FROM import_job_rows WHERE job_id = $1', [jobId]);
  },

  /**
   * Every existing item a chunk could match, in one query.
   *
   * Per-row lookups would be three round trips times five thousand rows. The
   * name comparison is lowercased here so the index-free path at least runs
   * once per chunk rather than once per row.
   */
  findMatchCandidates(
    tx: Tx,
    codes: readonly string[],
    barcodes: readonly string[],
    names: readonly string[],
  ): Promise<MatchCandidate[]> {
    return tx.many<MatchCandidate>(
      `SELECT i.id, i.name, i.code, i.category_id AS "categoryId", i.item_type AS "itemType",
              i.hsn_code AS "hsnCode", i.tax_rate_percent AS "taxRatePercent",
              i.cess_rate_percent AS "cessRatePercent", i.unit, i.mrp, i.sale_price AS "salePrice",
              i.purchase_price AS "purchasePrice", i.track_stock AS "trackStock",
              i.reorder_level AS "reorderLevel", i.prices_include_tax AS "pricesIncludeTax",
              i.discount_percent::float8 AS "discountPercent",
              COALESCE((SELECT array_agg(b.barcode) FROM item_barcodes b
                        WHERE b.item_id = i.id AND b.deleted_at IS NULL), '{}') AS barcodes
       FROM items i
       WHERE i.deleted_at IS NULL
         AND (
           ($1::text[] <> '{}' AND lower(i.code) = ANY($1::text[]))
           OR ($2::text[] <> '{}' AND EXISTS (
                 SELECT 1 FROM item_barcodes b
                 WHERE b.item_id = i.id AND b.deleted_at IS NULL AND b.barcode = ANY($2::text[])))
           OR ($3::text[] <> '{}' AND lower(i.name) = ANY($3::text[]))
         )`,
      [[...codes], [...barcodes], [...names]],
    );
  },

  /** Existing category names to ids, so a chunk resolves them without a query each. */
  async categoryIdsByName(tx: Tx): Promise<Map<string, string>> {
    const rows = await tx.many<{ id: string; name: string }>(
      'SELECT id, name FROM categories WHERE deleted_at IS NULL',
    );
    return new Map(rows.map((r) => [r.name.toLowerCase(), r.id]));
  },

  /**
   * Every existing customer or supplier a chunk could match, in one query.
   * [phones] are already normalised; [names] lowercased.
   */
  findPartyCandidates(
    tx: Tx,
    kind: 'customers' | 'suppliers',
    phones: readonly string[],
    gstins: readonly string[],
    names: readonly string[],
  ): Promise<PartyCandidate[]> {
    const extra =
      kind === 'customers'
        ? 'credit_limit AS "creditLimit"'
        : 'payment_terms_days AS "paymentTermsDays"';
    return tx.many<PartyCandidate>(
      `SELECT id, name, phone, email, gstin, state_code AS "stateCode",
              address_line1 AS "addressLine1", address_line2 AS "addressLine2", city, pincode,
              notes, ${extra}
       FROM ${FINGERPRINT_TABLES[kind]}
       WHERE deleted_at IS NULL
         AND (
           ($1::text[] <> '{}' AND phone = ANY($1::text[]))
           OR ($2::text[] <> '{}' AND gstin = ANY($2::text[]))
           OR ($3::text[] <> '{}' AND lower(name) = ANY($3::text[]))
         )`,
      [[...phones], [...gstins], [...names]],
    );
  },

  /**
   * A cheap summary of the state of the table an import writes.
   *
   * Compared between analysis and each apply chunk: if it moved, the stored
   * diff was computed against rows that may no longer say what it claims, and
   * applying it would overwrite someone else's edit.
   */
  async fingerprint(tx: Tx, kind: ImportKind): Promise<string> {
    const table = FINGERPRINT_TABLES[kind as keyof typeof FINGERPRINT_TABLES];
    if (!table) throw new Error(`No fingerprint for import kind ${kind}`);
    const row = await tx.one<{ fingerprint: string }>(
      `SELECT COALESCE(max(server_seq), 0)::text || ':' || count(*)::text AS fingerprint
       FROM ${table} WHERE deleted_at IS NULL`,
    );
    return row?.fingerprint ?? '0:0';
  },

  async countItems(tx: Tx): Promise<number> {
    const row = await tx.one<{ count: number }>(
      'SELECT count(*)::int AS count FROM items WHERE deleted_at IS NULL',
    );
    return row?.count ?? 0;
  },
};
