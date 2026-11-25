/**
 * GSTR-9 mapper, schema snapshot 2026-11.
 *
 * Target: the official "GSTR9 - Save GSTR9 data" request schema
 * (`data/gstn-schemas/GSTR9/GSTR9 - Save GSTR9 data request_schema.json`). The *structure* is the
 * official one and is validated against it. Which schema key is which row of the form is read from
 * the keys, the form and the Offline Tool v2.2, and is NOT confirmed by a sample file, so this
 * mapper is `schema_checked_mapping_unverified` and every export is labelled a draft.
 *
 * Rows the engine does not compute are left out of the file, never written as zero: a zero would
 * overwrite whatever the taxpayer has entered for that row on the portal.
 *
 * Not written: Table 8 (the schema's descriptions for its keys are copied from other rows, so the
 * pairing of key and row cannot be told apart), Tables 10 to 16 (not computed), and the Table 6
 * rows with no schema key (6A, 6A1, 6A2, 6J and 6O are computed by the portal).
 */
import type { Gstr9Hsn, Gstr9ItcType, Gstr9Return, TaxAmounts, TaxedValue } from '../model.js';
import { rate, rupees } from './format.js';
import type { MapResult, MapperIssue, ReturnMapper } from './types.js';

export const GSTR9_MAPPER_ID = 'gstr9-v2026.11';

interface Five {
  txval: number;
  iamt: number;
  camt: number;
  samt: number;
  csamt: number;
}
interface Four {
  iamt: number;
  camt: number;
  samt: number;
  csamt: number;
}

const five = (v: TaxedValue): Five => ({
  txval: rupees(v.taxable),
  iamt: rupees(v.igst),
  camt: rupees(v.cgst),
  samt: rupees(v.sgst),
  csamt: rupees(v.cess),
});
const four = (t: TaxAmounts): Four => ({
  iamt: rupees(t.igst),
  camt: rupees(t.cgst),
  samt: rupees(t.sgst),
  csamt: rupees(t.cess),
});
const igstCess = (t: TaxAmounts) => ({ iamt: rupees(t.igst), csamt: rupees(t.cess) });
const anyTax = (t: TaxAmounts): boolean => t.igst !== 0 || t.cgst !== 0 || t.sgst !== 0 || t.cess !== 0;

const ITC_TYPES: readonly Gstr9ItcType[] = ['ip', 'cg', 'is'];

/** Quantity is whole or two-decimal in the schema; thousandths are rounded and reported. */
function hsnQty(thousandths: number): number {
  return Math.round(thousandths / 10) / 100;
}

function itemsFor(rows: readonly Gstr9Hsn[], table: string, issues: MapperIssue[]) {
  const out: Record<string, unknown>[] = [];
  rows.forEach((r, index) => {
    if (!/^[0-9]{2,8}$/.test(r.hsn)) {
      issues.push({
        severity: 'error',
        code: 'hsn_code_invalid',
        message: `HSN/SAC "${r.hsn}" is not 2 to 8 digits. Fix the item's HSN before exporting.`,
        path: `${table}.items[${index}]`,
      });
      return;
    }
    const service = r.hsn.startsWith('99');
    out.push({
      hsn_sc: r.hsn,
      isconcesstional: 'N',
      // The tool does not ask a service for a unit or quantity.
      ...(service ? {} : { uqc: r.uqc.split('-')[0]?.toUpperCase() ?? 'OTH', qty: hsnQty(r.quantity) }),
      txval: rupees(r.value.taxable),
      rt: rate(r.ratePercent),
      iamt: rupees(r.value.igst),
      camt: rupees(r.value.cgst),
      samt: rupees(r.value.sgst),
      csamt: rupees(r.value.cess),
    });
  });
  return out;
}

function map(model: Gstr9Return): MapResult<Record<string, unknown>> {
  const issues: MapperIssue[] = [];
  const warn = (code: string, message: string, path: string) =>
    issues.push({ severity: 'warning', code, message, path });

  const t4 = model.t4;
  const table4 = {
    flag: 'A',
    b2c: five(t4.b2c),
    b2b: five(t4.b2b),
    exp: { txval: rupees(t4.exp.taxable), iamt: rupees(t4.exp.igst), csamt: rupees(t4.exp.cess) },
    sez: { txval: rupees(t4.sez.taxable), iamt: rupees(t4.sez.igst), csamt: rupees(t4.sez.cess) },
    deemed: five(t4.deemed),
    rchrg: five(t4.inwardReverseCharge),
    // 4F advances (from GSTR-1 table 11), written only when there are any.
    ...(t4.advances.taxable !== 0 ? { at: five(t4.advances) } : {}),
    cr_nt: five(t4.creditNotes),
    dr_nt: five(t4.debitNotes),
  };

  const t5 = model.t5;
  const v = (taxable: number) => ({ txval: rupees(taxable) });
  const table5 = {
    flag: 'A',
    zero_rtd: v(t5.zeroRated),
    sez: v(t5.sez),
    rchrg: v(t5.reverseCharge),
    // 5C1 supplies through an operator liable under s.9(5) (from GSTR-1 table 14(b)).
    ...(t5.ecommerce !== 0 ? { ecom_14: v(t5.ecommerce) } : {}),
    exmt: v(t5.exempt),
    nil: v(t5.nilRated),
    non_gst: v(t5.nonGst),
    cr_nt: v(t5.creditNotes),
    dr_nt: v(t5.debitNotes),
  };

  const t6 = model.t6;
  const typed = (r: Readonly<Record<Gstr9ItcType, TaxAmounts>>) =>
    ITC_TYPES.map((k) => ({ itc_typ: k, ...four(r[k]) }));
  const hasAny = (r: Readonly<Record<Gstr9ItcType, TaxAmounts>>) => ITC_TYPES.some((k) => anyTax(r[k]));
  const table6: Record<string, unknown> = {
    flag: 'A',
    supp_non_rchrg: typed(t6.nonReverseCharge),
    ...(hasAny(t6.reverseChargeUnregistered) ? { supp_rchrg_unreg: typed(t6.reverseChargeUnregistered) } : {}),
    ...(hasAny(t6.reverseChargeRegistered) ? { supp_rchrg_reg: typed(t6.reverseChargeRegistered) } : {}),
    ...(anyTax(t6.importGoods.ip) || anyTax(t6.importGoods.cg)
      ? {
          iog: (['ip', 'cg'] as const).map((k) => ({ itc_typ: k, ...igstCess(t6.importGoods[k]) })),
        }
      : {}),
    ios: igstCess(t6.importServices),
    isd: four(t6.isd),
    itc_clmd: four(t6.reclaimed),
  };

  const t7 = model.t7;
  const table7: Record<string, unknown> = {
    flag: 'A',
    sec17: four(t7.section17),
    ...(anyTax(t7.other)
      ? { other: [{ desc: 'Other reversals per GSTR-3B 4(B)(2)', ...four(t7.other) }] }
      : {}),
  };
  for (const [key, amounts] of [['sec17', t7.section17], ['other', t7.other]] as const) {
    if (amounts.igst < 0 || amounts.cgst < 0 || amounts.sgst < 0 || amounts.cess < 0) {
      issues.push({
        severity: 'error',
        code: 'negative_reversal',
        message: 'A reversal in Table 7 is negative, which the portal does not accept. Check credit notes and debit notes against the credit entries.',
        path: `table7.${key}`,
      });
    }
  }

  const t9 = model.t9;
  const headRow = (h: { payable: number; paid: number | null }) => ({
    txpyble: rupees(h.payable),
    ...(h.paid === null ? {} : { total_tax_paid: rupees(h.paid), diff_tax_paid: rupees(h.payable - h.paid) }),
  });
  const table9 = {
    flag: 'A',
    iamt: headRow(t9.igst),
    camt: headRow(t9.cgst),
    samt: headRow(t9.sgst),
    csamt: headRow(t9.cess),
    intr: headRow(t9.interest),
    fee: headRow(t9.lateFee),
    pen: headRow(t9.penalty),
    other: headRow(t9.other),
  };

  const payload: Record<string, unknown> = {
    gstin: model.gstin,
    fp: `03${model.fy.endYear}`,
    table4,
    table5,
    table6,
    table7,
    table9,
  };
  const out17 = itemsFor(model.hsnOutward, 'table17', issues);
  if (out17.length > 0) payload['table17'] = { flag: 'A', items: out17 };
  const in18 = itemsFor(model.hsnInward, 'table18', issues);
  if (in18.length > 0) payload['table18'] = { flag: 'A', items: in18 };

  warn('table8_not_written', 'Table 8 is not in the file: the schema does not say which key is which row. Complete it on the portal.', 'table8');
  warn('tables_10_16_not_written', 'Tables 10 to 16 are not computed and are not in the file.', 'table10');
  warn('rows_not_written', `Not written, so the portal keeps what you entered there: ${model.notComputed.join('; ')}.`, 'table4');
  warn('table9_paid', model.t9.igst.paid === null ? 'Tax paid (Table 9) is not in the file: no ledger was imported.' : 'Tax paid in Table 9 comes from the imported ledgers; check it against the portal.', 'table9');
  warn('credit_notes_positive', 'Credit notes (4I, 5H) are written as positive amounts, as the form labels them (-). Confirm against a file saved from the portal.', 'table4.cr_nt');

  return { mapperId: GSTR9_MAPPER_ID, payload, issues };
}

export const gstr9Mapper: ReturnMapper<Gstr9Return, Record<string, unknown>> = {
  meta: { id: GSTR9_MAPPER_ID, form: 'gstr9', verification: 'schema_checked_mapping_unverified' },
  map,
};
