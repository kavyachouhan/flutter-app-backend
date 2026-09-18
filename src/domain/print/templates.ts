/**
 * Print templates.
 *
 * A template is a set of decisions about *what appears* on a document, not
 * about where it sits. Layout stays in code on the device: tenant-authored
 * layouts are a rendering-compatibility problem across ESC/POS and PDF that
 * never ends, and the one thing a merchant actually asks for — "show my HSN
 * codes", "add a vehicle number", "print two copies" — is a setting, not a
 * layout.
 */

export const TEMPLATE_KEYS = ['thermal_compact', 'thermal_detailed', 'a4_tax', 'a4_tally'] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

export interface TemplateDefinition {
  readonly key: TemplateKey;
  readonly title: string;
  readonly description: string;
  readonly paper: 'thermal' | 'a4';
  /** HSN and per-line tax columns: required on a B2B tax invoice, noise on a kirana receipt. */
  readonly showHsn: boolean;
  readonly showTaxColumn: boolean;
  /** The rate-wise GST summary block. */
  readonly showTaxSummary: boolean;
  readonly showAmountInWords: boolean;
  readonly showCustomerBlock: boolean;
  readonly showSignature: boolean;
  /** Copy labels required on an A4 tax invoice under GST rule 48. */
  readonly copyLabels: readonly string[];
}

export const TEMPLATES: Record<TemplateKey, TemplateDefinition> = {
  thermal_compact: {
    key: 'thermal_compact',
    title: 'Thermal — compact',
    description: 'The shortest legal receipt. What a kirana counter wants.',
    paper: 'thermal',
    showHsn: false,
    showTaxColumn: false,
    showTaxSummary: false,
    showAmountInWords: false,
    showCustomerBlock: true,
    showSignature: false,
    copyLabels: [],
  },
  thermal_detailed: {
    key: 'thermal_detailed',
    title: 'Thermal — detailed',
    description: 'Adds HSN codes and the rate-wise tax summary. For B2B counters.',
    paper: 'thermal',
    showHsn: true,
    showTaxColumn: true,
    showTaxSummary: true,
    showAmountInWords: false,
    showCustomerBlock: true,
    showSignature: false,
    copyLabels: [],
  },
  a4_tax: {
    key: 'a4_tax',
    title: 'A4 tax invoice',
    description: 'Full GST invoice with copy labels, tax summary and signature.',
    paper: 'a4',
    showHsn: true,
    showTaxColumn: true,
    showTaxSummary: true,
    showAmountInWords: true,
    showCustomerBlock: true,
    showSignature: true,
    copyLabels: [
      'ORIGINAL FOR RECIPIENT',
      'DUPLICATE FOR TRANSPORTER',
      'TRIPLICATE FOR SUPPLIER',
    ],
  },
  a4_tally: {
    key: 'a4_tally',
    title: 'A4 — Tally style',
    description: 'The layout an accountant expects to receive.',
    paper: 'a4',
    showHsn: true,
    showTaxColumn: true,
    showTaxSummary: true,
    showAmountInWords: true,
    showCustomerBlock: true,
    showSignature: true,
    copyLabels: ['ORIGINAL FOR RECIPIENT'],
  },
};

export function isTemplateKey(value: string): value is TemplateKey {
  return (TEMPLATE_KEYS as readonly string[]).includes(value);
}

/** Overrides a tenant may apply without authoring a layout. */
export interface TemplateOverrides {
  readonly showHsn?: boolean;
  readonly showTaxColumn?: boolean;
  readonly showTaxSummary?: boolean;
  readonly showAmountInWords?: boolean;
  readonly showSignature?: boolean;
}

export function resolveTemplate(
  key: TemplateKey,
  overrides: TemplateOverrides | null,
): TemplateDefinition {
  const base = TEMPLATES[key];
  if (!overrides) return base;
  return {
    ...base,
    showHsn: overrides.showHsn ?? base.showHsn,
    showTaxColumn: overrides.showTaxColumn ?? base.showTaxColumn,
    showTaxSummary: overrides.showTaxSummary ?? base.showTaxSummary,
    showAmountInWords: overrides.showAmountInWords ?? base.showAmountInWords,
    showSignature: overrides.showSignature ?? base.showSignature,
  };
}
