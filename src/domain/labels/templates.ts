/**
 * Barcode label stationery.
 *
 * A label template is the physical fact of a sheet or a roll: how big one
 * label is, how many fit, and what gaps sit between them. It is not a layout
 * — where the price sits inside those 38×25 millimetres is the renderer's
 * business, exactly as with print templates.
 *
 * Millimetres rather than points or pixels, because that is what is printed
 * on the packet of labels a shopkeeper buys, and converting it here would
 * only mean converting it back on the device.
 *
 * `maxNameChars` and `maxNameLines` live here and not on the device because
 * the server does the formatting. Truncating an item name needs to know how
 * wide the label is, and that is this file's one piece of knowledge.
 */

export const LABEL_TEMPLATE_KEYS = [
  'a4_38x25_3up',
  'a4_50x25_4up',
  'a4_65x38_3up',
  'roll_50x25',
  'roll_38x25_2up',
] as const;
export type LabelTemplateKey = (typeof LABEL_TEMPLATE_KEYS)[number];

export interface LabelTemplate {
  readonly key: LabelTemplateKey;
  readonly title: string;
  readonly description: string;
  /** A sheet is paginated; a roll runs continuously and has no page height. */
  readonly media: 'sheet' | 'roll';
  readonly widthMm: number;
  readonly heightMm: number;
  readonly cols: number;
  /** Labels down one page. Null on a roll, which does not paginate. */
  readonly rows: number | null;
  readonly gapXMm: number;
  readonly gapYMm: number;
  readonly marginTopMm: number;
  readonly marginLeftMm: number;
  readonly pageWidthMm: number | null;
  readonly pageHeightMm: number | null;
  readonly maxNameChars: number;
  readonly maxNameLines: number;
  /** A narrow label has no room for the digits under the bars. */
  readonly showBarcodeText: boolean;
  readonly showUnit: boolean;
}

export const LABEL_TEMPLATES: Record<LabelTemplateKey, LabelTemplate> = {
  a4_38x25_3up: {
    key: 'a4_38x25_3up',
    title: 'A4 sheet — 38 × 25 mm, 3 across',
    description: 'The common shelf-label sheet, 33 labels to a page.',
    media: 'sheet',
    widthMm: 38,
    heightMm: 25,
    cols: 3,
    rows: 11,
    gapXMm: 2,
    gapYMm: 0,
    marginTopMm: 11,
    marginLeftMm: 45,
    pageWidthMm: 210,
    pageHeightMm: 297,
    maxNameChars: 22,
    maxNameLines: 2,
    showBarcodeText: true,
    showUnit: true,
  },
  a4_50x25_4up: {
    key: 'a4_50x25_4up',
    title: 'A4 sheet — 50 × 25 mm, 4 across',
    description: 'Wider labels for longer product names, 44 to a page.',
    media: 'sheet',
    widthMm: 50,
    heightMm: 25,
    cols: 4,
    rows: 11,
    gapXMm: 2,
    gapYMm: 0,
    marginTopMm: 11,
    marginLeftMm: 4,
    pageWidthMm: 210,
    pageHeightMm: 297,
    maxNameChars: 30,
    maxNameLines: 2,
    showBarcodeText: true,
    showUnit: true,
  },
  a4_65x38_3up: {
    key: 'a4_65x38_3up',
    title: 'A4 sheet — 65 × 38 mm, 3 across',
    description: 'Large labels with room for the full name, 21 to a page.',
    media: 'sheet',
    widthMm: 65,
    heightMm: 38,
    cols: 3,
    rows: 7,
    gapXMm: 2.5,
    gapYMm: 0,
    marginTopMm: 15,
    marginLeftMm: 5,
    pageWidthMm: 210,
    pageHeightMm: 297,
    maxNameChars: 38,
    maxNameLines: 2,
    showBarcodeText: true,
    showUnit: true,
  },
  roll_50x25: {
    key: 'roll_50x25',
    title: 'Thermal roll — 50 × 25 mm',
    description: 'Continuous roll for a desktop label printer, one across.',
    media: 'roll',
    widthMm: 50,
    heightMm: 25,
    cols: 1,
    rows: null,
    gapXMm: 0,
    gapYMm: 2,
    marginTopMm: 1,
    marginLeftMm: 1,
    pageWidthMm: null,
    pageHeightMm: null,
    maxNameChars: 28,
    maxNameLines: 2,
    showBarcodeText: true,
    showUnit: true,
  },
  roll_38x25_2up: {
    key: 'roll_38x25_2up',
    title: 'Thermal roll — 38 × 25 mm, 2 across',
    description: 'Two-across roll, for fast labelling of small packets.',
    media: 'roll',
    widthMm: 38,
    heightMm: 25,
    cols: 2,
    rows: null,
    gapXMm: 2,
    gapYMm: 2,
    marginTopMm: 1,
    marginLeftMm: 1,
    pageWidthMm: 80,
    pageHeightMm: null,
    maxNameChars: 20,
    maxNameLines: 2,
    // 38 mm of bars leaves no vertical room for the digits as well.
    showBarcodeText: false,
    showUnit: false,
  },
};

export function isLabelTemplateKey(value: string): value is LabelTemplateKey {
  return (LABEL_TEMPLATE_KEYS as readonly string[]).includes(value);
}

/** Labels per page; null on a roll, which never runs out of page. */
export function labelsPerPage(template: LabelTemplate): number | null {
  return template.rows === null ? null : template.cols * template.rows;
}
