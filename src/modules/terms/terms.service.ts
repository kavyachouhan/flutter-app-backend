import { withReadTransaction, withTransaction, type Tx } from '../../db/tx.js';
import { NotFoundError, UnprocessableError } from '../../lib/errors.js';
import { buildPage, parsePage } from '../../lib/pagination.js';
import { diffFields, recordAudit } from '../audit/audit.js';
import { termsRepository, type TermsRow } from './terms.repository.js';
import type {
  CreateTermsBody,
  ListTermsQuery,
  TermsDocumentType,
  TermsSnapshot,
  UpdateTermsBody,
} from './terms.schemas.js';

async function requireTerms(tx: Tx, id: string): Promise<TermsRow> {
  const terms = await termsRepository.find(tx, id);
  if (!terms) throw new NotFoundError('Terms & Conditions');
  return terms;
}

export async function listTerms(query: ListTermsQuery) {
  const page = parsePage(query);
  const rows = await withReadTransaction((tx) =>
    termsRepository.list(tx, query.applicableFor, page.limit, page.cursor),
  );
  return buildPage(rows, page.limit, (row) => ({ k: row.title, id: row.id }));
}

export function getTerms(id: string) {
  return withReadTransaction((tx) => requireTerms(tx, id));
}

export function createTerms(body: CreateTermsBody) {
  return withTransaction(async (tx) => {
    // Client-generated id: a replayed create returns what is there.
    const existing = await termsRepository.find(tx, body.id);
    if (existing) return existing;
    await termsRepository.insert(tx, {
      id: body.id,
      title: body.title,
      description: body.description,
      applicableFor: body.applicableFor,
    });
    return requireTerms(tx, body.id);
  });
}

export function updateTerms(id: string, patch: UpdateTermsBody) {
  return withTransaction(async (tx) => {
    const before = await requireTerms(tx, id);
    await termsRepository.update(tx, id, patch);
    await recordAudit(tx, {
      action: 'terms.updated',
      entityType: 'terms',
      entityId: id,
      changes: diffFields(before, patch),
    });
    return requireTerms(tx, id);
  });
}

export function deleteTerms(id: string) {
  return withTransaction(async (tx) => {
    await requireTerms(tx, id);
    // Documents keep their own snapshot, so deleting never alters history.
    await termsRepository.softDelete(tx, id);
    await recordAudit(tx, { action: 'terms.deleted', entityType: 'terms', entityId: id });
  });
}

export interface ResolvedTerms {
  termsId: string;
  snapshot: TermsSnapshot;
}

/**
 * Resolves the T&C a document is being issued with. It must exist and be
 * applicable to that document type; the snapshot is what the document stores
 * alongside the reference.
 */
export async function resolveTermsForDocument(
  tx: Tx,
  termsId: string | null | undefined,
  documentType: TermsDocumentType,
): Promise<ResolvedTerms | null> {
  if (!termsId) return null;
  const terms = await termsRepository.findAny(tx, termsId);
  if (!terms) throw new NotFoundError('Terms & Conditions');
  if (!terms.applicableFor.includes(documentType)) {
    throw new UnprocessableError(
      `These terms are not applicable to ${documentType.replace('_', ' ')} documents.`,
    );
  }
  return { termsId: terms.id, snapshot: { title: terms.title, description: terms.description } };
}
