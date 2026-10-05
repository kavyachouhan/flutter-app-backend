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
import {
  classifyOutward,
  periodOf,
  sectionForOutward,
  type Gstr1Table,
  type SupplyCategory,
  type SupplyType,
} from '../../domain/gst/classify.js';
import { compositionLiability, compositionQuarter } from '../../domain/gst/composition.js';
import { requireAuthContext } from '../../lib/context.js';
import { ConflictError, ErrorCode, NotFoundError, UnprocessableError } from '../../lib/errors.js';
import { buildPage, parsePage } from '../../lib/pagination.js';
import { recordAudit } from '../audit/audit.js';
import { businessEvents } from '../../observability/metrics.js';
import { assertFeature } from '../entitlements/entitlements.js';
import { outletsRepository } from '../outlets/outlets.repository.js';
import { tenantsRepository } from '../tenants/tenants.repository.js';
import { gstRepository, type GstReturnPeriodRow, type OutwardDocumentRow } from './gst.repository.js';
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

// --- Workings --------------------------------------------------------------

interface Workings {
  workings: Record<string, unknown>;
  totals: { totalTaxable: number; totalTax: number };
}

const taxOf = (document: OutwardDocumentRow): number =>
  document.totalCgst + document.totalSgst + document.totalIgst + document.totalCess;

/**
 * GSTR-1: the outward supply tables.
 *
 * B2B, B2CL, exports, SEZ and the credit/debit-note tables are reported
 * document by document, because the buyer's credit depends on the individual
 * invoice. B2CS is a rate-wise aggregate per place of supply — the portal does
 * not want a row per corner-shop sale, and a shop doing two hundred bills a
 * day would produce a file nobody could upload.
 */
async function buildGstr1(tx: Tx, period: GstReturnPeriodRow): Promise<Workings> {
  const documents = await gstRepository.outwardDocuments(
    tx,
    period.gstin,
    period.periodFrom,
    period.periodTo,
  );

  const itemised: Record<string, unknown[]> = { b2b: [], b2cl: [], export: [], sez: [], cdnr: [], cdnur: [] };
  // Keyed by place of supply and rate, which is what table 7 reports on.
  const b2cs = new Map<string, { placeOfSupply: string; taxRatePercent: number; taxableAmount: number; tax: number }>();

  let totalTaxable = 0;
  let totalTax = 0;

  for (const document of documents) {
    const table: Gstr1Table = classifyOutward({
      customerGstin: document.customerGstin,
      supplyType: document.supplyType as SupplyType,
      grandTotal: document.grandTotal,
      isCreditOrDebitNote: document.kind === 'credit_note',
      lineCategories: document.lineCategories as SupplyCategory[],
    });

    // A credit note reduces the period's supply, so it counts negatively
    // towards the headline figures even though it is listed positively in its
    // own table — which is how the portal expects both.
    const sign = document.kind === 'credit_note' ? -1 : 1;
    totalTaxable += sign * document.taxableAmount;
    totalTax += sign * taxOf(document);

    if (table === 'nil_exempt_non_gst') continue;

    if (table === 'b2cs') {
      for (const rate of document.taxSummary ?? []) {
        const placeOfSupply = document.placeOfSupplyStateCode ?? 'unknown';
        const key = `${placeOfSupply}|${rate.taxRatePercent}`;
        const current = b2cs.get(key) ?? {
          placeOfSupply,
          taxRatePercent: rate.taxRatePercent,
          taxableAmount: 0,
          tax: 0,
        };
        current.taxableAmount += sign * rate.taxableAmount;
        b2cs.set(key, current);
      }
      continue;
    }

    (itemised[table] ??= []).push({
      documentNumber: document.documentNumber,
      documentDate: document.documentDate,
      customerGstin: document.customerGstin,
      customerName: document.customerName,
      placeOfSupply: document.placeOfSupplyStateCode,
      supplyType: document.supplyType,
      isReverseCharge: document.isReverseCharge,
      taxableAmount: document.taxableAmount,
      cgst: document.totalCgst,
      sgst: document.totalSgst,
      igst: document.totalIgst,
      cess: document.totalCess,
      invoiceValue: document.grandTotal,
      ...(document.originalDocumentNumber
        ? { originalDocumentNumber: document.originalDocumentNumber }
        : {}),
    });
  }

  const categories = await gstRepository.categoryTotals(
    tx,
    period.gstin,
    period.periodFrom,
    period.periodTo,
  );
  const hsn = await gstRepository.hsnSummary(
    tx,
    period.gstin,
    period.periodFrom,
    period.periodTo,
  );
  const documentsIssued = await gstRepository.documentsIssued(
    tx,
    period.periodFrom,
    period.periodTo,
  );

  return {
    workings: {
      // Table numbers are carried in the keys so a client, an accountant and
      // the portal's own JSON all agree on what each block is.
      b2b: itemised['b2b'],
      b2cl: itemised['b2cl'],
      b2cs: [...b2cs.values()],
      exports: itemised['export'],
      sez: itemised['sez'],
      cdnr: itemised['cdnr'],
      cdnur: itemised['cdnur'],
      nilExemptNonGst: categories.filter((row) => row.supplyCategory !== 'taxable'),
      hsnSummary: hsn,
      documentsIssued,
    },
    totals: { totalTaxable, totalTax },
  };
}

/**
 * GSTR-3B: the summary return.
 *
 * Section 3.1 is outward supply split by classification; table 4 is input tax
 * credit split the four ways the form requires. Reverse-charge inward supplies
 * appear in both — a liability under 3.1(d) and a credit under 4(A)(3) — and
 * netting them would understate both sides.
 */
async function buildGstr3b(tx: Tx, period: GstReturnPeriodRow): Promise<Workings> {
  const categories = await gstRepository.categoryTotals(
    tx,
    period.gstin,
    period.periodFrom,
    period.periodTo,
  );
  const documents = await gstRepository.outwardDocuments(
    tx,
    period.gstin,
    period.periodFrom,
    period.periodTo,
  );

  const sections: Record<string, { taxableAmount: number; cgst: number; sgst: number; igst: number; cess: number }> = {};
  const add = (
    section: string,
    values: { taxableAmount: number; cgst: number; sgst: number; igst: number; cess: number },
  ) => {
    const current = (sections[section] ??= {
      taxableAmount: 0,
      cgst: 0,
      sgst: 0,
      igst: 0,
      cess: 0,
    });
    current.taxableAmount += values.taxableAmount;
    current.cgst += values.cgst;
    current.sgst += values.sgst;
    current.igst += values.igst;
    current.cess += values.cess;
  };

  // Taxable value by section comes from the line classifications; the tax on
  // it comes from the documents, because tax is a document-level total once
  // charges and round-off are in it.
  for (const row of categories) {
    add(
      sectionForOutward(row.supplyType as SupplyType, row.supplyCategory as SupplyCategory),
      { taxableAmount: row.taxableAmount, cgst: 0, sgst: 0, igst: 0, cess: 0 },
    );
  }
  for (const document of documents) {
    const sign = document.kind === 'credit_note' ? -1 : 1;
    const zeroRated =
      document.supplyType.startsWith('export') || document.supplyType.startsWith('sez');
    add(zeroRated ? '3.1b' : '3.1a', {
      taxableAmount: 0,
      cgst: sign * document.totalCgst,
      sgst: sign * document.totalSgst,
      igst: sign * document.totalIgst,
      cess: sign * document.totalCess,
    });
  }

  const reverseCharge = (
    await gstRepository.reverseChargeInward(tx, period.periodFrom, period.periodTo)
  )[0];

  const itc = await itcRepository.totalsForPeriod(
    tx,
    period.gstin,
    period.periodFrom,
    period.periodTo,
  );

  const totalTaxable =
    Object.values(sections).reduce((sum, section) => sum + section.taxableAmount, 0) +
    (reverseCharge?.taxableAmount ?? 0);
  const totalTax =
    Object.values(sections).reduce(
      (sum, section) => sum + section.cgst + section.sgst + section.igst + section.cess,
      0,
    ) + (reverseCharge?.tax ?? 0);

  return {
    workings: {
      outwardSupplies: sections,
      // 3.1(d) is an *inward* supply the shop self-assesses tax on, so it is
      // not one of the outward sections. Its tax is a single self-assessed
      // figure rather than a CGST/SGST/IGST split: the head depends on where
      // the supplier was, and an unregistered supplier has no return to
      // reconcile the split against. Reporting it as one number is what the
      // form asks for and is the only figure that can be defended.
      inwardReverseCharge: {
        taxableAmount: reverseCharge?.taxableAmount ?? 0,
        selfAssessedTax: reverseCharge?.tax ?? 0,
      },
      inputTaxCredit: {
        // 4(A): credit available, by category.
        available: itc.filter((row) => row.itcCategory !== 'ineligible' && !row.isReverseCharge),
        reverseCharge: itc.filter((row) => row.isReverseCharge),
        // 4(D): credit that is not available at all, which still has to be
        // declared rather than quietly dropped.
        ineligible: itc.filter((row) => row.itcCategory === 'ineligible'),
      },
    },
    totals: { totalTaxable, totalTax },
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
