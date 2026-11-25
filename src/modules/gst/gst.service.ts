/**
 * GSTR-1, GSTR-3B and GSTR-9 workings, and the ITC register.
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
import { requireAuthContext } from '../../lib/context.js';
import { ConflictError, ErrorCode, NotFoundError, UnprocessableError } from '../../lib/errors.js';
import { buildPage, parsePage } from '../../lib/pagination.js';
import { recordAudit } from '../audit/audit.js';
import { businessEvents } from '../../observability/metrics.js';
import { assertFeature } from '../entitlements/entitlements.js';
import { tenantsRepository } from '../tenants/tenants.repository.js';
import { gstRepository, type GstReturnPeriodRow } from './gst.repository.js';
import { fyEndMonth, periodWindow } from './period-window.js';
import { computeGstr9 } from './returns/gstr9.service.js';
import { computeGstr1, computeGstr3b, toStoredWorkings } from './returns/returns.service.js';
import { itcRepository } from './itc.repository.js';
import {
  annualReturnObligation,
  isTimeBarred,
  standardDueDate,
  timeBarredFrom,
} from '../../domain/gst/filing-obligations.js';
import { resolvedTurnover } from '../../domain/gst/entity.js';
import type { WorkingIssue } from '../../domain/gst/returns/sheets.js';
import type {
  CreatePeriodBody,
  PreparePeriodBody,
  FilePeriodBody,
  ItcRegisterQuery,
  ListPeriodsQuery,
} from './gst.schemas.js';

async function requirePeriod(tx: Tx, id: string, forUpdate = false): Promise<GstReturnPeriodRow> {
  const period = await gstRepository.findPeriod(tx, id, forUpdate);
  if (!period) throw new NotFoundError('GST return period');
  return period;
}

export { periodWindow } from './period-window.js';

export { filingGstins, resolveGstin } from './gstin-scope.js';
import { resolveGstin } from './gstin-scope.js';

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

    // A composition dealer files CMP-08 and GSTR-4, not GSTR-1, 3B or 9, and those returns are
    // not part of this version. Offering a regular return would have the shop file one it does
    // not owe.
    if (settings.isComposition) {
      throw new UnprocessableError(
        'GST returns for composition dealers (CMP-08, GSTR-4) are not supported in this version. GSTR-1, GSTR-3B and GSTR-9 apply only to regular dealers.',
        ErrorCode.UNPROCESSABLE,
      );
    }

    // A GSTR-9 period is a financial year: the year is the one it starts in and the month is the
    // year's last, whatever the client sent, so there is one period per year and registration.
    const periodMonth =
      body.returnType === 'gstr9' ? fyEndMonth(settings.fyStartMonth) : body.periodMonth;
    const scope = {
      gstin,
      returnType: body.returnType,
      periodYear: body.periodYear,
      periodMonth,
    };
    const duplicate = await gstRepository.findPeriodByScope(tx, scope);
    if (duplicate) return duplicate;

    const window = await periodWindow(tx, body.returnType, body.periodYear, periodMonth);
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
export function preparePeriod(id: string, options: PreparePeriodBody = {}) {
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
          : await buildGstr9Period(tx, period, options);
    await addObligationIssues(tx, period, workings);

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
    // GSTR-1 and GSTR-3B lock the period on the registration (GSTR-9 has no lock level):
    // documents dated in it can then only be corrected by notes or amendments.
    let locked = false;
    if (period.returnType === 'gstr1' || period.returnType === 'gstr3b') {
      locked = await gstRepository.recordPeriodLock(
        tx,
        period.gstin,
        period.returnType === 'gstr1' ? 'gstr1_filed' : 'gstr3b_filed',
        period.periodTo,
        auth.userId,
      );
    }
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
        periodLocked: locked,
      },
    });
    businessEvents.inc({ event: 'gst_return.filed' });
    return requirePeriod(tx, id);
  });
}

// --- Workings ---------------------------------------------------------------

/**
 * Warnings about the obligation itself, added to every prepared return (see
 * `domain/gst/filing-obligations.ts`): the three-year bar on filing (s.37(5), 39(11), 44(2))
 * and, for GSTR-9, whether the annual return is optional at this turnover. Warnings only;
 * nothing is blocked.
 */
async function addObligationIssues(
  tx: Tx,
  period: GstReturnPeriodRow,
  workings: Workings,
): Promise<void> {
  const extra: WorkingIssue[] = [];
  const freq = await gstRepository.filingFrequencyOn(tx, period.gstin, period.periodTo);
  const due = standardDueDate(period.returnType, period.periodYear, period.periodMonth, freq);
  const today = new Date().toISOString().slice(0, 10);
  if (isTimeBarred(due, today)) {
    extra.push({
      severity: 'warning',
      code: 'return_time_barred',
      message: `This return was due on ${due} and cannot be filed after ${timeBarredFrom(due)} (three years from the due date: s.37(5), 39(11) and 44(2), in force from 01.10.2023). The portal will not accept it.`,
    });
  }
  if (period.returnType === 'gstr9') {
    const turnover = await gstRepository.turnoverRecords(tx);
    const obligation = annualReturnObligation(
      period.periodYear,
      resolvedTurnover({ exemptionCategory: 'none', turnover }, period.periodYear),
    );
    if (obligation.status !== 'required') {
      extra.push({
        severity: 'info',
        code: obligation.status === 'optional' ? 'gstr9_optional' : 'gstr9_obligation_unknown',
        message:
          obligation.status === 'optional'
            ? `GSTR-9 is optional for this year. ${obligation.basis}`
            : `GSTR-9 may be optional for this year. ${obligation.basis}`,
      });
    }
  }
  if (extra.length === 0) return;
  const stored = workings.workings as { issues?: WorkingIssue[] };
  stored.issues = [...(stored.issues ?? []), ...extra];
}

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
 * GSTR-9, the annual return: summed from the year's period returns (see `gstr9.service`). The
 * option chosen when preparing is stored with the workings, so a re-prepare keeps it unless the
 * caller says otherwise.
 */
async function buildGstr9Period(
  tx: Tx,
  period: GstReturnPeriodRow,
  options: PreparePeriodBody,
): Promise<Workings> {
  const previous = (period.workings as { options?: { considerNonTaxAsExempt?: boolean } } | null)
    ?.options?.considerNonTaxAsExempt;
  const considerNonTaxAsExempt = options.considerNonTaxAsExempt ?? previous ?? false;
  const w = await computeGstr9(tx, period, { considerNonTaxAsExempt });
  return {
    workings: { ...toStoredWorkings(w), options: { considerNonTaxAsExempt } },
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
