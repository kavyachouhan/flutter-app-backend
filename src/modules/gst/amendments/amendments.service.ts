/**
 * Amendments of outward details in a filed GSTR-1 (D12, D27), reported either in GSTR-1A for the
 * same period or in a later GSTR-1 (tables 9A, 9C, 10). The original is taken from the filed
 * return's stored snapshot, so the amendment is of what the department actually has.
 */
import { withReadTransaction, withTransaction, type Tx } from '../../../db/tx.js';
import {
  amendmentDifference,
  amendmentRefusals,
  matchHeads,
  type AmendableB2csRow,
  type AmendableDocument,
  type AmendmentRecord,
  type AmendmentRoute,
  type AmendmentSection,
} from '../../../domain/gst/amendments.js';
import {
  NO_AMENDMENTS,
  type Gstr1Amendments,
  type Gstr1Line,
  type Gstr1Return,
  type TaxedValue,
} from '../../../domain/gst/returns/model.js';
import { requireAuthContext } from '../../../lib/context.js';
import { ErrorCode, NotFoundError, UnprocessableError } from '../../../lib/errors.js';
import { recordAudit } from '../../audit/audit.js';
import { assertFeature } from '../../entitlements/entitlements.js';
import type { CreateAmendmentBody, ListAmendmentsQuery } from './amendments.schemas.js';

const periodKey = (y: number, m: number) => `${y}-${String(m).padStart(2, '0')}`;

interface FiledGstr1 {
  id: string;
  periodYear: number;
  periodMonth: number;
  model: Gstr1Return;
}

async function filedGstr1Covering(tx: Tx, gstin: string, date: string): Promise<FiledGstr1 | null> {
  const row = await tx.one<{ id: string; periodYear: number; periodMonth: number; workings: { model?: Gstr1Return } }>(
    `SELECT id, period_year AS "periodYear", period_month AS "periodMonth", workings
     FROM gst_return_periods
     WHERE gstin = $1 AND return_type = 'gstr1' AND status = 'filed'
       AND period_from <= $2::date AND period_to >= $2::date
     ORDER BY period_from DESC LIMIT 1`,
    [gstin, date],
  );
  if (!row?.workings?.model) return null;
  return { id: row.id, periodYear: row.periodYear, periodMonth: row.periodMonth, model: row.workings.model };
}

async function filedFor(tx: Tx, gstin: string, returnType: string, period: string): Promise<boolean> {
  const row = await tx.one<{ filed: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM gst_return_periods
       WHERE gstin = $1 AND return_type = $2 AND status = 'filed'
         AND lpad(period_year::text, 4, '0') || '-' || lpad(period_month::text, 2, '0') = $3) AS filed`,
    [gstin, returnType, period],
  );
  return row?.filed ?? false;
}

const lines = (list: readonly Gstr1Line[]) => list.map((l) => ({ ratePercent: l.ratePercent, value: l.value }));

/** Finds a document in a filed GSTR-1 model by number, with the section it was reported in. */
function locate(
  model: Gstr1Return,
  number: string,
): { section: AmendmentSection; record: AmendableDocument } | null {
  for (const party of model.b2b) {
    const inv = party.invoices.find((i) => i.number === number);
    if (inv) {
      return {
        section: 'b2b',
        record: {
          number: inv.number,
          date: inv.date,
          value: inv.value,
          placeOfSupply: inv.placeOfSupply,
          recipientGstin: party.recipientGstin,
          reverseCharge: inv.reverseCharge,
          recipientKind: inv.recipientKind,
          lines: lines(inv.lines),
        },
      };
    }
  }
  for (const group of model.b2cl) {
    const inv = group.invoices.find((i) => i.number === number);
    if (inv) {
      return {
        section: 'b2cl',
        record: {
          number: inv.number,
          date: inv.date,
          value: inv.value,
          placeOfSupply: group.placeOfSupply,
          lines: lines(inv.lines),
        },
      };
    }
  }
  const exp = model.exports.find((e) => e.number === number);
  if (exp) {
    return {
      section: 'exp',
      record: {
        number: exp.number,
        date: exp.date,
        value: exp.value,
        placeOfSupply: '96',
        exportType: exp.exportType,
        lines: lines(exp.lines),
      },
    };
  }
  for (const party of model.creditDebitNotesRegistered) {
    const note = party.notes.find((n) => n.number === number);
    if (note) {
      return {
        section: 'cdnr',
        record: {
          number: note.number,
          date: note.date,
          value: note.value,
          placeOfSupply: note.placeOfSupply,
          recipientGstin: party.recipientGstin,
          reverseCharge: note.reverseCharge,
          recipientKind: note.recipientKind,
          noteKind: note.kind,
          lines: lines(note.lines),
        },
      };
    }
  }
  const unreg = model.creditDebitNotesUnregistered.find((n) => n.number === number);
  if (unreg) {
    return {
      section: 'cdnur',
      record: {
        number: unreg.number,
        date: unreg.date,
        value: unreg.value,
        placeOfSupply: unreg.placeOfSupply,
        noteKind: unreg.kind,
        unregisteredType: unreg.type,
        lines: lines(unreg.lines),
      },
    };
  }
  return null;
}

const DOCUMENT_TABLES = {
  invoices: 'invoices',
  credit_notes: 'credit_notes',
  sales_debit_notes: 'sales_debit_notes',
} as const;

/** The latest version reported to the department: a filed amendment wins over the original. */
async function latestReported(
  tx: Tx,
  gstin: string,
  section: AmendmentSection,
  key: string,
  original: AmendmentRecord,
): Promise<AmendmentRecord> {
  const row = await tx.one<{ revised: AmendmentRecord }>(
    `SELECT a.revised FROM gst_amendments a
     WHERE a.gstin = $1 AND a.section = $2 AND a.document_key = $3 AND a.status = 'active'
       AND EXISTS (SELECT 1 FROM gst_return_periods p
                    WHERE p.gstin = a.gstin AND p.status = 'filed'
                      AND p.return_type = CASE a.route WHEN 'gstr1a' THEN 'gstr1a' ELSE 'gstr1' END
                      AND lpad(p.period_year::text, 4, '0') || '-' || lpad(p.period_month::text, 2, '0') = a.report_period)
     ORDER BY a.report_period DESC, a.created_at DESC LIMIT 1`,
    [gstin, section, key],
  );
  return row?.revised ?? original;
}

const toLines = (list: readonly { ratePercent: number; taxable: number; igst: number; cgst: number; sgst: number; cess: number }[]): Gstr1Line[] =>
  list.map((l) => ({
    ratePercent: l.ratePercent,
    value: { taxable: l.taxable, igst: l.igst, cgst: l.cgst, sgst: l.sgst, cess: l.cess },
  }));

export function createAmendment(body: CreateAmendmentBody) {
  const auth = requireAuthContext();
  return withTransaction(async (tx) => {
    await assertFeature(tx, 'gst_workings');
    const today = new Date().toISOString().slice(0, 10);

    let section: AmendmentSection;
    let original: AmendmentRecord;
    let revised: AmendmentRecord;
    let documentKey: string;
    let originalPeriod: string;
    let documentTable: string | null = null;
    let documentId: string | null = null;

    if ('document' in body.target) {
      const { table, id } = body.target.document;
      const doc = await tx.one<{ number: string; date: string }>(
        `SELECT document_number AS number, document_date::text AS date FROM ${DOCUMENT_TABLES[table]} WHERE id = $1`,
        [id],
      );
      if (!doc) throw new NotFoundError('Document');
      const filed = await filedGstr1Covering(tx, body.gstin, doc.date);
      if (!filed) {
        throw new UnprocessableError(
          'This document is not in a filed GSTR-1 of this registration, so there is nothing to amend.',
          ErrorCode.UNPROCESSABLE,
        );
      }
      const found = locate(filed.model, doc.number);
      if (!found) {
        throw new UnprocessableError(
          'The filed GSTR-1 for this period does not list this document (an e-invoiced or a B2CS sale is not reported by number).',
          ErrorCode.UNPROCESSABLE,
        );
      }
      section = found.section;
      documentKey = doc.number;
      originalPeriod = periodKey(filed.periodYear, filed.periodMonth);
      original = await latestReported(tx, body.gstin, section, documentKey, found.record);
      const r = body.revised;
      const base = original as AmendableDocument;
      revised = {
        ...base,
        number: r.number ?? base.number,
        date: r.date ?? base.date,
        value: r.value ?? base.value,
        placeOfSupply: r.placeOfSupply ?? base.placeOfSupply,
        ...(r.recipientGstin !== undefined ? { recipientGstin: r.recipientGstin } : {}),
        ...(r.reverseCharge !== undefined ? { reverseCharge: r.reverseCharge } : {}),
        lines: r.lines ? matchHeads(toLines(r.lines), base.lines, r.placeOfSupply ?? base.placeOfSupply, base.placeOfSupply) : base.lines,
      };
      documentTable = table;
      documentId = id;
    } else {
      const t = body.target.b2cs;
      const filed = await tx.one<{ periodYear: number; periodMonth: number; workings: { model?: Gstr1Return } }>(
        `SELECT period_year AS "periodYear", period_month AS "periodMonth", workings FROM gst_return_periods
         WHERE gstin = $1 AND return_type = 'gstr1' AND status = 'filed'
           AND lpad(period_year::text, 4, '0') || '-' || lpad(period_month::text, 2, '0') = $2`,
        [body.gstin, t.originalPeriod],
      );
      const rows = (filed?.workings?.model?.b2cs ?? []).filter(
        (x) => x.placeOfSupply === t.placeOfSupply && x.ratePercent === t.ratePercent,
      );
      if (!filed || rows.length === 0) {
        throw new UnprocessableError(
          'No B2CS row for that state and rate is in the filed GSTR-1 of that period.',
          ErrorCode.UNPROCESSABLE,
        );
      }
      section = 'b2cs';
      documentKey = `${t.placeOfSupply}|${t.ratePercent}`;
      originalPeriod = t.originalPeriod;
      const sum = rows.reduce<TaxedValue>(
        (s, x) => ({
          taxable: s.taxable + x.value.taxable,
          igst: s.igst + x.value.igst,
          cgst: s.cgst + x.value.cgst,
          sgst: s.sgst + x.value.sgst,
          cess: s.cess + x.value.cess,
        }),
        { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 },
      );
      const row: AmendableB2csRow = {
        placeOfSupply: t.placeOfSupply,
        intraState: rows[0]!.intraState,
        ratePercent: t.ratePercent,
        ecommerceGstin: rows[0]!.ecommerceGstin ?? null,
        value: sum,
      };
      original = await latestReported(tx, body.gstin, section, documentKey, row);
      const v = body.revised.b2csValue;
      if (!v) {
        throw new UnprocessableError('A B2CS amendment needs the revised value.', ErrorCode.UNPROCESSABLE);
      }
      revised = {
        ...(original as AmendableB2csRow),
        ratePercent: body.revised.b2csRatePercent ?? t.ratePercent,
        value: v,
      };
    }

    const route: AmendmentRoute = body.route;
    const reportPeriod = route === 'gstr1a' ? originalPeriod : body.reportPeriod;
    if (!reportPeriod) {
      throw new UnprocessableError(
        'An amendment in a later GSTR-1 needs the period it is reported in.',
        ErrorCode.UNPROCESSABLE,
      );
    }
    const refusals = amendmentRefusals(
      {
        section,
        route,
        originalPeriod,
        reportPeriod,
        gstr1FiledForOriginal: true,
        gstr3bFiledForOriginal: await filedFor(tx, body.gstin, 'gstr3b', originalPeriod),
        reportReturnFiled: await filedFor(tx, body.gstin, route === 'gstr1a' ? 'gstr1a' : 'gstr1', reportPeriod),
        today,
      },
      original,
      revised,
    );
    if (refusals.length > 0) {
      throw new UnprocessableError(refusals[0]!.message, ErrorCode.CORRECTION_NOT_ALLOWED, {
        details: { refusals },
      });
    }

    await tx.query(
      `INSERT INTO gst_amendments (id, tenant_id, gstin, section, route, original_period, report_period,
         document_table, document_id, document_key, original, revised, reason, created_by)
       VALUES ($1, app.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13)`,
      [
        body.id,
        body.gstin,
        section,
        route,
        originalPeriod,
        reportPeriod,
        documentTable,
        documentId,
        documentKey,
        JSON.stringify(original),
        JSON.stringify(revised),
        body.reason,
        auth.userId,
      ],
    );
    await recordAudit(tx, {
      action: 'gst_amendment.created',
      entityType: 'gst_amendment',
      entityId: body.id,
      metadata: { gstin: body.gstin, section, route, originalPeriod, reportPeriod, documentKey },
    });
    return getAmendment(tx, body.id);
  });
}

const AMENDMENT_COLUMNS = `id, gstin, section, route, original_period AS "originalPeriod",
  report_period AS "reportPeriod", document_table AS "documentTable", document_id AS "documentId",
  document_key AS "documentKey", original, revised, reason, status, created_at AS "createdAt"`;

async function getAmendment(tx: Tx, id: string) {
  const row = await tx.one<{ section: AmendmentSection; original: AmendmentRecord; revised: AmendmentRecord }>(
    `SELECT ${AMENDMENT_COLUMNS} FROM gst_amendments WHERE id = $1`,
    [id],
  );
  if (!row) throw new NotFoundError('Amendment');
  return { ...row, difference: amendmentDifference(row.section, row.original, row.revised) };
}

export function listAmendments(query: ListAmendmentsQuery) {
  return withReadTransaction(async (tx) => {
    await assertFeature(tx, 'gst_workings');
    const rows = await tx.many<{ section: AmendmentSection; original: AmendmentRecord; revised: AmendmentRecord }>(
      `SELECT ${AMENDMENT_COLUMNS} FROM gst_amendments
       WHERE gstin = $1 AND ($2::text IS NULL OR report_period = $2)
       ORDER BY report_period DESC, created_at DESC LIMIT 500`,
      [query.gstin, query.reportPeriod ?? null],
    );
    return rows.map((r) => ({ ...r, difference: amendmentDifference(r.section, r.original, r.revised) }));
  });
}

export function withdrawAmendment(id: string) {
  return withTransaction(async (tx) => {
    await assertFeature(tx, 'gst_workings');
    const row = await tx.one<{ gstin: string; route: AmendmentRoute; reportPeriod: string; status: string }>(
      `SELECT gstin, route, report_period AS "reportPeriod", status FROM gst_amendments WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!row) throw new NotFoundError('Amendment');
    if (row.status === 'withdrawn') return getAmendment(tx, id);
    if (await filedFor(tx, row.gstin, row.route === 'gstr1a' ? 'gstr1a' : 'gstr1', row.reportPeriod)) {
      throw new UnprocessableError(
        'The return carrying this amendment is filed; it can no longer be withdrawn.',
        ErrorCode.CORRECTION_NOT_ALLOWED,
      );
    }
    await tx.query(`UPDATE gst_amendments SET status = 'withdrawn', updated_at = now() WHERE id = $1`, [id]);
    await recordAudit(tx, { action: 'gst_amendment.withdrawn', entityType: 'gst_amendment', entityId: id });
    return getAmendment(tx, id);
  });
}

// --- For the return engines ---------------------------------------------------------------------

export interface ActiveAmendment {
  id: string;
  section: AmendmentSection;
  route: AmendmentRoute;
  originalPeriod: string;
  documentKey: string;
  original: AmendmentRecord;
  revised: AmendmentRecord;
  reason: string;
}

export function activeAmendments(
  tx: Tx,
  gstin: string,
  reportPeriod: string,
  route?: AmendmentRoute,
): Promise<ActiveAmendment[]> {
  return tx.many<ActiveAmendment>(
    `SELECT id, section, route, original_period AS "originalPeriod", document_key AS "documentKey",
            original, revised, reason
     FROM gst_amendments
     WHERE gstin = $1 AND report_period = $2 AND status = 'active' AND ($3::text IS NULL OR route = $3)
     ORDER BY section, document_key`,
    [gstin, reportPeriod, route ?? null],
  );
}

/** The amendments of a period as the GSTR-1 model's table 9A / 9C / 10 sections. */
export function toGstr1Amendments(list: readonly ActiveAmendment[]): Gstr1Amendments {
  const out = {
    b2b: [] as Gstr1Amendments['b2b'][number][],
    b2cl: [] as Gstr1Amendments['b2cl'][number][],
    b2cs: [] as Gstr1Amendments['b2cs'][number][],
    exports: [] as Gstr1Amendments['exports'][number][],
    cdnr: [] as Gstr1Amendments['cdnr'][number][],
    cdnur: [] as Gstr1Amendments['cdnur'][number][],
  };
  for (const a of list) {
    if (a.section === 'b2cs') {
      const r = a.revised as AmendableB2csRow;
      out.b2cs.push({
        originalMonth: a.originalPeriod,
        row: {
          intraState: r.intraState,
          placeOfSupply: r.placeOfSupply,
          ratePercent: r.ratePercent,
          viaEcommerce: Boolean(r.ecommerceGstin),
          ...(r.ecommerceGstin ? { ecommerceGstin: r.ecommerceGstin } : {}),
          value: r.value,
        },
      });
      continue;
    }
    const o = a.original as AmendableDocument;
    const r = a.revised as AmendableDocument;
    const base = { originalNumber: o.number, originalDate: o.date };
    switch (a.section) {
      case 'b2b':
        out.b2b.push({
          ...base,
          recipientGstin: r.recipientGstin ?? '',
          invoice: {
            number: r.number,
            date: r.date,
            value: r.value,
            placeOfSupply: r.placeOfSupply,
            reverseCharge: r.reverseCharge ?? false,
            recipientKind: r.recipientKind ?? 'regular',
            lines: r.lines,
          },
        });
        break;
      case 'b2cl':
        out.b2cl.push({
          ...base,
          placeOfSupply: r.placeOfSupply,
          invoice: { number: r.number, date: r.date, value: r.value, lines: r.lines },
        });
        break;
      case 'exp':
        out.exports.push({
          ...base,
          export: {
            exportType: r.exportType ?? 'with_payment',
            number: r.number,
            date: r.date,
            value: r.value,
            lines: r.lines,
          },
        });
        break;
      case 'cdnr':
        out.cdnr.push({
          ...base,
          recipientGstin: r.recipientGstin ?? '',
          note: {
            kind: r.noteKind ?? 'credit',
            number: r.number,
            date: r.date,
            value: r.value,
            placeOfSupply: r.placeOfSupply,
            reverseCharge: r.reverseCharge ?? false,
            recipientKind: r.recipientKind ?? 'regular',
            lines: r.lines,
          },
        });
        break;
      case 'cdnur':
        out.cdnur.push({
          ...base,
          note: {
            kind: r.noteKind ?? 'credit',
            type: r.unregisteredType ?? 'b2cl',
            number: r.number,
            date: r.date,
            value: r.value,
            placeOfSupply: r.placeOfSupply,
            lines: r.lines,
          },
        });
        break;
    }
  }
  const empty = Object.values(out).every((l) => l.length === 0);
  return empty ? NO_AMENDMENTS : out;
}
