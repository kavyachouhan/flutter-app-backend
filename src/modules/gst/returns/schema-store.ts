/**
 * Loads the official GSTN schemas from `data/gstn-schemas/` and validates mapper output against
 * them. All format knowledge is in that folder and its `registry.json`; this file contains none.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv, { type ValidateFunction } from 'ajv';
import type { MapperIssue } from '../../../domain/gst/returns/mappers/types.js';
import type { RegistryVersion, SchemaRegistry } from '../../../domain/gst/returns/registry.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

function schemaDir(): string {
  const candidates = [
    path.join(REPO_ROOT, 'data', 'gstn-schemas'),
    path.join(process.cwd(), 'data', 'gstn-schemas'),
  ].filter((c): c is string => Boolean(c));
  const found = candidates.find((c) => existsSync(path.join(c, 'registry.json')));
  if (!found) {
    throw new Error(`GSTN schema folder not found (looked in: ${candidates.join(', ')}).`);
  }
  return found;
}

const BOM = String.fromCharCode(0xfeff);

/** Strips a UTF-8 BOM, which some portal downloads carry. */
function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8').replace(BOM, ''));
}

export function loadRegistry(dir: string = schemaDir()): SchemaRegistry {
  return readJson(path.join(dir, 'registry.json')) as SchemaRegistry;
}

/**
 * GSTN's Get response schemas list the fields GSTN fills in (checksums, flags) as required. Our
 * payload is an upload, so those are removed from `required`; this list is data in the registry.
 */
export function relaxRequired(schema: unknown, serverFields: readonly string[]): unknown {
  if (serverFields.length === 0) return schema;
  const drop = new Set(serverFields);
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) {
        out[k] =
          k === 'required' && Array.isArray(v) ? v.filter((f) => !drop.has(String(f))) : walk(v);
      }
      return out;
    }
    return node;
  };
  return walk(schema);
}

export function schemaFiles(version: RegistryVersion): string[] {
  return version.validation.kind === 'single'
    ? [version.validation.schema]
    : Object.values(version.validation.sections);
}

/** Hash of every schema file the version validates against, recorded on each export. */
export function schemaFingerprint(version: RegistryVersion, dir: string = schemaDir()): string {
  const hash = createHash('sha256');
  for (const file of schemaFiles(version).sort()) {
    hash.update(file);
    hash.update(readFileSync(path.join(dir, file)));
  }
  return hash.digest('hex');
}

// `multipleOfPrecision` matters: 0.07 / 0.01 is 7.000000000000001 in floating point, so without it
// ajv rejects perfectly valid rupee amounts such as 0.07 or 1.15 against the portal's "multipleOf 0.01".
const ajv = new Ajv({
  allErrors: true,
  unknownFormats: 'ignore',
  multipleOfPrecision: 2,
  logger: false,
});
const compiled = new Map<string, ValidateFunction>();

function compile(cacheKey: string, schema: unknown): ValidateFunction {
  let fn = compiled.get(cacheKey);
  if (!fn) {
    fn = ajv.compile(schema as object);
    compiled.set(cacheKey, fn);
  }
  return fn;
}

function toIssues(fn: ValidateFunction, prefix: string): MapperIssue[] {
  return (fn.errors ?? []).map((e) => ({
    severity: 'error' as const,
    code: 'schema_invalid',
    message: `${e.dataPath || '(root)'} ${e.message ?? 'is invalid'}`,
    path: `${prefix}${e.dataPath}`,
  }));
}

/**
 * Validates a mapper payload against the official schema(s) of its version. A section the
 * version has no schema for is skipped here: the mapper reports those itself.
 */
export function validatePayload(
  version: RegistryVersion,
  payload: Record<string, unknown>,
  dir: string = schemaDir(),
): MapperIssue[] {
  const server = version.serverPopulatedFields ?? [];
  const load = (file: string): unknown => relaxRequired(readJson(path.join(dir, file)), server);

  if (version.validation.kind === 'single') {
    const fn = compile(`${version.id}:single`, load(version.validation.schema));
    fn(payload);
    return toIssues(fn, '');
  }

  const issues: MapperIssue[] = [];
  for (const [section, file] of Object.entries(version.validation.sections)) {
    if (payload[section] === undefined) continue;
    const fn = compile(`${version.id}:${section}`, load(file));
    fn({ [section]: payload[section] });
    issues.push(...toIssues(fn, ''));
  }
  return issues;
}
