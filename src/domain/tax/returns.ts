/**
 * Turns "return N units of invoice line L" into tax-engine input. Pure, and
 * mirrored by the Dart port, because a device issues credit notes offline and
 * the server must arrive at the same totals.
 *
 * Rule: a returned unit carries the same effective price it was sold at. The
 * original line's discounts (its own and its share of the bill discount) are
 * scaled to the returned quantity with the same half-away-from-zero rounding
 * as the engine, then handed to the engine as an amount discount. Rates and
 * the tax-inclusive flag are copied from the invoice unchanged.
 */
import { roundHalfAwayFromZero } from '../../lib/money.js';
import { ValidationError } from '../../lib/errors.js';
import type { TaxLineInput } from './types.js';

export interface SoldLine {
  readonly id: string;
  readonly quantity: number;
  readonly unitPrice: number;
  readonly lineDiscount: number;
  readonly billDiscountShare: number;
  readonly taxRatePercent: number;
  readonly cessRatePercent: number;
  readonly hsnCode: string | null;
}

export interface ReturnRequest {
  readonly id: string;
  readonly invoiceLineId: string;
  readonly quantity: number;
}

export function deriveReturnLine(sold: SoldLine, request: ReturnRequest): TaxLineInput {
  if (!Number.isSafeInteger(request.quantity) || request.quantity <= 0) {
    throw new ValidationError(
      'A returned quantity must be a positive whole number of thousandths.',
      {
        details: { lineId: request.id },
      },
    );
  }
  if (request.quantity > sold.quantity) {
    throw new ValidationError('Cannot return more than was sold on the line.', {
      details: { lineId: request.id, sold: sold.quantity, requested: request.quantity },
    });
  }
  const totalDiscount = sold.lineDiscount + sold.billDiscountShare;
  const scaledDiscount =
    request.quantity === sold.quantity
      ? totalDiscount
      : roundHalfAwayFromZero((totalDiscount * request.quantity) / sold.quantity);

  return {
    id: request.id,
    quantity: request.quantity,
    unitPrice: sold.unitPrice,
    taxRatePercent: sold.taxRatePercent,
    cessRatePercent: sold.cessRatePercent,
    ...(scaledDiscount > 0 ? { discount: { kind: 'amount', value: scaledDiscount } } : {}),
    ...(sold.hsnCode ? { hsnCode: sold.hsnCode } : {}),
  };
}
