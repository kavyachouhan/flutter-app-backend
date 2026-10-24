import type { Tx } from '../../db/tx.js';
import { buildSet } from '../../db/sql.js';
import type { Cursor } from '../../lib/pagination.js';
import type { TermsDocumentType } from './terms.schemas.js';

export interface TermsRow {
  id: string;
  title: string;
  description: string;
  applicableFor: TermsDocumentType[];
  createdAt: Date;
  updatedAt: Date;
}

export type NewTerms = Omit<TermsRow, 'createdAt' | 'updatedAt'>;

const COLUMNS = `id, title, description, applicable_for AS "applicableFor",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

const UPDATABLE = {
  title: 'title',
  description: 'description',
  applicableFor: 'applicable_for',
} as const;

export const termsRepository = {
  list(
    tx: Tx,
    applicableFor: TermsDocumentType | undefined,
    limit: number,
    cursor: Cursor | undefined,
  ): Promise<TermsRow[]> {
    return tx.many<TermsRow>(
      `SELECT ${COLUMNS} FROM terms_conditions
       WHERE deleted_at IS NULL
         AND ($1::text IS NULL OR $1 = ANY (applicable_for))
         AND ($2::text IS NULL OR (title, id) > ($2::text, $3::uuid))
       ORDER BY title, id
       LIMIT $4`,
      [applicableFor ?? null, cursor ? String(cursor.k) : null, cursor?.id ?? null, limit + 1],
    );
  },

  find(tx: Tx, id: string): Promise<TermsRow | undefined> {
    return tx.one<TermsRow>(
      `SELECT ${COLUMNS} FROM terms_conditions WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
  },

  /**
   * Includes soft-deleted rows: a document drafted (or pushed from an offline
   * device) before a T&C was removed must still be issuable with it.
   */
  findAny(tx: Tx, id: string): Promise<TermsRow | undefined> {
    return tx.one<TermsRow>(`SELECT ${COLUMNS} FROM terms_conditions WHERE id = $1`, [id]);
  },

  async insert(tx: Tx, t: NewTerms): Promise<void> {
    await tx.query(
      `INSERT INTO terms_conditions (id, tenant_id, title, description, applicable_for)
       VALUES ($1, app.current_tenant_id(), $2, $3, $4)`,
      [t.id, t.title, t.description, t.applicableFor],
    );
  },

  async update(tx: Tx, id: string, patch: Record<string, unknown>): Promise<void> {
    const { clause, values } = buildSet(patch, UPDATABLE, 2);
    if (clause) {
      await tx.query(`UPDATE terms_conditions SET ${clause} WHERE id = $1`, [id, ...values]);
    }
  },

  async softDelete(tx: Tx, id: string): Promise<void> {
    await tx.query('UPDATE terms_conditions SET deleted_at = now() WHERE id = $1', [id]);
  },
};
