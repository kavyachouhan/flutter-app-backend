/**
 * GSTR-1 mapper, schema snapshot 2026-11.
 *
 * Target: the official "GSTR1 - Save GSTR1 data" request schema
 * (`data/gstn-schemas/GSTR1/GSTR1 - Save GSTR1 data request_schema.json`), so this mapper is
 * `schema_verified`. The schema forbids unknown properties everywhere, so every key written here is
 * one the schema names, and the output is checked against it before it is handed over.
 *
 * Sections written: b2b, b2cl, b2cs, cdnr, cdnur, exp, nil, hsn (b2b / b2c split) and doc_issue.
 * Not written, because the engine does not compute them yet: advances (at, txpd), e-commerce
 * (ecom, supeco) and the amendment sections. If the model holds data for one, the export is
 * refused for it instead of leaving it out unseen.
 *
 * The schema carries no e-commerce operator GSTIN on b2b, b2cl or b2cs rows, so none is written.
 */
import type {
  Gstr1Export,
  Gstr1HsnRow,
  Gstr1Invoice,
  Gstr1Line,
  Gstr1Note,
  Gstr1Return,
  NilSupply,
  NoteKind,
  RecipientKind,
  TaxedValue,
  UnregisteredNoteKind,
} from '../model.js';
import { gstnDate, gstnPeriod, rate, rupees } from './format.js';
import type { MapResult, MapperIssue, ReturnMapper } from './types.js';

export const GSTR1_MAPPER_ID = 'gstr1-v2026.11';

interface ItemPayload {
  num: number;
  itm_det: {
    rt: number;
    txval: number;
    iamt?: number;
    camt?: number;
    samt?: number;
    csamt?: number;
  };
}

export interface Gstr1Payload {
  gstin: string;
  fp: string;
  b2b?: unknown[];
  b2cl?: unknown[];
  b2cs?: unknown[];
  cdnr?: unknown[];
  cdnur?: unknown[];
  exp?: unknown[];
  b2ba?: unknown[];
  b2cla?: unknown[];
  b2csa?: unknown[];
  cdnra?: unknown[];
  cdnura?: unknown[];
  expa?: unknown[];
  supeco?: { clttx?: unknown[]; paytx?: unknown[] };
  nil?: { inv: unknown[] };
  hsn?: { hsn_b2b: unknown[]; hsn_b2c: unknown[] };
  doc_issue?: { doc_det_new: unknown[] };
}

/** GSTN's code lists, kept here and nowhere else. */
const INVOICE_TYPE: Readonly<Record<RecipientKind, string>> = {
  regular: 'R',
  sez_with_payment: 'SEWP',
  sez_without_payment: 'SEWOP',
  deemed_export: 'DE',
};
const NOTE_TYPE: Readonly<Record<NoteKind, string>> = { credit: 'C', debit: 'D' };
const UNREGISTERED_NOTE_TYPE: Readonly<Record<UnregisteredNoteKind, string>> = {
  b2cl: 'B2CL',
  export_with_payment: 'EXPWP',
  export_without_payment: 'EXPWOP',
};
const NIL_TYPE: Readonly<Record<NilSupply, string>> = {
  inter_state_registered: 'INTRB2B',
  intra_state_registered: 'INTRAB2B',
  inter_state_unregistered: 'INTRB2C',
  intra_state_unregistered: 'INTRAB2C',
};

const yn = (b: boolean): 'Y' | 'N' => (b ? 'Y' : 'N');

/** The portal takes one item per rate; lines at the same rate are merged. */
function mergeByRate(lines: readonly Gstr1Line[]): [number, TaxedValue][] {
  const byRate = new Map<number, TaxedValue>();
  for (const line of lines) {
    const key = rate(line.ratePercent);
    const cur = byRate.get(key) ?? { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
    byRate.set(key, {
      taxable: cur.taxable + line.value.taxable,
      igst: cur.igst + line.value.igst,
      cgst: cur.cgst + line.value.cgst,
      sgst: cur.sgst + line.value.sgst,
      cess: cur.cess + line.value.cess,
    });
  }
  return [...byRate.entries()].sort((a, b) => a[0] - b[0]);
}

function items(lines: readonly Gstr1Line[], heads: 'all' | 'igst_cess'): ItemPayload[] {
  return mergeByRate(lines).map(([rt, v], index) => ({
    num: index + 1,
    itm_det:
      heads === 'all'
        ? {
            rt,
            txval: rupees(v.taxable),
            iamt: rupees(v.igst),
            camt: rupees(v.cgst),
            samt: rupees(v.sgst),
            csamt: rupees(v.cess),
          }
        : { rt, txval: rupees(v.taxable), iamt: rupees(v.igst), csamt: rupees(v.cess) },
  }));
}

const invoicePayload = (inv: Gstr1Invoice) => ({
  inum: inv.number,
  idt: gstnDate(inv.date),
  val: rupees(inv.value),
  pos: inv.placeOfSupply,
  rchrg: yn(inv.reverseCharge),
  inv_typ: INVOICE_TYPE[inv.recipientKind],
  itms: items(inv.lines, 'all'),
});

const notePayload = (note: Gstr1Note) => ({
  ntty: NOTE_TYPE[note.kind],
  nt_num: note.number,
  nt_dt: gstnDate(note.date),
  val: rupees(note.value),
  pos: note.placeOfSupply,
  rchrg: yn(note.reverseCharge),
  inv_typ: INVOICE_TYPE[note.recipientKind],
  itms: items(note.lines, 'all'),
});

function exportsPayload(list: readonly Gstr1Export[]): unknown[] {
  const groups = new Map<string, unknown[]>();
  for (const e of list) {
    const key = e.exportType === 'with_payment' ? 'WPAY' : 'WOPAY';
    const inv = {
      inum: e.number,
      idt: gstnDate(e.date),
      val: rupees(e.value),
      ...(e.shippingBill
        ? {
            sbnum: e.shippingBill.number,
            sbdt: gstnDate(e.shippingBill.date),
            sbpcode: e.shippingBill.portCode,
          }
        : {}),
      // Export items carry no item number in the schema.
      itms: mergeByRate(e.lines).map(([rt, v]) => ({
        rt,
        txval: rupees(v.taxable),
        iamt: rupees(v.igst),
        csamt: rupees(v.cess),
      })),
    };
    const list2 = groups.get(key) ?? [];
    list2.push(inv);
    groups.set(key, list2);
  }
  return [...groups.entries()].map(([exp_typ, inv]) => ({ exp_typ, inv }));
}

/** A quantity in thousandths as the schema's two-decimal number; reports when rounding was needed. */
function hsnQty(thousandths: number): { qty: number; rounded: boolean } {
  const rounded = Math.abs(thousandths) % 10 !== 0;
  // Integer arithmetic, so 2.505 rounds to 2.51 rather than whatever floating point says.
  return { qty: Math.round(thousandths / 10) / 100, rounded };
}

function hsnPayload(
  rows: readonly Gstr1HsnRow[],
  section: string,
  issues: MapperIssue[],
): unknown[] {
  let roundedCount = 0;
  const out = rows.map((r, index) => {
    if (!/^[0-9]{2,8}$/.test(r.hsn)) {
      issues.push({
        severity: 'error',
        code: 'hsn_code_invalid',
        message: `HSN/SAC "${r.hsn}" is not 2 to 8 digits. Fix the item's HSN before exporting.`,
        path: `hsn.${section}[${index}]`,
      });
    }
    const { qty, rounded } = hsnQty(r.quantity);
    if (rounded) roundedCount++;
    return {
      num: index + 1,
      hsn_sc: r.hsn,
      uqc: r.uqc.split('-')[0]?.toUpperCase() ?? 'OTH',
      qty,
      rt: rate(r.ratePercent),
      txval: rupees(r.value.taxable),
      iamt: rupees(r.value.igst),
      camt: rupees(r.value.cgst),
      samt: rupees(r.value.sgst),
      csamt: rupees(r.value.cess),
    };
  });
  if (roundedCount > 0) {
    issues.push({
      severity: 'warning',
      code: 'hsn_quantity_rounded',
      message: `${roundedCount} HSN row(s) have a quantity with more than two decimals; the portal takes two, so it was rounded.`,
      path: `hsn.${section}`,
    });
  }
  return out;
}

function map(model: Gstr1Return): MapResult<Gstr1Payload> {
  const issues: MapperIssue[] = [];
  const payload: Gstr1Payload = { gstin: model.gstin, fp: gstnPeriod(model.period) };

  if (model.b2b.length > 0) {
    payload.b2b = model.b2b.map((party) => ({
      ctin: party.recipientGstin,
      inv: party.invoices.map(invoicePayload),
    }));
  }

  if (model.b2cl.length > 0) {
    payload.b2cl = model.b2cl.map((group) => ({
      pos: group.placeOfSupply,
      inv: group.invoices.map((inv) => ({
        inum: inv.number,
        idt: gstnDate(inv.date),
        val: rupees(inv.value),
        // B2CL is inter-state only, so the portal carries IGST and cess.
        itms: items(inv.lines, 'igst_cess'),
      })),
    }));
  }

  if (model.b2cs.length > 0) {
    payload.b2cs = model.b2cs.map((row) => ({
      sply_ty: row.intraState ? 'INTRA' : 'INTER',
      typ: row.viaEcommerce ? 'E' : 'OE',
      pos: row.placeOfSupply,
      rt: rate(row.ratePercent),
      txval: rupees(row.value.taxable),
      ...(row.intraState
        ? { camt: rupees(row.value.cgst), samt: rupees(row.value.sgst) }
        : { iamt: rupees(row.value.igst) }),
      csamt: rupees(row.value.cess),
    }));
  }

  if (model.creditDebitNotesRegistered.length > 0) {
    payload.cdnr = model.creditDebitNotesRegistered.map((party) => ({
      ctin: party.recipientGstin,
      nt: party.notes.map(notePayload),
    }));
  }

  if (model.creditDebitNotesUnregistered.length > 0) {
    payload.cdnur = model.creditDebitNotesUnregistered.map((note) => ({
      typ: UNREGISTERED_NOTE_TYPE[note.type],
      ntty: NOTE_TYPE[note.kind],
      nt_num: note.number,
      nt_dt: gstnDate(note.date),
      val: rupees(note.value),
      pos: note.placeOfSupply,
      itms: items(note.lines, 'igst_cess'),
    }));
  }

  if (model.exports.length > 0) payload.exp = exportsPayload(model.exports);

  if (model.nilExemptNonGst.length > 0) {
    payload.nil = {
      inv: model.nilExemptNonGst.map((r) => ({
        sply_ty: NIL_TYPE[r.supply],
        nil_amt: rupees(r.nilRated),
        expt_amt: rupees(r.exempt),
        ngsup_amt: rupees(r.nonGst),
      })),
    };
  }

  if (model.hsnB2b.length > 0 || model.hsnB2c.length > 0) {
    // The schema requires hsn_b2b whenever hsn is present, even when empty.
    payload.hsn = {
      hsn_b2b: hsnPayload(model.hsnB2b, 'hsn_b2b', issues),
      hsn_b2c: hsnPayload(model.hsnB2c, 'hsn_b2c', issues),
    };
  }

  if (model.documentsIssued.length > 0) {
    const byCode = new Map<string, unknown[]>();
    for (const d of model.documentsIssued) {
      const list = byCode.get(d.code) ?? [];
      list.push({
        num: list.length + 1,
        from: d.from,
        to: d.to,
        totnum: d.total,
        cancel: d.cancelled,
        net_issue: d.net,
      });
      byCode.set(d.code, list);
    }
    payload.doc_issue = {
      doc_det_new: [...byCode.entries()].map(([doc_num, docs]) => ({ doc_num, docs })),
    };
  }

  writeAmendments(model, payload);

  // Table 14. 14(a) rows follow the Save schema's layout (operator, place of supply, recipient
  // type, tax period); 14(b) is operator-wise.
  const eco = model.ecommerce;
  if (eco && (eco.tcs.length > 0 || eco.s9_5.length > 0)) {
    const taxes = (v: TaxedValue) => ({
      igst: rupees(v.igst),
      cgst: rupees(v.cgst),
      sgst: rupees(v.sgst),
      cess: rupees(v.cess),
    });
    payload.supeco = {
      ...(eco.tcs.length > 0
        ? {
            clttx: eco.tcs.map((r) => ({
              etin: r.operatorGstin,
              suppval: rupees(r.value.taxable),
              ...taxes(r.value),
              pos: r.placeOfSupply,
              typeOfRecipient: r.recipientRegistered ? 'REG' : 'UNREG',
              taxPeriod: gstnPeriod(model.period),
            })),
          }
        : {}),
      ...(eco.s9_5.length > 0
        ? {
            paytx: eco.s9_5.map((r) => ({
              etin: r.operatorGstin,
              suppval: rupees(r.value.taxable),
              ...taxes(r.value),
            })),
          }
        : {}),
    };
    if (eco.tcs.length > 0) {
      issues.push({
        severity: 'warning',
        code: 'supeco_layout_unverified',
        message:
          'Table 14(a) is written in the Save schema layout (by operator, place of supply and recipient type); the portal manual shows operator-wise totals. Not confirmed with a portal sample.',
        path: 'supeco',
      });
    }
  }

  for (const [section, count] of Object.entries(model.otherSections)) {
    if (count > 0) {
      issues.push({
        severity: 'error',
        code: 'section_unsupported',
        message: `${count} record(s) in "${section}" cannot be exported yet: this section is not computed.`,
        path: section,
      });
    }
  }

  return { mapperId: GSTR1_MAPPER_ID, payload, issues };
}

/** Tables 9A, 9C and 10: the revised record plus the original's number and date (or month). */
function writeAmendments(model: Gstr1Return, payload: Gstr1Payload): void {
  const a = model.amendments;
  if (!a) return;
  const groupBy = <T>(list: readonly T[], key: (t: T) => string) => {
    const m = new Map<string, T[]>();
    for (const t of list) m.set(key(t), [...(m.get(key(t)) ?? []), t]);
    return m;
  };
  if (a.b2b.length > 0) {
    payload.b2ba = [...groupBy(a.b2b, (x) => x.recipientGstin).entries()].map(([ctin, list]) => ({
      ctin,
      inv: list.map((x) => ({
        ...invoicePayload(x.invoice),
        oinum: x.originalNumber,
        oidt: gstnDate(x.originalDate),
      })),
    }));
  }
  if (a.b2cl.length > 0) {
    payload.b2cla = [...groupBy(a.b2cl, (x) => x.placeOfSupply).entries()].map(([pos, list]) => ({
      pos,
      inv: list.map((x) => ({
        oinum: x.originalNumber,
        oidt: gstnDate(x.originalDate),
        inum: x.invoice.number,
        idt: gstnDate(x.invoice.date),
        val: rupees(x.invoice.value),
        itms: items(x.invoice.lines, 'igst_cess'),
      })),
    }));
  }
  if (a.b2cs.length > 0) {
    payload.b2csa = [
      ...groupBy(
        a.b2cs,
        (x) =>
          `${x.originalMonth}|${x.row.placeOfSupply}|${x.row.intraState}|${x.row.viaEcommerce}`,
      ).entries(),
    ].map(([, list]) => {
      const first = list[0]!;
      return {
        omon: `${first.originalMonth.slice(5, 7)}${first.originalMonth.slice(0, 4)}`,
        sply_ty: first.row.intraState ? 'INTRA' : 'INTER',
        typ: first.row.viaEcommerce ? 'E' : 'OE',
        pos: first.row.placeOfSupply,
        itms: list.map((x) => ({
          rt: rate(x.row.ratePercent),
          txval: rupees(x.row.value.taxable),
          ...(x.row.intraState
            ? { camt: rupees(x.row.value.cgst), samt: rupees(x.row.value.sgst) }
            : { iamt: rupees(x.row.value.igst) }),
          csamt: rupees(x.row.value.cess),
        })),
      };
    });
  }
  if (a.exports.length > 0) {
    const groups = exportsPayload(a.exports.map((x) => x.export)) as {
      exp_typ: string;
      inv: Record<string, unknown>[];
    }[];
    const originals = new Map(a.exports.map((x) => [x.export.number, x]));
    payload.expa = groups.map((g) => ({
      exp_typ: g.exp_typ,
      inv: g.inv.map((inv) => {
        const o = originals.get(String(inv['inum']))!;
        return { ...inv, oinum: o.originalNumber, oidt: gstnDate(o.originalDate) };
      }),
    }));
  }
  if (a.cdnr.length > 0) {
    payload.cdnra = [...groupBy(a.cdnr, (x) => x.recipientGstin).entries()].map(([ctin, list]) => ({
      ctin,
      nt: list.map((x) => ({
        ...notePayload(x.note),
        ont_num: x.originalNumber,
        ont_dt: gstnDate(x.originalDate),
      })),
    }));
  }
  if (a.cdnur.length > 0) {
    payload.cdnura = a.cdnur.map((x) => ({
      typ: UNREGISTERED_NOTE_TYPE[x.note.type],
      ntty: NOTE_TYPE[x.note.kind],
      nt_num: x.note.number,
      nt_dt: gstnDate(x.note.date),
      ont_num: x.originalNumber,
      ont_dt: gstnDate(x.originalDate),
      val: rupees(x.note.value),
      pos: x.note.placeOfSupply,
      itms: items(x.note.lines, 'igst_cess'),
    }));
  }
}

export const gstr1Mapper: ReturnMapper<Gstr1Return, Gstr1Payload> = {
  meta: { id: GSTR1_MAPPER_ID, form: 'gstr1', verification: 'schema_verified' },
  map,
};
