import { describe, expect, it } from 'vitest';
import { FEATURES, hasFeature, type Feature } from './entitlements.js';
import { PLAN_CODES, PLANS, featureGrantsFor } from './plans.js';

const grants = (plan: (typeof PLAN_CODES)[number]) => featureGrantsFor(plan);
const has = (plan: (typeof PLAN_CODES)[number], feature: Feature) =>
  hasFeature(grants(plan), feature);

describe('the plan matrix', () => {
  it('only grants features that exist', () => {
    for (const code of PLAN_CODES) {
      for (const key of PLANS[code].features) {
        expect(key === '*' || (FEATURES as readonly string[]).includes(key), `${code}: ${key}`).toBe(
          true,
        );
      }
    }
  });

  it('gives the trial and Pro everything', () => {
    for (const feature of FEATURES) {
      expect(has('trial', feature), feature).toBe(true);
      expect(has('pro', feature), feature).toBe(true);
    }
  });

  it('keeps sales orders with Standard and above, like purchases', () => {
    expect(has('lite', 'sales_orders')).toBe(false);
    expect(has('standard', 'sales_orders')).toBe(true);
    // They are sold as the same tier: a plan that buys one buys the other.
    for (const code of PLAN_CODES) {
      expect(has(code, 'sales_orders'), code).toBe(has(code, 'purchases'));
    }
  });

  it('keeps returns on every paid plan, because they are a legal requirement', () => {
    for (const code of ['lite', 'standard', 'pro'] as const) {
      expect(has(code, 'credit_notes'), code).toBe(true);
    }
  });

  it('keeps the Lite tier to billing, returns and offline use', () => {
    expect([...PLANS.lite.features].sort()).toEqual(['credit_notes', 'offline_mode']);
  });
});
