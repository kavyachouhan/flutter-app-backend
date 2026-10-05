import type { Tx } from '../../db/tx.js';
import { buildSet } from '../../db/sql.js';
import type { TemplateKey } from '../../domain/print/templates.js';

/**
 * A stored profile. Every override is nullable because NULL means "inherit" —
 * from the outlet's tenant-wide default, and failing that from the template.
 */
export interface PrintProfileRow {
  id: string;
  outletId: string | null;
  templateKey: TemplateKey;
  showHsn: boolean | null;
  showTaxColumn: boolean | null;
  showTaxSummary: boolean | null;
  showAmountInWords: boolean | null;
  showSignature: boolean | null;
  logoObjectKey: string | null;
  signatureObjectKey: string | null;
  signatureLabel: string | null;
  upiId: string | null;
  bankLines: string[];
  termsLines: string[];
  footerLines: string[];
  lookupBaseUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CustomFieldDefinitionRow {
  id: string;
  key: string;
  label: string;
  dataType: 'text' | 'number' | 'date' | 'boolean';
  isRequired: boolean;
  sortOrder: number;
  documentTypes: string[];
  maxLength: number | null;
  placeholder: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const PROFILE_COLUMNS = `
  id, outlet_id AS "outletId", template_key AS "templateKey", show_hsn AS "showHsn",
  show_tax_column AS "showTaxColumn", show_tax_summary AS "showTaxSummary",
  show_amount_in_words AS "showAmountInWords", show_signature AS "showSignature",
  logo_object_key AS "logoObjectKey", signature_object_key AS "signatureObjectKey",
  signature_label AS "signatureLabel", upi_id AS "upiId", bank_lines AS "bankLines",
  terms_lines AS "termsLines", footer_lines AS "footerLines", lookup_base_url AS "lookupBaseUrl",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

const DEFINITION_COLUMNS = `
  id, key, label, data_type AS "dataType", is_required AS "isRequired", sort_order AS "sortOrder",
  document_types AS "documentTypes", max_length AS "maxLength", placeholder, is_active AS "isActive",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

const PROFILE_UPDATABLE = {
  templateKey: 'template_key',
  showHsn: 'show_hsn',
  showTaxColumn: 'show_tax_column',
  showTaxSummary: 'show_tax_summary',
  showAmountInWords: 'show_amount_in_words',
  showSignature: 'show_signature',
  logoObjectKey: 'logo_object_key',
  signatureObjectKey: 'signature_object_key',
  signatureLabel: 'signature_label',
  upiId: 'upi_id',
  bankLines: 'bank_lines',
  termsLines: 'terms_lines',
  footerLines: 'footer_lines',
  lookupBaseUrl: 'lookup_base_url',
} as const;

const DEFINITION_UPDATABLE = {
  label: 'label',
  dataType: 'data_type',
  isRequired: 'is_required',
  sortOrder: 'sort_order',
  documentTypes: 'document_types',
  maxLength: 'max_length',
  placeholder: 'placeholder',
  isActive: 'is_active',
} as const;

export interface NewPrintProfile {
  id: string;
  outletId: string | null;
  templateKey: TemplateKey;
  showHsn: boolean | null;
  showTaxColumn: boolean | null;
  showTaxSummary: boolean | null;
  showAmountInWords: boolean | null;
  showSignature: boolean | null;
  logoObjectKey: string | null;
  signatureObjectKey: string | null;
  signatureLabel: string | null;
  upiId: string | null;
  bankLines: readonly string[];
  termsLines: readonly string[];
  footerLines: readonly string[];
  lookupBaseUrl: string | null;
}

export interface NewCustomFieldDefinition {
  id: string;
  key: string;
  label: string;
  dataType: 'text' | 'number' | 'date' | 'boolean';
  isRequired: boolean;
  sortOrder: number;
  documentTypes: readonly string[];
  maxLength: number | null;
  placeholder: string | null;
}

/** The business and document context a print payload needs beyond the invoice itself. */
export interface PrintContextRow {
  cashierName: string | null;
  counterName: string | null;
}

export const printRepository = {
  listProfiles(tx: Tx): Promise<PrintProfileRow[]> {
    return tx.many<PrintProfileRow>(
      `SELECT ${PROFILE_COLUMNS} FROM print_profiles WHERE deleted_at IS NULL
       ORDER BY outlet_id NULLS FIRST`,
    );
  },

  /**
   * The outlet's profile and the tenant default in one trip, default first so
   * the service can fold them in order without a second query.
   */
  findProfilesForOutlet(tx: Tx, outletId: string): Promise<PrintProfileRow[]> {
    return tx.many<PrintProfileRow>(
      `SELECT ${PROFILE_COLUMNS} FROM print_profiles
       WHERE deleted_at IS NULL AND (outlet_id IS NULL OR outlet_id = $1)
       ORDER BY outlet_id NULLS FIRST`,
      [outletId],
    );
  },

  findProfile(tx: Tx, outletId: string | null): Promise<PrintProfileRow | undefined> {
    return tx.one<PrintProfileRow>(
      `SELECT ${PROFILE_COLUMNS} FROM print_profiles
       WHERE deleted_at IS NULL AND outlet_id IS NOT DISTINCT FROM $1`,
      [outletId],
    );
  },

  async insertProfile(tx: Tx, p: NewPrintProfile): Promise<void> {
    await tx.query(
      `INSERT INTO print_profiles (id, tenant_id, outlet_id, template_key, show_hsn, show_tax_column,
         show_tax_summary, show_amount_in_words, show_signature, logo_object_key, signature_object_key,
         signature_label, upi_id, bank_lines, terms_lines, footer_lines, lookup_base_url)
       VALUES ($1, app.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        p.id,
        p.outletId,
        p.templateKey,
        p.showHsn,
        p.showTaxColumn,
        p.showTaxSummary,
        p.showAmountInWords,
        p.showSignature,
        p.logoObjectKey,
        p.signatureObjectKey,
        p.signatureLabel,
        p.upiId,
        [...p.bankLines],
        [...p.termsLines],
        [...p.footerLines],
        p.lookupBaseUrl,
      ],
    );
  },

  async updateProfile(tx: Tx, id: string, patch: Record<string, unknown>): Promise<void> {
    const { clause, values } = buildSet(patch, PROFILE_UPDATABLE, 2);
    if (clause)
      await tx.query(`UPDATE print_profiles SET ${clause} WHERE id = $1`, [id, ...values]);
  },

  listDefinitions(tx: Tx, includeInactive: boolean): Promise<CustomFieldDefinitionRow[]> {
    return tx.many<CustomFieldDefinitionRow>(
      `SELECT ${DEFINITION_COLUMNS} FROM custom_field_definitions
       WHERE deleted_at IS NULL AND ($1::boolean OR is_active)
       ORDER BY sort_order, key`,
      [includeInactive],
    );
  },

  /**
   * Active definitions for one document type, in print order.
   *
   * `@>` rather than `= ANY` so the GIN-friendly containment form is used and
   * the predicate reads the same way the column is written.
   */
  listDefinitionsFor(tx: Tx, documentType: string): Promise<CustomFieldDefinitionRow[]> {
    return tx.many<CustomFieldDefinitionRow>(
      `SELECT ${DEFINITION_COLUMNS} FROM custom_field_definitions
       WHERE deleted_at IS NULL AND is_active AND document_types @> ARRAY[$1]::text[]
       ORDER BY sort_order, key`,
      [documentType],
    );
  },

  findDefinition(tx: Tx, id: string): Promise<CustomFieldDefinitionRow | undefined> {
    return tx.one<CustomFieldDefinitionRow>(
      `SELECT ${DEFINITION_COLUMNS} FROM custom_field_definitions
       WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
  },

  async insertDefinition(tx: Tx, d: NewCustomFieldDefinition): Promise<void> {
    await tx.query(
      `INSERT INTO custom_field_definitions (id, tenant_id, key, label, data_type, is_required,
         sort_order, document_types, max_length, placeholder)
       VALUES ($1, app.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        d.id,
        d.key,
        d.label,
        d.dataType,
        d.isRequired,
        d.sortOrder,
        [...d.documentTypes],
        d.maxLength,
        d.placeholder,
      ],
    );
  },

  async updateDefinition(tx: Tx, id: string, patch: Record<string, unknown>): Promise<void> {
    const { clause, values } = buildSet(patch, DEFINITION_UPDATABLE, 2);
    if (clause)
      await tx.query(`UPDATE custom_field_definitions SET ${clause} WHERE id = $1`, [
        id,
        ...values,
      ]);
  },

  /**
   * Soft delete, never hard: issued invoices still carry the key in their
   * custom_fields and must keep printing with a proper label.
   */
  async softDeleteDefinition(tx: Tx, id: string): Promise<void> {
    await tx.query(
      'UPDATE custom_field_definitions SET deleted_at = now(), is_active = false WHERE id = $1',
      [id],
    );
  },

  /** Cashier and counter names, which the bill shows but the document does not store. */
  async findContext(
    tx: Tx,
    issuedBy: string,
    counterId: string | null,
  ): Promise<PrintContextRow | undefined> {
    return tx.one<PrintContextRow>(
      `SELECT (SELECT name FROM users WHERE id = $1)                   AS "cashierName",
              (SELECT name FROM counters WHERE id = $2::uuid)          AS "counterName"`,
      [issuedBy, counterId],
    );
  },

  /** Address and state code for the party block; the names themselves are snapshotted. */
  findCustomerDetails(tx: Tx, customerId: string) {
    return tx.one<{
      addressLine1: string | null;
      addressLine2: string | null;
      city: string | null;
      pincode: string | null;
      stateCode: string | null;
      phone: string | null;
    }>(
      `SELECT address_line1 AS "addressLine1", address_line2 AS "addressLine2", city, pincode,
              state_code AS "stateCode", phone
       FROM customers WHERE id = $1`,
      [customerId],
    );
  },
};
