/**
 * Composition scheme: the one piece of the scheme the system never computed.
 *
 * A composition dealer charges no tax to the customer — the tax engine already
 * handles that, and the print resolver already prints the declaration — but
 * still owes a flat percentage of turnover to the department, quarterly, on
 * CMP-08. Nothing computed that liability, so a composition shop using this
 * system could bill correctly all quarter and still have no idea what to pay.
 *
 * Pure, and the rates are passed in rather than hard-coded: they move by
 * notification, and a CMP-08 filed last year must keep reporting the rate it
 * was filed at.
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

export interface CompositionTurnover {
  /**
   * Taxable outward supplies in the period, in paise, net of credit notes.
   *
   * Composition turnover is the whole value billed, not a taxable value net of
   * tax: the dealer charged no tax, so the two are the same figure. Returns
   * reduce it, which is why this is already net — a quarter with heavy returns
   * otherwise overstates the liability and the shop overpays.
   */
  readonly outwardSupplies: number;
  /**
   * Inward supplies liable to reverse charge, in paise. A composition dealer
   * still pays reverse-charge tax at the normal rate and cannot claim it as
   * credit, so it is a separate liability rather than part of turnover.
   */
  readonly reverseChargeInward: number;
  /** Tax on those inward supplies, at the normal rates. */
  readonly reverseChargeTax: number;
}

export interface CompositionLiability {
  readonly turnover: number;
  readonly ratePercent: number;
  /** The flat tax on turnover. */
  readonly taxOnTurnover: number;
  /** Reverse-charge tax, which is owed on top and is never creditable here. */
  readonly reverseChargeTax: number;
  readonly totalPayable: number;
}

/**
 * CMP-08 liability for a period.
 *
 * Rounded half away from zero to the paisa, matching the tax engine, so a
 * figure shown on screen and a figure filed cannot differ by a rounding rule.
 */
export function compositionLiability(
  turnover: CompositionTurnover,
  ratePercent: number,
): CompositionLiability {
  if (!Number.isFinite(ratePercent) || ratePercent < 0) {
    throw new Error('A composition rate must be a non-negative percentage.');
  }
  const base = Math.max(0, turnover.outwardSupplies);
  const taxOnTurnover = Math.round((base * ratePercent) / 100);
  return {
    turnover: base,
    ratePercent,
    taxOnTurnover,
    reverseChargeTax: turnover.reverseChargeTax,
    totalPayable: taxOnTurnover + turnover.reverseChargeTax,
  };
}

/**
 * The quarter a month belongs to, and its bounds.
 *
 * CMP-08 is quarterly on the financial year, not the calendar one: April-June
 * is quarter one. Taking calendar quarters would file every period against the
 * wrong window.
 */
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
 * CMP-08 is quarterly on the *financial* year, not the calendar one: with an
 * April year start, April-June is quarter one. Using calendar quarters would
 * file every period against the wrong window.
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
