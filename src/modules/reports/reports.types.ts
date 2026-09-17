import type { Tx } from '../../db/tx.js';
import type { Permission } from '../auth/permissions.js';
import type { Feature } from '../entitlements/entitlements.js';

/**
 * A column the client renders without knowing which report it came from.
 * `kind` carries the formatting rule, so one widget renders all forty reports
 * and CSV export is generic — worth it at twelve, mandatory at forty.
 */
export interface ReportColumn {
  key: string;
  label: string;
  kind: 'text' | 'money' | 'quantity' | 'number' | 'percent' | 'date' | 'datetime';
  /** Summed into the totals row. Only ever set on money, quantity or number. */
  total?: boolean;
  /** Hidden by default on a phone; shown on a tablet or in an export. */
  secondary?: boolean;
}

export type FilterName =
  'outletId' | 'from' | 'to' | 'customerId' | 'categoryId' | 'itemId' | 'mode' | 'limit';

/** Which outlets the caller may see, resolved once by the kernel. */
export interface ReportScope {
  /** null means every outlet in the tenant (an unrestricted member). */
  readonly outletIds: readonly string[] | null;
  /** A single outlet the caller asked to narrow to. */
  readonly outletId: string | undefined;
}

export interface ReportParams {
  readonly scope: ReportScope;
  /** Inclusive calendar date, or an instant for time-based reports. */
  readonly from: string;
  /** Exclusive: consecutive windows neither overlap nor skip a document. */
  readonly to: string;
  readonly customerId: string | undefined;
  readonly categoryId: string | undefined;
  readonly itemId: string | undefined;
  readonly mode: string | undefined;
  readonly limit: number;
  /** The tenant's timezone, for reports that group by business day. */
  readonly timezone: string;
}

export type ReportRow = Record<string, unknown>;

export interface ReportDefinition {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly group: 'sales' | 'inventory' | 'money' | 'customers' | 'compliance';
  /** Extra permission beyond `reports:read`; P&L and margin are withheld from cashiers. */
  readonly permission?: Permission;
  /** Plan feature required unless the report id is in the free list. */
  readonly feature?: Feature;
  readonly filters: readonly FilterName[];
  readonly columns: readonly ReportColumn[];
  run(tx: Tx, params: ReportParams): Promise<ReportRow[]>;
}

export interface ReportResult {
  readonly reportId: string;
  readonly title: string;
  readonly columns: readonly ReportColumn[];
  readonly rows: readonly ReportRow[];
  /** Sums of the columns marked `total`, so the footer always matches the rows shown. */
  readonly totals: Record<string, number>;
  readonly truncated: boolean;
  readonly generatedAt: string;
  readonly params: {
    from: string;
    to: string;
    outletId: string | undefined;
  };
}

/**
 * Collects positional parameters while a query is assembled, so every value
 * reaches Postgres as a bind parameter and no report can interpolate input
 * into SQL.
 */
export class Params {
  private readonly values: unknown[] = [];

  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }

  get all(): unknown[] {
    return this.values;
  }
}
