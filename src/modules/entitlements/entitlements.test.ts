import { describe, expect, it } from 'vitest';
import { FEATURES, hasFeature } from './entitlements.js';

describe('hasFeature', () => {
  it('grants nothing when the plan lists nothing', () => {
    expect(hasFeature({}, 'purchases')).toBe(false);
  });

  it('grants an explicitly listed feature', () => {
    expect(hasFeature({ purchases: true }, 'purchases')).toBe(true);
  });

  it('does not let one feature grant another', () => {
    expect(hasFeature({ purchases: true }, 'tally_sync')).toBe(false);
  });

  it('grants everything under a group wildcard', () => {
    expect(hasFeature({ 'vertical.*': true }, 'vertical.pharmacy')).toBe(true);
  });

  it('does not let a group wildcard escape its group', () => {
    expect(hasFeature({ 'vertical.*': true }, 'tally_sync')).toBe(false);
  });

  it('grants everything under the global wildcard', () => {
    expect(hasFeature({ '*': true }, 'einvoice')).toBe(true);
  });

  // How a single capability is withheld from an otherwise unlimited plan.
  it('lets an explicit denial override a wildcard grant', () => {
    expect(hasFeature({ '*': true, einvoice: false }, 'einvoice')).toBe(false);
    expect(
      hasFeature({ 'vertical.*': true, 'vertical.pharmacy': false }, 'vertical.pharmacy'),
    ).toBe(false);
  });

  it('prefers the group wildcard over the global one', () => {
    expect(hasFeature({ '*': true, 'vertical.*': false }, 'vertical.pharmacy')).toBe(false);
  });

  it('ignores values that are not booleans', () => {
    expect(hasFeature({ purchases: 'yes' }, 'purchases')).toBe(false);
  });

  it('has no duplicate keys in the catalogue', () => {
    expect(new Set(FEATURES).size).toBe(FEATURES.length);
  });
});
