/**
 * GSTR-1 and 3B workings, the ITC register, and CMP-08.
 *
 * Three rules shape this module, and all three are about not telling the
 * department something untrue.
 *
 * **Prepared figures are snapshotted.** `prepare` computes and stores; nothing
 * recomputes on read. The same reasoning as `day_closes`: a void raised in
 * November must not restate October's filed return. It belongs in the next
 * period's amendment, which is a later milestone.
 *
 * **Filing is an explicit act.** `prepare` is reversible and can be re-run as
 * often as the shop likes. `file` records who declared it and when, requires
 * `confirm: true`, and is the only step that cannot be undone.
 *
 * **Everything is per GSTIN.** A business trading in two states files a return
 * per registration. Every query here is scoped by the GSTIN snapshotted on the
 * document, not by tenant or outlet, because that is the only figure that
 * stays right after a registration changes.
 */
import { env } from '../../config/env.js';
import { withReadTransaction, withTransaction, type Tx } from '../../db/tx.js';
import { periodOf } from '../../domain/gst/classify.js';
import { compositionLiability, compositionQuarter } from '../../domain/gst/composition.js';
import { requireAuthContext } from '../../lib/context.js';
import { ConflictError, ErrorCode, NotFoundError, UnprocessableError } from '../../lib/errors.js';
import { buildPage, parsePage } from '../../lib/pagination.js';
import { recordAudit } from '../audit/audit.js';
import { businessEvents } from '../../observability/metrics.js';
import { assertFeature } from '../entitlements/entitlements.js';
import { outletsRepository } from '../outlets/outlets.repository.js';
import { tenantsRepository } from '../tenants/tenants.repository.js';
import { gstRepository, type GstReturnPeriodRow } from './gst.repository.js';
import { computeGstr1, computeGstr3b, toStoredWorkings } from './returns/returns.service.js';
import { itcRepository } from './itc.repository.js';
import type {
  CreatePeriodBody,
  FilePeriodBody,
  ItcRegisterQuery,
  ListPeriodsQuery,
} from './gst.schemas.js';

async function requirePeriod(tx: Tx, id: string, forUpdate = false): Promise<GstReturnPeriodRow> {
  const period = await gstRepository.findPeriod(tx, id, forUpdate);
  if (!period) throw new NotFoundError('GST return period');
  return period;
}

/**
 * Every GSTIN this business files under: the tenant's, plus any outlet that
 * overrides it.
 *
 * Exported because the reports need the same list — filing is per
 * registration, and there is no other helper that resolves it.
 */
export async function filingGstins(tx: Tx): Promise<string[]> {
  const settings = await tenantsRepository.getSettings(tx);
  const outlets = await outletsRepository.listOutlets(tx, null);
  const gstins = new Set<string>();
  if (settings.gstin) gstins.add(settings.gstin);
  for (const outlet of outlets) if (outlet.gstin) gstins.add(outlet.gstin);
  return [...gstins];
}

async function resolveGstin(tx: Tx, requested: string | undefined): Promise<string> {
  const available = await filingGstins(tx);
  if (requested) {
    if (!available.includes(requested)) {
      throw new UnprocessableError(
        'That GSTIN does not belong to this business.',
        ErrorCode.UNPROCESSABLE,
        { details: { gstin: requested, available } },
      );
    }
    return requested;
  }
  const only = available[0];
  if (!only) {
    throw new UnprocessableError(
      'This business is not GST registered, so it has no returns to file.',
      ErrorCode.UNPROCESSABLE,
    );
  }
  if (available.length > 1) {
    throw new UnprocessableError(
      'This business files under more than one GSTIN; name the one you mean.',
      ErrorCode.UNPROCESSABLE,
      { details: { available } },
    );
  }
  return only;
}

/** Last day of a month, without constructing a date in the wrong timezone. */
function lastDayOf(year: number, month: number): string {
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const firstOfNext = new Date(Date.UTC(nextYear, nextMonth - 1, 1));
  const last = new Date(firstOfNext.getTime() - 86_400_000);
  return last.toISOString().slice(0, 10);
}

/**
 * The window a period covers.
 *
 * CMP-08 is quarterly on the financial year; GSTR-1 and 3B are monthly unless
 * the shop is on QRMP, in which case GSTR-1 is quarterly too. Getting this
 * wrong files a correct set of figures against the wrong months, which is
 * harder to spot than a wrong figure.
 */
async function periodWindow(
  tx: Tx,
  returnType: string,
  year: number,
  month: number,
): Promise<{ from: string; to: string }> {
  const settings = await tenantsRepository.getSettings(tx);
  const quarterly = returnType === 'cmp08' || settings.filingFrequency === 'qrmp';
  if (!quarterly) {
    return { from: `${year}-${String(month).padStart(2, '0')}-01`, to: lastDayOf(year, month) };
  }
  const quarter = compositionQuarter(year, month, settings.fyStartMonth);
  return {
    from: `${quarter.fromYear}-${String(quarter.fromMonth).padStart(2, '0')}-01`,
    to: lastDayOf(quarter.toYear, quarter.toMonth),
  };
}

export async function listPeriods(query: ListPeriodsQuery) {
  const page = parsePage(query);
  const rows = await withReadTransaction((tx) =>
    gstRepository.listPeriods(
      tx,
      { gstin: query.gstin, returnType: query.returnType, status: query.status },
      page.limit,
      page.cursor,
    ),
  );
  return buildPage(rows, page.limit, (row) => ({
    k: row.periodYear * 100 + row.periodMonth,
    id: row.id,
  }));
}

export function getPeriod(id: string) {
  return withReadTransaction((tx) => requirePeriod(tx, id));
}

export function createPeriod(body: CreatePeriodBody) {
  return withTransaction(async (tx) => {
    await assertFeature(tx, 'gst_workings');

    const existing = await gstRepository.findPeriod(tx, body.id);
    if (existing) return existing;

    const gstin = await resolveGstin(tx, body.gstin);
    const settings = await tenantsRepository.getSettings(tx);

    // A composition dealer files CMP-08, not GSTR-1 and 3B, and a regular
    // dealer the reverse. Offering the wrong one is how a shop files a return
    // it does not owe and leaves the one it does unfiled.
    if (settings.isComposition && body.returnType !== 'cmp08') {
      throw new UnprocessableError(
        'A composition dealer files CMP-08, not GSTR-1 or GSTR-3B.',
        ErrorCode.UNPROCESSABLE,
      );
    }
    if (!settings.isComposition && body.returnType === 'cmp08') {
      throw new UnprocessableError(
        'CMP-08 applies only under the composition scheme.',
        ErrorCode.UNPROCESSABLE,
      );
    }

    const scope = {
      gstin,
      returnType: body.returnType,
      periodYear: body.periodYear,
      periodMonth: body.periodMonth,
    };
    const duplicate = await gstRepository.findPeriodByScope(tx, scope);
    if (duplicate) return duplicate;

    const window = await periodWindow(tx, body.returnType, body.periodYear, body.periodMonth);
    await gstRepository.insertPeriod(tx, {
      id: body.id,
      ...scope,
      periodFrom: window.from,
      periodTo: window.to,
    });
    return requirePeriod(tx, body.id);
  });
}

/**
 * Computes the return and stores it.
 *
 * Re-runnable while the period is open or already prepared, because a shop
 * will enter a missing bill and prepare again — that is the normal workflow,
 * not an error. Refused once filed: a filed return is a declaration, and
 * changing it silently would be the one genuinely dangerous thing this module
 * could do.
 */
export function preparePeriod(id: string) {
  const auth = requireAuthContext();

  return withTransaction(async (tx) => {
    await assertFeature(tx, 'gst_workings');
    const period = await requirePeriod(tx, id, true);
    if (period.status === 'filed') {
      throw new ConflictError(
        'This return has been filed. Corrections belong in a later period as an amendment.',
        ErrorCode.CONFLICT,
        { details: { filedAt: period.filedAt, arn: period.arn } },
      );
    }

    // Bills entered before the register existed would otherwise be missing
    // from table 4. Idempotent, so running it on every prepare costs nothing
    // once it has caught up.
    await itcRepository.backfillFromBills(tx, period.gstin, env.ITC_BACKFILL_CHUNK_ROWS);

    const workings =
      period.returnType === 'gstr1'
        ? await buildGstr1(tx, period)
        : period.returnType === 'gstr3b'
          ? await buildGstr3b(tx, period)
          : await buildCmp08(tx, period);

    await gstRepository.savePrepared(tx, id, workings.workings, workings.totals, auth.userId);
    await recordAudit(tx, {
      action: 'gst_return.prepared',
      entityType: 'gst_return_period',
      entityId: id,
      metadata: {
        gstin: period.gstin,
        returnType: period.returnType,
        period: `${period.periodYear}-${String(period.periodMonth).padStart(2, '0')}`,
        ...workings.totals,
      },
    });
    return requirePeriod(tx, id);
  });
}

export function filePeriod(id: string, body: FilePeriodBody) {
  const auth = requireAuthContext();

  return withTransaction(async (tx) => {
    await assertFeature(tx, 'gst_workings');
    const period = await requirePeriod(tx, id, true);

    // Nothing can be filed that has not been computed and looked at. The
    // product guide is explicit that a return is never filed on the system's
    // own initiative, and preparing first is what makes that true in practice.
    if (period.status === 'open') {
      throw new ConflictError(
        'Prepare this return and review the figures before recording it as filed.',
        ErrorCode.CONFLICT,
      );
    }
    if (period.status === 'filed') return period;

    await gstRepository.markFiled(tx, id, auth.userId, body.arn ?? null, body.notes ?? null);
    await recordAudit(tx, {
      action: 'gst_return.filed',
      entityType: 'gst_return_period',
      entityId: id,
      metadata: {
        gstin: period.gstin,
        returnType: period.returnType,
        period: `${period.periodYear}-${String(period.periodMonth).padStart(2, '0')}`,
        arn: body.arn ?? null,
        totalTax: period.totalTax,
      },
    });
    businessEvents.inc({ event: 'gst_return.filed' });
    return requirePeriod(tx, id);
  });
}

// --- Workings ---------------------------------------------------------------

interface Workings {
  workings: Record<string, unknown>;
  totals: { totalTaxable: number; totalTax: number };
}

const boundsOf = (period: GstReturnPeriodRow) => ({
  gstin: period.gstin,
  period: { year: period.periodYear, month: period.periodMonth },
  from: period.periodFrom,
  to: period.periodTo,
});

/**
 * GSTR-1. The figures come from the line-level engine in `domain/gst/returns`; this function only
 * stores them. The stored workings carry the sheets the app shows and the exports are rendered
 * from, plus the neutral model the portal JSON mapper reads, so every output agrees.
 */
async function buildGstr1(tx: Tx, period: GstReturnPeriodRow): Promise<Workings> {
  const w = await computeGstr1(tx, boundsOf(period));
  return {
    workings: toStoredWorkings(w),
    totals: { totalTaxable: w.totals.taxable, totalTax: w.totals.tax },
  };
}

/**
 * GSTR-3B, built from the same outward figures as GSTR-1 plus the purchase side. When a GSTR-1 for
 * the same registration and month has already been prepared, the two are compared and a difference
 * is reported: it means bills changed after one of them was prepared.
 */
async function buildGstr3b(tx: Tx, period: GstReturnPeriodRow): Promise<Workings> {
  const w = await computeGstr3b(tx, boundsOf(period));
  const stored = await tx.one<{ totalTaxable: number | null; totalTax: number | null }>(
    `SELECT total_taxable AS "totalTaxable", total_tax AS "totalTax" FROM gst_return_periods
     WHERE gstin = $1 AND return_type = 'gstr1' AND period_year = $2 AND period_month = $3
       AND status IN ('prepared', 'filed')`,
    [period.gstin, period.periodYear, period.periodMonth],
  );
  const issues = [...w.issues];
  if (stored && stored.totalTaxable !== null) {
    const fresh = await computeGstr1(tx, boundsOf(period));
    if (
      Number(stored.totalTaxable) !== fresh.totals.taxable ||
      Number(stored.totalTax) !== fresh.totals.tax
    ) {
      issues.push({
        severity: 'error',
        code: 'gstr1_changed_since_prepared',
        message: `The prepared GSTR-1 shows taxable ${stored.totalTaxable} and tax ${stored.totalTax} (paise), but today's bills give ${fresh.totals.taxable} and ${fresh.totals.tax}. Prepare GSTR-1 again so both returns agree.`,
      });
    }
  } else {
    issues.push({
      severity: 'info',
      code: 'gstr1_not_prepared',
      message: 'GSTR-1 for this month has not been prepared, so the two returns were not compared.',
    });
  }
  return {
    workings: toStoredWorkings({ ...w, issues }),
    totals: { totalTaxable: w.totals.taxable, totalTax: w.totals.tax },
  };
}

/** CMP-08: flat tax on turnover, plus any reverse-charge tax owed on top. */
async function buildCmp08(tx: Tx, period: GstReturnPeriodRow): Promise<Workings> {
  const settings = await tenantsRepository.getSettings(tx);
  if (settings.compositionRatePercent === null) {
    throw new UnprocessableError(
      'Set the composition category and rate in settings before preparing CMP-08.',
      ErrorCode.UNPROCESSABLE,
    );
  }

  const turnover = await gstRepository.compositionTurnover(
    tx,
    period.gstin,
    period.periodFrom,
    period.periodTo,
  );
  const reverseCharge = (
    await gstRepository.reverseChargeInward(tx, period.periodFrom, period.periodTo)
  )[0];

  const liability = compositionLiability(
    {
      outwardSupplies: turnover?.outwardSupplies ?? 0,
      reverseChargeInward: reverseCharge?.taxableAmount ?? 0,
      reverseChargeTax: reverseCharge?.tax ?? 0,
    },
    Number(settings.compositionRatePercent),
  );

  return {
    workings: {
      category: settings.compositionCategory,
      ...liability,
      reverseChargeInward: reverseCharge?.taxableAmount ?? 0,
    },
    totals: { totalTaxable: liability.turnover, totalTax: liability.totalPayable },
  };
}

// --- ITC register ----------------------------------------------------------

export async function listItcRegister(query: ItcRegisterQuery) {
  const page = parsePage(query);
  const rows = await withReadTransaction(async (tx) => {
    await assertFeature(tx, 'gst_workings');
    return itcRepository.list(
      tx,
      {
        gstin: query.gstin,
        from: query.from,
        to: query.to,
        state: query.state,
        itcCategory: query.itcCategory,
        supplierId: query.supplierId,
      },
      page.limit,
      page.cursor,
    );
  });
  return buildPage(rows, page.limit, (row) => ({ k: row.documentDate, id: row.id }));
}

/** Re-exported so the purchase path can record credit without importing the repo. */
export { periodOf };
