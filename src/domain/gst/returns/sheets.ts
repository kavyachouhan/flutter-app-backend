/**
 * The tabular shape every return is shown, exported and shared in.
 *
 * The screen, the Excel workbook, the PDF and the CA package are all rendered from these sheets,
 * so they cannot disagree. Amounts are integer paise and quantities integer thousandths; each
 * consumer formats them.
 */
export type SheetCellKind = 'text' | 'money' | 'number' | 'percent' | 'date' | 'quantity';

export type SheetCell = string | number | null;

export interface SheetColumn {
  readonly key: string;
  readonly label: string;
  readonly kind: SheetCellKind;
  /** Sum this column into the totals row. */
  readonly total?: boolean;
}

export interface Sheet {
  readonly id: string;
  readonly title: string;
  /** The portal table this corresponds to, e.g. "4A, 4B, 6B, 6C". */
  readonly table?: string;
  readonly note?: string;
  readonly columns: readonly SheetColumn[];
  readonly rows: readonly Readonly<Record<string, SheetCell>>[];
  readonly totals: Readonly<Record<string, number>>;
}

export interface WorkingIssue {
  readonly severity: 'error' | 'warning' | 'info';
  readonly code: string;
  readonly message: string;
  /** Sheet id or document reference the issue is about. */
  readonly ref?: string;
  readonly count?: number;
}

export interface SummaryLine {
  readonly key: string;
  readonly label: string;
  readonly records: number;
  readonly taxable: number;
  readonly igst: number;
  readonly cgst: number;
  readonly sgst: number;
  readonly cess: number;
  readonly value: number;
}

export function makeSheet(
  id: string,
  title: string,
  columns: readonly SheetColumn[],
  rows: readonly Readonly<Record<string, SheetCell>>[],
  extra: { table?: string; note?: string } = {},
): Sheet {
  const totals: Record<string, number> = {};
  for (const column of columns) {
    if (!column.total) continue;
    totals[column.key] = rows.reduce((sum, row) => {
      const v = row[column.key];
      return sum + (typeof v === 'number' ? v : 0);
    }, 0);
  }
  return {
    id,
    title,
    columns,
    rows,
    totals,
    ...(extra.table ? { table: extra.table } : {}),
    ...(extra.note ? { note: extra.note } : {}),
  };
}

export const col = (
  key: string,
  label: string,
  kind: SheetCellKind = 'text',
  total = false,
): SheetColumn => ({ key, label, kind, ...(total ? { total: true } : {}) });
