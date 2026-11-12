/**
 * Turns a neutral return model into a portal JSON file: select the mapper for the return period,
 * map, validate against the official schema, and say honestly how far the result can be trusted.
 */
import { MAPPERS } from '../../../domain/gst/returns/mappers/index.js';
import type { MapperIssue, MapperVerification } from '../../../domain/gst/returns/mappers/types.js';
import type { Gstr1Return, Gstr3bReturn, ReturnPeriod } from '../../../domain/gst/returns/model.js';
import {
  selectVersion,
  type RegistryForm,
  type SchemaRegistry,
} from '../../../domain/gst/returns/registry.js';
import { loadRegistry, schemaFingerprint, validatePayload } from './schema-store.js';

export interface PayloadExport {
  readonly mapperId: string;
  readonly form: RegistryForm;
  readonly verification: MapperVerification;
  readonly schemaSha256: string;
  readonly schemaSnapshot: string;
  readonly payload: Record<string, unknown>;
  readonly issues: readonly MapperIssue[];
  /**
   * True only when the mapper is built from the official schema for this payload AND validation
   * raised no errors. Anything else is a draft and must be labelled so; it is never described as
   * "GST Portal compatible".
   */
  readonly portalReady: boolean;
  readonly status: 'portal_ready' | 'draft' | 'refused';
}

export function exportPayload(
  form: 'gstr1' | 'gstr3b',
  model: Gstr1Return | Gstr3bReturn,
  period: ReturnPeriod,
  registry: SchemaRegistry = loadRegistry(),
): PayloadExport {
  const version = selectVersion(registry, form, period);
  const mapper = MAPPERS[version.id];
  if (!mapper) {
    throw new Error(`Registry names ${version.id} but no mapper with that id is registered.`);
  }

  const result = (
    mapper as unknown as { map(m: unknown): { payload: unknown; issues: readonly MapperIssue[] } }
  ).map(model);
  const payload = result.payload as Record<string, unknown>;
  const issues = [...result.issues, ...validatePayload(version, payload)];
  const hasError = issues.some((i) => i.severity === 'error');
  const verified = version.verification === 'schema_verified';

  return {
    mapperId: version.id,
    form,
    verification: version.verification,
    schemaSha256: schemaFingerprint(version),
    schemaSnapshot: version.schemaSnapshot,
    payload,
    issues,
    portalReady: verified && !hasError,
    status: hasError ? 'refused' : verified ? 'portal_ready' : 'draft',
  };
}
