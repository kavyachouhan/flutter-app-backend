import type { Tx } from '../../db/tx.js';
import { buildSet } from '../../db/sql.js';
import { NotFoundError } from '../../lib/errors.js';

export interface TenantRow {
  id: string;
  name: string;
  legalName: string | null;
  isGstRegistered: boolean;
  gstin: string | null;
  isComposition: boolean;
  /** Decides the CMP-08 rate. Null until a composition shop is asked. */
  compositionCategory: 'trader' | 'manufacturer' | 'restaurant' | 'service' | null;
  /** NUMERIC: a string from pg. Stored, not derived, so an old return keeps its rate. */
  compositionRatePercent: string | null;
  filingFrequency: 'monthly' | 'qrmp';
  registrationEffectiveFrom: string | null;
  pan: string | null;
  stateCode: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  pincode: string | null;
  phone: string | null;
  email: string | null;
  locale: string;
  timezone: string;
  currencyCode: string;
  currencySymbol: string;
  fyStartMonth: number;
  allowNegativeStock: boolean;
  defaultPricesIncludeTax: boolean;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export type NewTenant = Omit<TenantRow, 'status' | 'createdAt' | 'updatedAt'>;

export type TenantSettings = Pick<
  TenantRow,
  | 'stateCode'
  | 'gstin'
  | 'isGstRegistered'
  | 'isComposition'
  | 'compositionCategory'
  | 'compositionRatePercent'
  | 'filingFrequency'
  | 'registrationEffectiveFrom'
  | 'fyStartMonth'
  // The business day boundary for cash-up and reports is the shop's local
  // midnight, not the server's.
  | 'timezone'
  | 'allowNegativeStock'
  | 'defaultPricesIncludeTax'
>;

const TENANT_COLUMNS = `
  id, name, legal_name AS "legalName", is_gst_registered AS "isGstRegistered", gstin,
  is_composition AS "isComposition", composition_category AS "compositionCategory",
  composition_rate_percent AS "compositionRatePercent", filing_frequency AS "filingFrequency",
  registration_effective_from AS "registrationEffectiveFrom",
  pan, state_code AS "stateCode", address_line1 AS "addressLine1",
  address_line2 AS "addressLine2", city, pincode, phone, email, locale, timezone,
  currency_code AS "currencyCode", currency_symbol AS "currencySymbol", fy_start_month AS "fyStartMonth",
  allow_negative_stock AS "allowNegativeStock", default_prices_include_tax AS "defaultPricesIncludeTax",
  status, created_at AS "createdAt", updated_at AS "updatedAt"`;

const UPDATABLE = {
  name: 'name',
  legalName: 'legal_name',
  isGstRegistered: 'is_gst_registered',
  gstin: 'gstin',
  isComposition: 'is_composition',
  compositionCategory: 'composition_category',
  compositionRatePercent: 'composition_rate_percent',
  filingFrequency: 'filing_frequency',
  registrationEffectiveFrom: 'registration_effective_from',
  pan: 'pan',
  stateCode: 'state_code',
  addressLine1: 'address_line1',
  addressLine2: 'address_line2',
  city: 'city',
  pincode: 'pincode',
  phone: 'phone',
  email: 'email',
  locale: 'locale',
  timezone: 'timezone',
  currencyCode: 'currency_code',
  currencySymbol: 'currency_symbol',
  fyStartMonth: 'fy_start_month',
  allowNegativeStock: 'allow_negative_stock',
  defaultPricesIncludeTax: 'default_prices_include_tax',
} as const;

export const tenantsRepository = {
  findCurrent(tx: Tx): Promise<TenantRow | undefined> {
    return tx.one<TenantRow>(
      `SELECT ${TENANT_COLUMNS} FROM tenants WHERE id = app.current_tenant_id()`,
    );
  },

  async insert(tx: Tx, t: NewTenant): Promise<void> {
    await tx.query(
      `INSERT INTO tenants (id, name, legal_name, is_gst_registered, gstin, is_composition, pan, state_code,
         address_line1, address_line2, city, pincode, phone, email, locale, timezone, currency_code,
         currency_symbol, fy_start_month, allow_negative_stock, default_prices_include_tax,
         composition_category, composition_rate_percent, filing_frequency,
         registration_effective_from, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21,
         $22, $23, $24, $25, 'active')`,
      [
        t.id,
        t.name,
        t.legalName,
        t.isGstRegistered,
        t.gstin,
        t.isComposition,
        t.pan,
        t.stateCode,
        t.addressLine1,
        t.addressLine2,
        t.city,
        t.pincode,
        t.phone,
        t.email,
        t.locale,
        t.timezone,
        t.currencyCode,
        t.currencySymbol,
        t.fyStartMonth,
        t.allowNegativeStock,
        t.defaultPricesIncludeTax,
        t.compositionCategory,
        t.compositionRatePercent,
        t.filingFrequency,
        t.registrationEffectiveFrom,
      ],
    );
  },

  async update(tx: Tx, patch: Record<string, unknown>): Promise<void> {
    const { clause, values } = buildSet(patch, UPDATABLE, 1);
    if (clause)
      await tx.query(`UPDATE tenants SET ${clause} WHERE id = app.current_tenant_id()`, values);
  },

  async getSettings(tx: Tx): Promise<TenantSettings> {
    const row = await tx.one<TenantSettings>(
      `SELECT state_code AS "stateCode", gstin, is_gst_registered AS "isGstRegistered",
              is_composition AS "isComposition", composition_category AS "compositionCategory",
              composition_rate_percent AS "compositionRatePercent",
              filing_frequency AS "filingFrequency",
              registration_effective_from AS "registrationEffectiveFrom",
              fy_start_month AS "fyStartMonth", timezone,
              allow_negative_stock AS "allowNegativeStock", default_prices_include_tax AS "defaultPricesIncludeTax"
       FROM tenants WHERE id = app.current_tenant_id()`,
    );
    if (!row) throw new NotFoundError('Tenant');
    return row;
  },
};
