/**
 * The published price list, as code.
 *
 * This is the only file that changes when pricing changes. A plan says which
 * features it grants and where its quotas sit; `FEATURES` in
 * `entitlements.ts` says what a feature key may be.
 *
 * Grants are *seeded* from here into `subscriptions.features`, which stays the
 * runtime source of truth. That split matters: an add-on (an extra device, an
 * extra outlet) and a one-off support grant are per-tenant overrides that must
 * survive a pricing change, so nothing re-reads this table after onboarding.
 * Re-pricing an existing shop is therefore a deliberate act — change the plan
 * and reseed — not a side effect of a deploy.
 *
 * `'*'` is a wildcard grant, resolved by `hasFeature` with the same
 * most-specific-first precedence as any other key, so a wildcard plan can
 * still have one feature explicitly withheld.
 */
import type { Feature } from './entitlements.js';

/** Plan codes the business sells. Mirrors the `subscriptions_plan_check` CHECK. */
export const PLAN_CODES = ['trial', 'lite', 'standard', 'pro'] as const;
export type PlanCode = (typeof PLAN_CODES)[number];

export interface PlanDefinition {
  /** Shown to the user; the prices are inclusive of 18% GST, as advertised. */
  readonly label: string;
  /** Paise per year. Zero for the trial. */
  readonly pricePaisePerYear: number;
  /**
   * Feature keys granted, or `'*'` for all of them. Wildcards are resolved at
   * check time, so a plan granted `'*'` picks up features added later.
   */
  readonly features: readonly (Feature | '*')[];
  /** `null` means unlimited. Add-ons raise these per subscription. */
  readonly maxUsers: number | null;
  readonly maxOutlets: number | null;
  readonly maxCounters: number | null;
  readonly maxItems: number | null;
  readonly maxDevices: number | null;
  /** Days of full access before the plan must be paid for; 0 for a paid plan. */
  readonly trialDays: number;
}

/**
 * Lite covers a single-counter kirana: bill, print, track stock. Standard is
 * the volume tier and the one that unlocks GST workings — the price list sells
 * "GSTR reports" at Standard, not at Pro, so `gst_workings` and `reports.all`
 * belong here. Pro is granted everything; what it actually adds on top of
 * Standard is headroom (outlets, devices, staff) plus the verticals.
 */
export const PLANS = {
  trial: {
    label: 'Trial',
    pricePaisePerYear: 0,
    features: ['*'],
    maxUsers: 5,
    maxOutlets: 1,
    maxCounters: 2,
    maxItems: null,
    maxDevices: 1,
    trialDays: 30,
  },
  lite: {
    label: 'Lite',
    pricePaisePerYear: 149_900,
    // Returns are a legal requirement, not an upsell: a shop that cannot issue
    // a credit note cannot lawfully take goods back.
    features: ['offline_mode', 'credit_notes'],
    maxUsers: 2,
    maxOutlets: 1,
    maxCounters: 1,
    maxItems: null,
    maxDevices: 1,
    trialDays: 0,
  },
  standard: {
    label: 'Standard',
    pricePaisePerYear: 299_900,
    features: [
      'offline_mode',
      'credit_notes',
      // "Full inventory" on the price list: buying as well as selling, and the
      // pricing and bulk tools that go with running a real catalogue.
      'purchases',
      'price_lists',
      'discount_rules',
      'bulk_edit',
      'barcode_printing',
      // "GSTR reports" on the price list.
      'reports.all',
      'gst_workings',
      'storefront',
    ],
    maxUsers: 5,
    maxOutlets: 1,
    maxCounters: 2,
    maxItems: null,
    maxDevices: 2,
    trialDays: 0,
  },
  pro: {
    label: 'Pro',
    pricePaisePerYear: 599_900,
    features: ['*'],
    maxUsers: null,
    maxOutlets: 5,
    maxCounters: null,
    maxItems: null,
    maxDevices: 3,
    trialDays: 0,
  },
} as const satisfies Record<PlanCode, PlanDefinition>;

/** The plan a shop lands on at onboarding, before it has paid for anything. */
export const DEFAULT_PLAN: PlanCode = 'trial';

export function isPlanCode(value: string): value is PlanCode {
  return (PLAN_CODES as readonly string[]).includes(value);
}

/**
 * The plan's grants in the shape `subscriptions.features` stores — a map of
 * key to `true`, so a later support grant or withholding is a single key edit
 * rather than a rewrite.
 */
export function featureGrantsFor(plan: PlanCode): Record<string, true> {
  return Object.fromEntries(PLANS[plan].features.map((key) => [key, true]));
}
