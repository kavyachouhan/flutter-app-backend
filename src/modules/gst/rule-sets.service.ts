/**
 * Serves published GST rule sets and the HSN/SAC master to devices (freeze §6.4). Both are global
 * reference data read from the database, so a published change reaches devices without a release.
 */
import { withReadTransaction } from '../../db/tx.js';
import type { GstRuleSet } from '../../domain/gst/rule-set.js';

export interface PublishedRuleSet extends GstRuleSet {
  readonly changedAt: string;
}

/** Published and withdrawn versions, so a device also learns a version was withdrawn. */
export async function listRuleSets(since: string | undefined): Promise<PublishedRuleSet[]> {
  return withReadTransaction((tx) =>
    tx.many<PublishedRuleSet & Record<string, unknown>>(
      `SELECT version, to_char(effective_from, 'YYYY-MM-DD') AS "effectiveFrom", revision, supersedes,
              status, content,
              to_char(GREATEST(published_at, withdrawn_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                AS "changedAt"
         FROM gst_rule_sets
        WHERE status IN ('published', 'withdrawn')
          AND ($1::timestamptz IS NULL OR GREATEST(published_at, withdrawn_at) > $1::timestamptz)
        ORDER BY effective_from, revision`,
      [since ?? null],
    ),
  );
}

export interface HsnMaster {
  readonly version: string | null;
  /** [code, kind, description, parentCode], compact because a device stores about 22,000. */
  readonly codes: readonly (readonly [string, string, string, string | null])[];
}

/** The whole master, or nothing when the device already holds this version. */
export async function hsnMaster(heldVersion: string | undefined): Promise<HsnMaster> {
  return withReadTransaction(async (tx) => {
    const current = await tx.many<{ version: string }>(
      'SELECT DISTINCT source_version AS version FROM hsn_master LIMIT 1',
    );
    const version = current[0]?.version ?? null;
    if (version === null || version === heldVersion) return { version, codes: [] };
    const rows = await tx.many<{ code: string; kind: string; description: string; parentCode: string | null }>(
      `SELECT code, kind, description, parent_code AS "parentCode" FROM hsn_master ORDER BY code`,
    );
    return { version, codes: rows.map((r) => [r.code, r.kind, r.description, r.parentCode] as const) };
  });
}
