/**
 * Validation and print resolution for tenant-defined custom fields.
 *
 * Two callers, deliberately sharing one module:
 *
 * - the invoice and credit-note write paths, which must reject a bag of keys
 *   the tenant never defined before it becomes part of an immutable document;
 * - the print path, which has to turn that bag into ordered, labelled rows.
 *
 * Splitting them would let the two drift, and a field that validates on write
 * but cannot be labelled on print is a bill with a blank line on it.
 */
import type { Tx } from '../../db/tx.js';
import type { PrintField } from '../../domain/print/types.js';
import { ErrorCode, ValidationError } from '../../lib/errors.js';
import { printRepository, type CustomFieldDefinitionRow } from './print.repository.js';

export type CustomFieldDocumentType = 'invoice' | 'credit_note' | 'estimate' | 'sales_order';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Checks a submitted bag against the tenant's definitions.
 *
 * Every failure is collected rather than thrown on the first one: a device
 * that uploads an offline bill should learn about all four bad fields at
 * once, not across four round trips.
 */
export async function validateCustomFields(
  tx: Tx,
  documentType: CustomFieldDocumentType,
  submitted: Record<string, string> | null | undefined,
): Promise<void> {
  const values = submitted ?? {};
  const keys = Object.keys(values);
  const definitions = await printRepository.listDefinitionsFor(tx, documentType);

  // The common case by a wide margin: no definitions and nothing submitted.
  if (definitions.length === 0 && keys.length === 0) return;

  const byKey = new Map(definitions.map((d) => [d.key, d]));
  const fields: Record<string, string> = {};

  const unknown = keys.filter((key) => !byKey.has(key));
  if (unknown.length > 0) {
    throw new ValidationError('The document carries custom fields this business has not defined.', {
      details: { code: ErrorCode.CUSTOM_FIELD_UNKNOWN, keys: unknown },
    });
  }

  for (const definition of definitions) {
    const raw = values[definition.key];
    const present = raw !== undefined && raw.trim() !== '';

    if (!present) {
      if (definition.isRequired) fields[definition.key] = `${definition.label} is required.`;
      continue;
    }
    const problem = checkValue(definition, raw.trim());
    if (problem) fields[definition.key] = problem;
  }

  if (Object.keys(fields).length > 0) {
    throw new ValidationError('One or more custom fields are invalid.', {
      details: { code: ErrorCode.CUSTOM_FIELD_INVALID, fields },
    });
  }
}

function checkValue(definition: CustomFieldDefinitionRow, value: string): string | null {
  switch (definition.dataType) {
    case 'number':
      return Number.isFinite(Number(value)) ? null : 'must be a number';
    case 'date':
      // Same two-step the shared isoDate validator uses: shape, then reality,
      // so 2025-02-30 is rejected rather than silently rolled forward.
      if (!ISO_DATE.test(value)) return 'must be YYYY-MM-DD';
      return new Date(`${value}T00:00:00Z`).toISOString().startsWith(value)
        ? null
        : 'is not a real calendar date';
    case 'boolean':
      return value === 'true' || value === 'false' ? null : "must be 'true' or 'false'";
    case 'text':
      if (definition.maxLength !== null && value.length > definition.maxLength) {
        return `must be at most ${definition.maxLength} characters`;
      }
      return null;
  }
}

/**
 * Turns a stored bag into print rows: defined fields first in `sort_order`,
 * then anything left over.
 *
 * A key whose definition has since been deleted still prints, labelled by a
 * humanised form of the key. Dropping it would quietly remove a line from a
 * document that was legally issued with it — a vehicle number or a PO number
 * that vanishes on reprint is exactly the kind of thing an auditor asks about.
 */
export async function resolveCustomFields(
  tx: Tx,
  documentType: CustomFieldDocumentType,
  stored: Record<string, string> | null | undefined,
): Promise<PrintField[]> {
  const values = stored ?? {};
  const keys = Object.keys(values);
  if (keys.length === 0) return [];

  const definitions = await printRepository.listDefinitionsFor(tx, documentType);
  const seen = new Set<string>();
  const fields: PrintField[] = [];

  for (const definition of definitions) {
    const value = values[definition.key];
    if (value === undefined || value.trim() === '') continue;
    seen.add(definition.key);
    fields.push({ label: definition.label, value: formatValue(definition.dataType, value) });
  }

  for (const key of keys) {
    const value = values[key];
    if (seen.has(key) || value === undefined || value.trim() === '') continue;
    fields.push({ label: humanise(key), value });
  }

  return fields;
}

function formatValue(dataType: CustomFieldDefinitionRow['dataType'], value: string): string {
  if (dataType === 'boolean') return value === 'true' ? 'Yes' : 'No';
  return value;
}

/** `vehicle_no` -> `Vehicle no`. Only ever used for an orphaned key. */
function humanise(key: string): string {
  const spaced = key.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
