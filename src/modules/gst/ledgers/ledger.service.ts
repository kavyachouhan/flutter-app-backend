/**
 * Importing the GSTN electronic ledgers, and reading them back as the figures a return needs.
 *
 * A file is checked against the official schema, read by the parser for its version, and kept as a
 * list of neutral entries. Nothing is guessed: a file that is not the shape the portal publishes,
 * is for another GSTIN, or has an unreadable window is refused with the reasons.
 *
 * Reading is behind `LedgerSource`, so a GSP fetch later is a second source that returns the same
 * entries and the return engines do not change.
 */
import { createHash } from 'node:crypto';
import { withReadTransaction, withTransaction, type Tx } from '../../../db/tx.js';
import { LEDGER_FORM, LEDGER_PARSERS } from '../../../domain/gst/ledgers/index.js';
import { summariseLedgers, type LedgerSummary } from '../../../domain/gst/ledgers/summary.js';
import type { LedgerEntry, LedgerIssue, LedgerKind } from '../../../domain/gst/ledgers/types.js';
import { selectVersion } from '../../../domain/gst/returns/registry.js';
import { requireAuthContext } from '../../../lib/context.js';
import { ErrorCode, UnprocessableError } from '../../../lib/errors.js';
import { createLogger } from '../../../lib/logger.js';
import { monthsIn } from '../../../domain/gst/returns/gstr9-engine.js';
import { recordAudit } from '../../audit/audit.js';
import { assertFeature } from '../../entitlements/entitlements.js';
import { resolveGstin } from '../gstin-scope.js';
import { loadRegistry, validateDocument } from '../returns/schema-store.js';
import type { ImportLedgerBody, ListLedgerImportsQuery } from './ledger.schemas.js';
import { ledgerRepository, type LedgerImportRow } from './ledger.repository.js';
import { loadLedgerRules } from './rules.js';

const log = createLogger('gst-ledgers');

/** Where return engines get ledger entries. The imported files are the first source. */
export interface LedgerSource {
  /** Entries for the registration whose period falls between the two months (`YYYY-MM`). */
  entries(tx: Tx, gstin: string, fromMonth: string, toMonth: string): Promise<LedgerEntry[]>;
  /** Months each kind of ledger speaks for, within the window. A kind absent has none. */
  coverage(
    tx: Tx,
    gstin: string,
    fromMonth: string,
    toMonth: string,
  ): Promise<Partial<Record<LedgerKind, string[]>>>;
}

export const importedLedgerSource: LedgerSource = {
  entries: (tx, gstin, fromMonth, toMonth) => ledgerRepository.entries(tx, gstin, fromMonth, toMonth),

  async coverage(tx, gstin, fromMonth, toMonth) {
    const rows = await ledgerRepository.coverage(tx, gstin);
    const out: Partial<Record<LedgerKind, string[]>> = {};
    for (const r of rows) {
      const months = monthsIn(r.periodFrom, r.periodTo).filter((m) => m >= fromMonth && m <= toMonth);
      const list = (out[r.kind] ??= []);
      for (const m of months) if (!list.includes(m)) list.push(m);
    }
    for (const list of Object.values(out)) list.sort();
    return out;
  },
};

/**
 * The ledger figures for a window, or null when no ledger was imported for it. The one place
 * GSTR-9 gets ledger input from.
 */
export async function ledgerSummaryFor(
  tx: Tx,
  gstin: string,
  from: string,
  to: string,
  source: LedgerSource = importedLedgerSource,
): Promise<LedgerSummary | null> {
  const fromMonth = from.slice(0, 7);
  const toMonth = to.slice(0, 7);
  const coveredByKind = await source.coverage(tx, gstin, fromMonth, toMonth);
  // A file that touches the window only outside it speaks for none of its months.
  const spoken = Object.fromEntries(
    Object.entries(coveredByKind).filter(([, months]) => months.length > 0),
  ) as Partial<Record<LedgerKind, string[]>>;
  if (Object.keys(spoken).length === 0) return null;
  const entries = await source.entries(tx, gstin, fromMonth, toMonth);
  return summariseLedgers({ entries, rules: loadLedgerRules(), coveredByKind: spoken });
}

/** Stable identity of one event, so the same entry in two overlapping files is kept once. */
export function dedupeKey(entry: LedgerEntry): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        entry.kind,
        entry.date,
        entry.returnPeriod,
        entry.refNo,
        entry.description,
        entry.direction,
        entry.dischargeType,
        entry.amounts,
        entry.itc,
      ]),
    )
    .digest('hex');
}

export function importLedger(body: ImportLedgerBody): Promise<LedgerImportRow> {
  const auth = requireAuthContext();

  return withTransaction(async (tx) => {
    await assertFeature(tx, 'gst_workings');

    const existing = await ledgerRepository.findImport(tx, body.id);
    if (existing) return existing;

    const gstin = await resolveGstin(tx, body.gstin);
    const registry = loadRegistry();
    const now = new Date();
    const version = selectVersion(registry, LEDGER_FORM[body.kind], {
      year: now.getUTCFullYear(),
      month: now.getUTCMonth() + 1,
    });
    const parser = LEDGER_PARSERS[version.id];
    if (!parser) throw new Error(`Registry names ${version.id} but no parser with that id exists.`);

    // The official schemas' free-text patterns are stricter than real descriptions are likely to
    // be, so a pattern violation is reported, not fatal. Every other violation means the file is
    // not the shape the portal publishes.
    const violations = validateDocument(version, body.document);
    const fatal = violations.filter((v) => v.keyword !== 'pattern');
    if (fatal.length > 0) {
      throw new UnprocessableError(
        'This file is not a GSTN ledger of the kind selected.',
        ErrorCode.UNPROCESSABLE,
        { details: { parser: version.id, issues: fatal.slice(0, 20) } },
      );
    }

    const parsed = parser(body.document);
    const blocking = parsed.issues.filter((i) => i.severity === 'error');
    if (blocking.length > 0) {
      throw new UnprocessableError('The ledger file could not be read.', ErrorCode.UNPROCESSABLE, {
        details: { parser: version.id, issues: blocking },
      });
    }
    if (parsed.gstin !== gstin) {
      throw new UnprocessableError(
        'This ledger is for a different GSTIN.',
        ErrorCode.UNPROCESSABLE,
        { details: { file: parsed.gstin, expected: gstin } },
      );
    }

    const sha256 = createHash('sha256').update(JSON.stringify(body.document)).digest('hex');
    const duplicate = await ledgerRepository.findImportBySha(tx, gstin, body.kind, sha256);
    if (duplicate) return duplicate;

    const issues: LedgerIssue[] = [
      ...parsed.issues,
      ...violations.map(
        (v): LedgerIssue => ({
          severity: 'warning',
          code: 'schema_pattern',
          message: `${v.path} ${v.message}`,
        }),
      ),
    ];

    // Which events are new is worked out first, so the import row is written once, complete: the
    // table is append-only, so it cannot be corrected afterwards.
    const keyed = parsed.entries.map((entry) => ({ entry, key: dedupeKey(entry) }));
    const distinct = [...new Set(keyed.map((k) => k.key))];
    const held = await ledgerRepository.existingKeys(tx, gstin, body.kind, distinct);
    const newCount = distinct.filter((k) => !held.has(k)).length;

    // The import row comes first: entries reference it.
    await ledgerRepository.insertImport(tx, {
      id: body.id,
      gstin,
      kind: body.kind,
      periodFrom: parsed.from,
      periodTo: parsed.to,
      parserId: version.id,
      sha256,
      entryCount: parsed.entries.length,
      newEntryCount: newCount,
      issues,
      createdBy: auth.userId,
    });
    const added = await ledgerRepository.insertEntries(tx, body.id, gstin, keyed);
    if (added !== newCount) {
      log.warn({ gstin, kind: body.kind, expected: newCount, added }, 'Ledger new-entry count differs from rows inserted');
    }

    await recordAudit(tx, {
      action: 'gst_ledger.imported',
      entityType: 'gst_ledger_import',
      entityId: body.id,
      metadata: {
        gstin,
        kind: body.kind,
        parser: version.id,
        from: parsed.from,
        to: parsed.to,
        entries: parsed.entries.length,
        added,
      },
    });
    log.info(
      { gstin, kind: body.kind, parser: version.id, entries: parsed.entries.length, added },
      'GST ledger imported',
    );
    const saved = await ledgerRepository.findImport(tx, body.id);
    if (!saved) throw new Error('Ledger import vanished after insert.');
    return saved;
  });
}

export function listLedgerImports(query: ListLedgerImportsQuery): Promise<LedgerImportRow[]> {
  return withReadTransaction(async (tx) => {
    await assertFeature(tx, 'gst_workings');
    return ledgerRepository.list(tx, query.gstin, 50);
  });
}
