/**
 * Turns items into label payloads.
 *
 * Same doctrine as `src/domain/print/resolve.ts`: every string arrives
 * formatted, the device draws and does not calculate. The one addition is
 * choosing a symbology, which is a decision with a wrong answer — print the
 * wrong encoding and the label either refuses to render or scans back as
 * something the till does not recognise.
 */
import { formatCurrency, formatQuantity } from '../print/format.js';
import type { LabelTemplate } from './templates.js';

export type Symbology = 'ean13' | 'ean8' | 'upca' | 'code128';

export interface LabelBarcode {
  readonly value: string;
  readonly symbology: Symbology;
  /** False when the value had to fall back from a retail symbology. */
  readonly isRetailCode: boolean;
}

export interface LabelItem {
  readonly itemId: string;
  readonly name: string;
  readonly unit: string | null;
  readonly code: string | null;
  readonly barcodes: readonly string[];
  readonly mrp: number | null;
  readonly salePrice: number;
}

export interface ResolvedLabel {
  readonly itemId: string;
  /** The name, wrapped to the template's width. */
  readonly lines: readonly string[];
  readonly priceText: string | null;
  readonly secondaryText: string | null;
  readonly barcode: LabelBarcode;
  readonly barcodeText: string | null;
  readonly copies: number;
}

export interface LabelError {
  readonly itemId: string;
  readonly name: string;
  readonly reason: string;
}

export interface ResolveLabelsInput {
  readonly items: readonly { item: LabelItem; copies: number }[];
  readonly template: LabelTemplate;
  readonly priceField: 'mrp' | 'salePrice' | 'none';
  readonly currencySymbol: string;
}

export interface ResolvedLabels {
  readonly labels: readonly ResolvedLabel[];
  readonly errors: readonly LabelError[];
  readonly totalLabels: number;
}

/**
 * EAN-13 / EAN-8 / UPC-A check digit: weighted sum from the right, ×3 on
 * alternate positions, padded up to the next multiple of ten.
 */
function hasValidCheckDigit(digits: string): boolean {
  const body = digits.slice(0, -1);
  const expected = Number(digits.slice(-1));
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const digit = Number(body[body.length - 1 - i]);
    sum += i % 2 === 0 ? digit * 3 : digit;
  }
  return (10 - (sum % 10)) % 10 === expected;
}

/**
 * Picks the encoding for a barcode value.
 *
 * A 13-digit value is only EAN-13 if its check digit is right. Many shops
 * use 13-digit internal codes that are not valid EAN, and a renderer handed
 * `ean13` for one of those either throws or silently "corrects" the last
 * digit — which prints a label that scans as a different product.
 *
 * Falling back to Code 128 is the safe answer: it encodes the exact
 * characters, so the scanner always returns the string the shop stored.
 */
export function chooseSymbology(value: string): LabelBarcode {
  const numeric = /^\d+$/.test(value);
  if (numeric && hasValidCheckDigit(value)) {
    if (value.length === 13) return { value, symbology: 'ean13', isRetailCode: true };
    if (value.length === 12) return { value, symbology: 'upca', isRetailCode: true };
    if (value.length === 8) return { value, symbology: 'ean8', isRetailCode: true };
  }
  return { value, symbology: 'code128', isRetailCode: false };
}

/**
 * Wraps on word boundaries, breaking a single over-long word rather than
 * letting it overflow, and marks truncation with an ellipsis so nobody reads
 * a cut-off name as the whole name.
 */
export function wrapName(name: string, maxChars: number, maxLines: number): string[] {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const lines: string[] = [];
  let line = '';

  for (const word of words) {
    if (line === '') {
      line = word;
    } else if (line.length + 1 + word.length <= maxChars) {
      line = `${line} ${word}`;
      continue;
    } else {
      lines.push(line);
      line = word;
    }
    // A word longer than the label gets hard-broken.
    while (line.length > maxChars) {
      lines.push(line.slice(0, maxChars));
      line = line.slice(maxChars);
      if (lines.length >= maxLines) break;
    }
    if (lines.length >= maxLines) break;
  }
  if (line !== '' && lines.length < maxLines) lines.push(line);

  if (lines.length > maxLines) lines.length = maxLines;
  const last = lines[lines.length - 1];
  const consumed = lines.join(' ').replace(/\s+/g, ' ').length;
  if (last !== undefined && consumed < name.trim().replace(/\s+/g, ' ').length) {
    lines[lines.length - 1] =
      last.length >= maxChars ? `${last.slice(0, Math.max(0, maxChars - 1))}…` : `${last}…`;
  }
  return lines;
}

export function resolveLabels(input: ResolveLabelsInput): ResolvedLabels {
  const labels: ResolvedLabel[] = [];
  const errors: LabelError[] = [];
  const { template } = input;

  for (const { item, copies } of input.items) {
    // A barcode the shop already uses beats the internal code, because that
    // is the one printed on the packet and already in the scanner's hands.
    const value = item.barcodes[0] ?? item.code ?? null;
    if (value === null || value.trim() === '') {
      errors.push({
        itemId: item.itemId,
        name: item.name,
        // Named, because a blank label wastes a sheet nobody can reuse.
        reason: 'This item has neither a barcode nor an item code, so it cannot be labelled.',
      });
      continue;
    }

    const price = input.priceField === 'none' ? null : resolvePrice(item, input.priceField);
    const barcode = chooseSymbology(value.trim());

    labels.push({
      itemId: item.itemId,
      lines: wrapName(item.name, template.maxNameChars, template.maxNameLines),
      priceText:
        price === null
          ? null
          : `${price.isMrp ? 'MRP ' : ''}${formatCurrency(price.amount, {
              symbol: input.currencySymbol,
            })}`,
      secondaryText: template.showUnit && item.unit ? formatQuantity(1000, item.unit) : null,
      barcode,
      barcodeText: template.showBarcodeText ? barcode.value : null,
      copies,
    });
  }

  return {
    labels,
    errors,
    totalLabels: labels.reduce((total, label) => total + label.copies, 0),
  };
}

/**
 * The number on the label, and whether it may legally be called an MRP.
 *
 * Asking for MRP on an item that has none falls back to the sale price — a
 * label with no number is not a label — but the "MRP" prefix is dropped with
 * it. Maximum retail price is a declaration under the Legal Metrology Act,
 * not a synonym for "the price"; printing a shop's own rate under that word
 * is a misstatement on a sticker that goes on a physical packet.
 */
function resolvePrice(
  item: LabelItem,
  field: 'mrp' | 'salePrice',
): { amount: number; isMrp: boolean } {
  if (field === 'mrp' && item.mrp !== null) return { amount: item.mrp, isMrp: true };
  return { amount: item.salePrice, isMrp: false };
}
