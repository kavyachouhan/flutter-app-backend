/**
 * Storage for imported ledger files and their entries. Append-only: nothing here updates or
 * deletes, and an entry that arrives twice is kept once (`dedupe_key`).
 */
import { randomUUID } from 'node:crypto';
import type { Tx } from '../../../db/tx.js';
import { jsonParam } from '../../../db/sql.js';
import type { LedgerEntry, LedgerIssue, LedgerKind } from '../../../domain/gst/ledgers/types.js';

export interface LedgerImportRow {
  id: string;
  gstin: string;
  kind: LedgerKind;
  periodFrom: string;
  periodTo: string;
  parserId: string;
  sha256: string;
  entryCount: number;
  newEntryCount: number;
  issues: LedgerIssue[];
  createdAt: Date;
}

const COLUMNS = `id, gstin, kind, period_from::text AS "periodFrom", period_to::text AS "periodTo",
  parser_id AS "parserId", sha256, entry_count AS "entryCount",
  new_entry_count AS "newEntryCount", issues, created_at AS "createdAt"`;

const CHUNK = 200;

export interface NewImport {
  id: string;
  gstin: string;
  kind: LedgerKind;
  periodFrom: string;
  periodTo: string;
  parserId: string;
  sha256: string;
  entryCount: number;
  newEntryCount: number;
  issues: readonly LedgerIssue[];
  createdBy: string | null;
}

export const ledgerRepository = {
  findImport(tx: Tx, id: string): Promise<LedgerImportRow | undefined> {
    return tx.one<LedgerImportRow>(`SELECT ${COLUMNS} FROM gst_ledger_imports WHERE id = $1`, [id]);
  },

  findImportBySha(
    tx: Tx,
    gstin: string,
    kind: LedgerKind,
    sha256: string,
  ): Promise<LedgerImportRow | undefined> {
    return tx.one<LedgerImportRow>(
      `SELECT ${COLUMNS} FROM gst_ledger_imports WHERE gstin = $1 AND kind = $2 AND sha256 = $3`,
      [gstin, kind, sha256],
    );
  },

  async insertImport(tx: Tx, row: NewImport): Promise<void> {
    await tx.query(
      `INSERT INTO gst_ledger_imports
         (id, tenant_id, gstin, kind, period_from, period_to, parser_id, sha256,
          entry_count, new_entry_count, issues, created_by)
       VALUES ($1, app.current_tenant_id(), $2, $3, $4::date, $5::date, $6, $7, $8, $9, $10::jsonb, $11)`,
      [
        row.id,
        row.gstin,
        row.kind,
        row.periodFrom,
        row.periodTo,
        row.parserId,
        row.sha256,
        row.entryCount,
        row.newEntryCount,
        jsonParam(row.issues),
        row.createdBy,
      ],
    );
  },

  /**
   * Inserts entries, skipping any already held. `keyed` pairs each entry with its dedupe key.
   * Returns how many were new.
   */
  async insertEntries(
    tx: Tx,
    importId: string,
    gstin: string,
    keyed: readonly { entry: LedgerEntry; key: string }[],
  ): Promise<number> {
    let added = 0;
    for (let i = 0; i < keyed.length; i += CHUNK) {
      const chunk = keyed.slice(i, i + CHUNK);
      const params: unknown[] = [];
      const values = chunk.map(({ entry, key }) => {
        const base = params.length;
        params.push(
          randomUUID(), importId, gstin, entry.kind, entry.rowNo, entry.date, entry.returnPeriod,
          entry.refNo, entry.description, entry.direction, entry.dischargeType,
          jsonParam(entry.amounts), jsonParam(entry.itc), key,
        );
        const p = (n: number) => `$${base + n}`;
        return `(${p(1)}, app.current_tenant_id(), ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}::date, ${p(7)}, ${p(8)}, ${p(9)}, ${p(10)}, ${p(11)}, ${p(12)}::jsonb, ${p(13)}::jsonb, ${p(14)})`;
      });
      const inserted = await tx.many<{ id: string }>(
        `INSERT INTO gst_ledger_entries
           (id, tenant_id, import_id, gstin, kind, row_no, entry_date, return_period, ref_no,
            description, direction, discharge_type, amounts, itc, dedupe_key)
         VALUES ${values.join(', ')}
         ON CONFLICT (tenant_id, gstin, kind, dedupe_key) DO NOTHING
         RETURNING id`,
        params,
      );
      added += inserted.length;
    }
    return added;
  },

  /** Which of these event keys are already held for the registration and ledger. */
  async existingKeys(
    tx: Tx,
    gstin: string,
    kind: LedgerKind,
    keys: readonly string[],
  ): Promise<Set<string>> {
    if (keys.length === 0) return new Set();
    const rows = await tx.many<{ key: string }>(
      `SELECT dedupe_key AS key FROM gst_ledger_entries
       WHERE gstin = $1 AND kind = $2 AND dedupe_key = ANY($3::text[])`,
      [gstin, kind, [...keys]],
    );
    return new Set(rows.map((r) => r.key));
  },

  list(tx: Tx, gstin: string | undefined, limit: number): Promise<LedgerImportRow[]> {
    return tx.many<LedgerImportRow>(
      `SELECT ${COLUMNS} FROM gst_ledger_imports
       WHERE ($1::text IS NULL OR gstin = $1)
       ORDER BY created_at DESC, id DESC LIMIT $2`,
      [gstin ?? null, limit],
    );
  },

  /** The windows imported files cover, for working out which months a ledger speaks for. */
  coverage(
    tx: Tx,
    gstin: string,
  ): Promise<{ kind: LedgerKind; periodFrom: string; periodTo: string }[]> {
    return tx.many(
      `SELECT kind, period_from::text AS "periodFrom", period_to::text AS "periodTo"
       FROM gst_ledger_imports WHERE gstin = $1`,
      [gstin],
    );
  },

  /**
   * Entries whose period falls in the window. An entry belongs to the return period it names, and
   * to its own date's month when it names none.
   */
  async entries(tx: Tx, gstin: string, fromMonth: string, toMonth: string): Promise<LedgerEntry[]> {
    const rows = await tx.many<{
      kind: LedgerKind;
      rowNo: number;
      date: string | null;
      returnPeriod: string | null;
      refNo: string | null;
      description: string;
      direction: 'credit' | 'debit' | null;
      dischargeType: string | null;
      amounts: LedgerEntry['amounts'];
      itc: LedgerEntry['itc'];
    }>(
      `SELECT kind, row_no AS "rowNo", entry_date::text AS date, return_period AS "returnPeriod",
              ref_no AS "refNo", description, direction, discharge_type AS "dischargeType",
              amounts, itc
       FROM gst_ledger_entries
       WHERE gstin = $1
         AND COALESCE(return_period, to_char(entry_date, 'YYYY-MM')) >= $2
         AND COALESCE(return_period, to_char(entry_date, 'YYYY-MM')) <= $3
       ORDER BY kind, entry_date, row_no`,
      [gstin, fromMonth, toMonth],
    );
    return rows;
  },
};
