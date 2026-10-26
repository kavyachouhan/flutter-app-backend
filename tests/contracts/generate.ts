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
import { buildAccessVectors, buildNumberingVectors, buildTaxVectors } from './build.js';

export const CONTRACTS_DIR = fileURLToPath(new URL('../../contracts/', import.meta.url));
export const TAX_VECTORS_PATH = `${CONTRACTS_DIR}tax-vectors.json`;
export const NUMBERING_VECTORS_PATH = `${CONTRACTS_DIR}numbering-vectors.json`;
export const ACCESS_VECTORS_PATH = `${CONTRACTS_DIR}access-vectors.json`;

function write(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

mkdirSync(CONTRACTS_DIR, { recursive: true });
write(TAX_VECTORS_PATH, buildTaxVectors());
write(NUMBERING_VECTORS_PATH, buildNumberingVectors());
write(ACCESS_VECTORS_PATH, buildAccessVectors());
