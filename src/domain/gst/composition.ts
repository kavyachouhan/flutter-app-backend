/**
 * Composition scheme helpers.
 *
 * A composition dealer charges no tax to the customer: the tax engine handles that, and the print
 * resolver prints the bill-of-supply declaration. The composition return (CMP-08) is not part of
 * this version, so only the default rates (offered when a shop picks its category in settings)
 * and the financial-year quarter helper (used for QRMP return periods) live here.
 */

export type CompositionCategory = 'trader' | 'manufacturer' | 'restaurant' | 'service';

/**
 * The notified rates as of this writing. Used only as the default when a shop
 * has not been told its rate; the stored `tenants.composition_rate_percent` is
 * what any computation actually uses, so an old return keeps its own figure.
 */
export const DEFAULT_COMPOSITION_RATES: Record<CompositionCategory, number> = {
  trader: 1,
  manufacturer: 1,
  restaurant: 5,
  service: 6,
};

/** A financial-year quarter and its bounds. */
export interface CompositionPeriod {
  readonly quarter: number;
  readonly fromYear: number;
  readonly fromMonth: number;
  readonly toYear: number;
  readonly toMonth: number;
}

/**
 * The quarter a month belongs to, and its bounds.
 *
 * Quarterly returns (QRMP) run on the *financial* year, not the calendar one:
 * with an April year start, April-June is quarter one. Using calendar quarters
 * would file every period against the wrong window.
 *
 * Done in absolute months from year zero rather than with modular arithmetic
 * on the month alone, because a quarter straddling the calendar new year
 * (January-March of an April year start) otherwise needs a special case that
 * is easy to get subtly wrong.
 */
export function compositionQuarter(
  year: number,
  month: number,
  fyStartMonth: number,
): CompositionPeriod {
  const fyStartYear = month >= fyStartMonth ? year : year - 1;
  const monthsIntoFy = (month - fyStartMonth + 12) % 12;
  const quarter = Math.floor(monthsIntoFy / 3) + 1;

  // Absolute month index, so crossing December is ordinary addition.
  const fyStartAbsolute = fyStartYear * 12 + (fyStartMonth - 1);
  const fromAbsolute = fyStartAbsolute + (quarter - 1) * 3;
  const toAbsolute = fromAbsolute + 2;

  return {
    quarter,
    fromYear: Math.floor(fromAbsolute / 12),
    fromMonth: (fromAbsolute % 12) + 1,
    toYear: Math.floor(toAbsolute / 12),
    toMonth: (toAbsolute % 12) + 1,
  };
}
