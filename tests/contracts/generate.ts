/**
 * Writes contracts/tax-vectors.json and contracts/numbering-vectors.json.
 * Run `npm run contracts:generate` after any deliberate change to the tax
 * engine or numbering rules; the contract test fails until you do, which is
 * the point — a silent change in totals must not reach the Dart port.
 */
// First, so the environment exists before the app modules the vectors read are loaded.
import '../setup/setup-env.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildAccessVectors,
  buildCostingVectors,
  buildEntityVectors,
  buildGstinVectors,
  buildNumberingVectors,
  buildRegistrationVectors,
  buildReturnsVectors,
  buildRuleSetVectors,
  buildTaxVectors,
  buildTosVectors,
} from './build.js';

export const CONTRACTS_DIR = fileURLToPath(new URL('../../contracts/', import.meta.url));
export const TAX_VECTORS_PATH = `${CONTRACTS_DIR}tax-vectors.json`;
export const NUMBERING_VECTORS_PATH = `${CONTRACTS_DIR}numbering-vectors.json`;
export const ACCESS_VECTORS_PATH = `${CONTRACTS_DIR}access-vectors.json`;
export const COSTING_VECTORS_PATH = `${CONTRACTS_DIR}costing-vectors.json`;
export const RETURNS_VECTORS_PATH = `${CONTRACTS_DIR}returns-vectors.json`;
export const GSTIN_VECTORS_PATH = `${CONTRACTS_DIR}gstin-vectors.json`;
export const RULESET_VECTORS_PATH = `${CONTRACTS_DIR}ruleset-vectors.json`;
export const REGISTRATION_VECTORS_PATH = `${CONTRACTS_DIR}registration-vectors.json`;
export const ENTITY_VECTORS_PATH = `${CONTRACTS_DIR}entity-vectors.json`;
export const TOS_VECTORS_PATH = `${CONTRACTS_DIR}tos-vectors.json`;

function write(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

mkdirSync(CONTRACTS_DIR, { recursive: true });
write(TAX_VECTORS_PATH, buildTaxVectors());
write(NUMBERING_VECTORS_PATH, buildNumberingVectors());
write(ACCESS_VECTORS_PATH, buildAccessVectors());
write(COSTING_VECTORS_PATH, buildCostingVectors());
write(RETURNS_VECTORS_PATH, buildReturnsVectors());
write(GSTIN_VECTORS_PATH, buildGstinVectors());
write(RULESET_VECTORS_PATH, buildRuleSetVectors());
write(REGISTRATION_VECTORS_PATH, buildRegistrationVectors());
write(ENTITY_VECTORS_PATH, buildEntityVectors());
write(TOS_VECTORS_PATH, buildTosVectors());
