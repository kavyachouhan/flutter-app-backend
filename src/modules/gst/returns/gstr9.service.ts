/**
 * Assembles a financial year's GSTR-9 inputs and runs the engine.
 *
 * Tables 4 to 9 rest on the period returns, so for each return period of the year this takes the
 * stored GSTR-1 and GSTR-3B (filed, else prepared) and falls back to working the period out from
 * the books, saying so. A stored GSTR-1 whose model left e-invoiced invoices out is recomputed with
 * them in, because the annual return counts every invoice.
 */
import type { Tx } from '../../../db/tx.js';
import { EINVOICE_LEFT_OUT_CODE } from '../../../domain/gst/returns/gstr1-engine.js';
import {
  buildGstr9,
  buildItcBreakdown,
  monthsIn,
  type Gstr9Period,
  type Gstr9Workings,
  type PeriodSource,
} from '../../../domain/gst/returns/gstr9-engine.js';
import type { Gstr1Return, Gstr3bReturn, TaxAmounts } from '../../../domain/gst/returns/model.js';
import type { WorkingIssue } from '../../../domain/gst/returns/sheets.js';
import { createLogger } from '../../../lib/logger.js';
import { gstRepository, type GstReturnPeriodRow } from '../gst.repository.js';
import { windowFromSettings } from '../period-window.js';
import { tenantsRepository } from '../../tenants/tenants.repository.js';
import { ledgerSummaryFor } from '../ledgers/ledger.service.js';
import { returnsRepository } from './returns.repository.js';
import { computeGstr1, computeGstr3b } from './returns.service.js';

const log = createLogger('gstr9');

interface Stored {
  model: unknown;
  issues: WorkingIssue[];
}

function storedOf(row: GstReturnPeriodRow | undefined): Stored | null {
  if (!row || row.status === 'open') return null;
  const w = row.workings as { model?: unknown; issues?: WorkingIssue[] } | null;
  if (!w || !w.model) return null;
  return { model: w.model, issues: Array.isArray(w.issues) ? w.issues : [] };
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The return periods a year is made of: twelve months, or four quarters for a QRMP filer. */
export function returnPeriodKeys(
  from: string,
  to: string,
  quarterly: boolean,
): { year: number; month: number }[] {
  const months = monthsIn(from, to).map((m) => ({ year: Number(m.slice(0, 4)), month: Number(m.slice(5, 7)) }));
  return quarterly ? months.filter((_, i) => i % 3 === 2) : months;
}

export async function computeGstr9(
  tx: Tx,
  period: GstReturnPeriodRow,
  options: { considerNonTaxAsExempt: boolean },
): Promise<Gstr9Workings> {
  const settings = await tenantsRepository.getSettings(tx);
  const quarterly = settings.filingFrequency === 'qrmp';
  const keys = returnPeriodKeys(period.periodFrom, period.periodTo, quarterly);
  const gstin = period.gstin;

  // The year's outward documents are read once and cut by period in memory: the engines are pure,
  // and one read per month would be a dozen round trips for the same rows.
  const yearDocs = await returnsRepository.outwardDocuments(tx, gstin, period.periodFrom, period.periodTo);

  const periods: Gstr9Period[] = [];
  for (const key of keys) {
    const window = windowFromSettings(settings, 'gstr1', key.year, key.month);
    const bounds = { gstin, period: key, from: window.from, to: window.to };
    const label = quarterly
      ? `Quarter ending ${MONTH_NAMES[key.month - 1] ?? key.month} ${key.year}`
      : `${MONTH_NAMES[key.month - 1] ?? key.month} ${key.year}`;

    const scope = (returnType: string) => ({
      gstin,
      returnType,
      periodYear: key.year,
      periodMonth: key.month,
    });
    const row1 = await gstRepository.findPeriodByScope(tx, scope('gstr1'));
    const row3 = await gstRepository.findPeriodByScope(tx, scope('gstr3b'));
    const s1 = storedOf(row1);
    const s3 = storedOf(row3);
    const notes: string[] = [];
    const documents = yearDocs.filter((d) => d.date >= window.from && d.date <= window.to);
    let live: Awaited<ReturnType<typeof computeGstr1>> | undefined;
    const liveGstr1 = async () =>
      (live ??= await computeGstr1(tx, bounds, {
        excludeEinvoiceFromPortal: false,
        documents,
        skipDocsIssued: true,
      }));

    let gstr1: Gstr1Return;
    let used1: PeriodSource;
    if (s1 && !s1.issues.some((i) => i.code === EINVOICE_LEFT_OUT_CODE)) {
      gstr1 = s1.model as Gstr1Return;
      used1 = row1?.status === 'filed' ? 'filed' : 'prepared';
    } else {
      gstr1 = (await liveGstr1()).model;
      used1 = 'live';
      if (s1) notes.push('GSTR-1 recomputed because its stored model leaves e-invoiced invoices out.');
      else notes.push('GSTR-1 was not prepared.');
    }

    let gstr3b: Gstr3bReturn;
    let used3: PeriodSource;
    if (s3) {
      gstr3b = s3.model as Gstr3bReturn;
      used3 = row3?.status === 'filed' ? 'filed' : 'prepared';
    } else {
      gstr3b = (await computeGstr3b(tx, bounds, await liveGstr1())).model;
      used3 = 'live';
      notes.push('GSTR-3B was not prepared.');
    }

    const source: PeriodSource =
      used1 === 'live' || used3 === 'live'
        ? 'live'
        : used1 === 'filed' && used3 === 'filed'
          ? 'filed'
          : 'prepared';
    periods.push({
      label,
      from: window.from,
      to: window.to,
      source,
      ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
      gstr1,
      gstr3b,
    });
  }

  const fyBounds = {
    gstin,
    period: { year: period.periodYear, month: period.periodMonth },
    from: period.periodFrom,
    to: period.periodTo,
  };

  const itc = buildItcBreakdown(
    await returnsRepository.itcRegisterRows(tx, gstin, period.periodFrom, period.periodTo),
  );
  const inward = await returnsRepository.inwardDocuments(tx, gstin, period.periodFrom, period.periodTo);
  const books = (
    await computeGstr1(tx, fyBounds, {
      excludeEinvoiceFromPortal: false,
      documents: yearDocs,
      skipDocsIssued: true,
    })
  ).totals;

  // GSTR-2B is monthly for everyone, so it is looked up month by month whatever the filing frequency.
  const months = monthsIn(period.periodFrom, period.periodTo);
  let monthsImported = 0;
  let twoBTotal: TaxAmounts = { igst: 0, cgst: 0, sgst: 0, cess: 0 };
  for (const m of months) {
    const credit = await returnsRepository.gstr2bCredit(tx, gstin, Number(m.slice(0, 4)), Number(m.slice(5, 7)));
    if (!credit) continue;
    monthsImported++;
    twoBTotal = {
      igst: twoBTotal.igst + credit.other.igst,
      cgst: twoBTotal.cgst + credit.other.cgst,
      sgst: twoBTotal.sgst + credit.other.sgst,
      cess: twoBTotal.cess + credit.other.cess,
    };
  }

  const ledger = await ledgerSummaryFor(tx, gstin, period.periodFrom, period.periodTo);

  const result = buildGstr9({
    gstin,
    fy: { startYear: period.periodYear, endYear: Number(period.periodTo.slice(0, 4)) },
    periods,
    considerNonTaxAsExempt: options.considerNonTaxAsExempt,
    itc,
    twoB: { monthsImported, monthsExpected: months.length, total: twoBTotal },
    inward,
    books: { outwardTaxable: books.taxable, outwardTax: books.tax },
    ledger,
  });
  log.info(
    {
      gstin,
      fy: `${period.periodYear}-${period.periodTo.slice(0, 4)}`,
      periods: periods.length,
      live: periods.filter((p) => p.source === 'live').length,
      issues: result.issues.length,
    },
    'GSTR-9 worked out',
  );
  return result;
}
