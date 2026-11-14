/**
 * Loads the ledger classification rules from `data/gstn-ledger/classification-rules.json`.
 *
 * The rules are data so that reading a ledger entry differently is an edit to a file that names
 * what it was checked against, not a code change. A malformed rule set stops the return that
 * needs it, loudly, rather than being skipped.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRuleSet, type LedgerRuleSet } from '../../../domain/gst/ledgers/classify.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

function rulesFile(): string {
  const candidates = [
    path.join(REPO_ROOT, 'data', 'gstn-ledger', 'classification-rules.json'),
    path.join(process.cwd(), 'data', 'gstn-ledger', 'classification-rules.json'),
  ];
  const found = candidates.find((c) => existsSync(c));
  if (!found) {
    throw new Error(`Ledger classification rules not found (looked in: ${candidates.join(', ')}).`);
  }
  return found;
}

let cached: LedgerRuleSet | undefined;

export function loadLedgerRules(file: string = rulesFile()): LedgerRuleSet {
  if (cached && file === rulesFile()) return cached;
  const text = readFileSync(file, 'utf8').replace(String.fromCharCode(0xfeff), '');
  const rules = validateRuleSet(JSON.parse(text));
  if (file === rulesFile()) cached = rules;
  return rules;
}
