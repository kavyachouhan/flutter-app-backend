/**
 * Formatting for printed documents.
 *
 * Every string on a bill is produced here, on the server, and the device
 * renders it verbatim. That is deliberate: a device reprinting a six-month-old
 * invoice from its local cache must produce the same paper it produced the
 * first time, and it would not if the formatting depended on the device's
 * locale, its Intl data or its idea of the current currency symbol.
 *
 * Pure: no clock, no configuration lookups. Everything comes in as arguments.
 */
import { PAISE_PER_RUPEE, QUANTITY_SCALE } from '../../lib/money.js';

/**
 * Indian digit grouping: the last three digits, then twos.
 * 1234567 paise → "12,345.67". `Intl.NumberFormat('en-IN')` does this too,
 * but going through floats to get there is how a rupee ends up a paisa short.
 */
export function formatIndianDigits(whole: string): string {
  if (whole.length <= 3) return whole;
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
}

export interface CurrencyOptions {
  /** Prefixed when present; bills for unregistered shops often omit it. */
  readonly symbol?: string;
  /** Renders a negative as "-" rather than parentheses. */
  readonly signed?: boolean;
}

export function formatCurrency(paise: number, options: CurrencyOptions = {}): string {
  const negative = paise < 0;
  const absolute = Math.abs(paise);
  const whole = formatIndianDigits(String(Math.floor(absolute / PAISE_PER_RUPEE)));
  const fraction = String(absolute % PAISE_PER_RUPEE).padStart(2, '0');
  const sign = negative ? '-' : '';
  return `${sign}${options.symbol ?? ''}${whole}.${fraction}`;
}

/**
 * Quantities print as whole numbers when they are whole: "2", not "2.000".
 * A grocer selling by weight still needs "0.250", so trailing zeros are
 * trimmed rather than a fixed precision applied.
 */
export function formatQuantity(thousandths: number, unit?: string | null): string {
  const value = thousandths / QUANTITY_SCALE;
  const text = Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, '');
  const trimmed = text.endsWith('.') ? text.slice(0, -1) : text;
  return unit ? `${trimmed} ${unit}` : trimmed;
}

export function formatPercent(rate: number): string {
  return `${Number.isInteger(rate) ? rate : Number(rate.toFixed(3))}%`;
}

/** "14 Jun 2026" — unambiguous, and short enough for 58 mm paper. */
export function formatDocumentDate(isoDate: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: timezone,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(`${isoDate}T12:00:00Z`));
}

/** "14 Jun 2026, 6:42 pm" in the shop's own timezone. */
export function formatInstant(instant: Date | string, timezone: string): string {
  const at = typeof instant === 'string' ? new Date(instant) : instant;
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: timezone,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(at);
}

const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
] as const;

const TENS = [
  '',
  '',
  'Twenty',
  'Thirty',
  'Forty',
  'Fifty',
  'Sixty',
  'Seventy',
  'Eighty',
  'Ninety',
] as const;

function twoDigits(n: number): string {
  if (n < 20) return ONES[n] ?? '';
  const tens = TENS[Math.floor(n / 10)] ?? '';
  const ones = ONES[n % 10] ?? '';
  return ones ? `${tens} ${ones}` : tens;
}

function threeDigits(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (hundreds > 0) parts.push(`${ONES[hundreds]} Hundred`);
  if (rest > 0) parts.push(twoDigits(rest));
  return parts.join(' ');
}

/**
 * The amount in words, in the Indian system: crore, lakh, thousand.
 *
 * Printed on invoices because it is what makes a figure hard to alter after
 * the fact, which is exactly why the convention exists.
 */
export function amountInWords(paise: number, currencyName = 'Rupees'): string {
  const absolute = Math.abs(paise);
  const rupees = Math.floor(absolute / PAISE_PER_RUPEE);
  const remainder = absolute % PAISE_PER_RUPEE;

  const groups: string[] = [];
  const crore = Math.floor(rupees / 10_000_000);
  const lakh = Math.floor((rupees % 10_000_000) / 100_000);
  const thousand = Math.floor((rupees % 100_000) / 1_000);
  const rest = rupees % 1_000;

  if (crore > 0) groups.push(`${threeDigits(crore)} Crore`);
  if (lakh > 0) groups.push(`${twoDigits(lakh)} Lakh`);
  if (thousand > 0) groups.push(`${twoDigits(thousand)} Thousand`);
  if (rest > 0) groups.push(threeDigits(rest));

  const rupeeWords = groups.length > 0 ? groups.join(' ') : 'Zero';
  const sign = paise < 0 ? 'Minus ' : '';
  const paiseWords = remainder > 0 ? ` and ${twoDigits(remainder)} Paise` : '';
  return `${sign}${currencyName} ${rupeeWords}${paiseWords} Only`;
}

/**
 * A UPI collect intent, per the NPCI deep-link spec. Scanning it opens any UPI
 * app with the amount and reference filled in — the cheapest digital payment
 * rail a small shop can offer, and it costs them nothing.
 */
export function upiIntent(input: {
  vpa: string;
  payeeName: string;
  amountPaise: number;
  reference: string;
  note?: string;
}): string {
  const params = new URLSearchParams({
    pa: input.vpa,
    pn: input.payeeName,
    am: (input.amountPaise / PAISE_PER_RUPEE).toFixed(2),
    cu: 'INR',
    tr: input.reference,
  });
  if (input.note) params.set('tn', input.note);
  return `upi://pay?${params.toString()}`;
}
