/**
 * GSTR-3B mapper, schema snapshot 2026-11.
 *
 * Target: the official "GSTR3B - Save GSTR3B data" request schema
 * (`data/gstn-schemas/GSTR3B/GSTR3B - Save GSTR3B data request_schema.json`). It is the contract
 * for the offline-upload / save payload, so this mapper is `schema_verified`.
 *
 * Payment of tax (`tx_pmt`) and `liab_breakup` are not produced: they depend on the electronic
 * ledgers held by GSTN, which this system cannot see, and the Save payload does not require them.
 */
import type {
  Gstr3bReturn,
  ItcAvailableKind,
  ItcIneligibleKind,
  ItcReversedKind,
  PlaceOfSupplyRow,
  TaxAmounts,
  TaxedValue,
} from '../model.js';
import { gstnPeriod, rupees } from './format.js';
import type { MapResult, MapperIssue, ReturnMapper } from './types.js';

export const GSTR3B_MAPPER_ID = 'gstr3b-v2026.11';

export interface Gstr3bTaxPayload {
  txval: number;
  iamt: number;
  camt: number;
  samt: number;
  csamt: number;
}

export interface Gstr3bPayload {
  gstin: string;
  ret_period: string;
  sup_details: {
    osup_det: Gstr3bTaxPayload;
    osup_zero: { txval: number; iamt: number; csamt: number };
    osup_nil_exmp: { txval: number };
    isup_rev: Gstr3bTaxPayload;
    osup_nongst: { txval: number };
  };
  inter_sup: {
    unreg_details: { pos: string; txval: number; iamt: number }[];
    comp_details: { pos: string; txval: number; iamt: number }[];
    uin_details: { pos: string; txval: number; iamt: number }[];
  };
  eco_dtls?: { eco_sup: Gstr3bTaxPayload; eco_reg_sup: { txval: number } };
  itc_elg: {
    itc_avl: ItcRow[];
    itc_rev: ItcRow[];
    itc_net: ItcAmountsPayload;
    itc_inelg: ItcRow[];
  };
  inward_sup: { isup_details: { ty: 'GST' | 'NONGST'; inter: number; intra: number }[] };
  intr_ltfee?: {
    intr_details: ItcAmountsPayload;
    ltfee_details?: { camt: number; samt: number };
  };
}

interface ItcAmountsPayload {
  iamt: number;
  camt: number;
  samt: number;
  csamt: number;
}
interface ItcRow extends ItcAmountsPayload {
  ty: string;
}

const taxed = (v: TaxedValue): Gstr3bTaxPayload => ({
  txval: rupees(v.taxable),
  iamt: rupees(v.igst),
  camt: rupees(v.cgst),
  samt: rupees(v.sgst),
  csamt: rupees(v.cess),
});

const amounts = (t: TaxAmounts): ItcAmountsPayload => ({
  iamt: rupees(t.igst),
  camt: rupees(t.cgst),
  samt: rupees(t.sgst),
  csamt: rupees(t.cess),
});

const posRows = (rows: readonly PlaceOfSupplyRow[]) =>
  rows.map((r) => ({ pos: r.placeOfSupply, txval: rupees(r.taxable), iamt: rupees(r.igst) }));

/** GSTN's `ty` codes, kept here and nowhere else. */
const AVAILABLE_TY: Readonly<Record<ItcAvailableKind, string>> = {
  import_goods: 'IMPG',
  import_services: 'IMPS',
  reverse_charge: 'ISRC',
  isd: 'ISD',
  other: 'OTH',
};
const REVERSED_TY: Readonly<Record<ItcReversedKind, string>> = {
  rules_38_42_43_17_5: 'RUL',
  other: 'OTH',
};
// UNVERIFIED mapping: the supplied schema only says RUL / OTH under "Ineligible ITC". The current
// form's 4(D)(1) is reclaimed credit and 4(D)(2) is s.16(4)/PoS; the pairing below follows that order
// and must be confirmed against the portal's field reference before the form is filed from this file.
const INELIGIBLE_TY: Readonly<Record<ItcIneligibleKind, string>> = {
  reclaimed_after_reversal: 'RUL',
  section_16_4_or_pos: 'OTH',
};

const sum = (list: readonly TaxAmounts[]): TaxAmounts => ({
  igst: list.reduce((s, t) => s + t.igst, 0),
  cgst: list.reduce((s, t) => s + t.cgst, 0),
  sgst: list.reduce((s, t) => s + t.sgst, 0),
  cess: list.reduce((s, t) => s + t.cess, 0),
});

function map(model: Gstr3bReturn): MapResult<Gstr3bPayload> {
  const issues: MapperIssue[] = [];

  if (model.outward.zeroRated.taxable < 0) {
    issues.push({
      severity: 'warning',
      code: 'negative_zero_rated',
      message: 'Zero-rated outward value is negative for the period; check credit notes.',
      path: 'sup_details.osup_zero.txval',
    });
  }

  const available = (Object.keys(AVAILABLE_TY) as ItcAvailableKind[]).map((k) => ({
    ty: AVAILABLE_TY[k],
    ...amounts(model.itc.available[k]),
  }));
  const reversed = (Object.keys(REVERSED_TY) as ItcReversedKind[]).map((k) => ({
    ty: REVERSED_TY[k],
    ...amounts(model.itc.reversed[k]),
  }));
  const ineligible = (Object.keys(INELIGIBLE_TY) as ItcIneligibleKind[]).map((k) => ({
    ty: INELIGIBLE_TY[k],
    ...amounts(model.itc.ineligible[k]),
  }));

  const net = (() => {
    const a = sum(Object.values(model.itc.available));
    const r = sum(Object.values(model.itc.reversed));
    return {
      igst: a.igst - r.igst,
      cgst: a.cgst - r.cgst,
      sgst: a.sgst - r.sgst,
      cess: a.cess - r.cess,
    };
  })();
  if (net.igst < 0 || net.cgst < 0 || net.sgst < 0 || net.cess < 0) {
    issues.push({
      severity: 'warning',
      code: 'negative_net_itc',
      message:
        'Reversals exceed available credit for a tax head; the portal expects the excess to be shown as liability.',
      path: 'itc_elg.itc_net',
    });
  }

  const payload: Gstr3bPayload = {
    gstin: model.gstin,
    ret_period: gstnPeriod(model.period),
    sup_details: {
      osup_det: taxed(model.outward.taxable),
      osup_zero: {
        txval: rupees(model.outward.zeroRated.taxable),
        iamt: rupees(model.outward.zeroRated.igst),
        csamt: rupees(model.outward.zeroRated.cess),
      },
      osup_nil_exmp: { txval: rupees(model.outward.nilExempt) },
      isup_rev: taxed(model.outward.inwardReverseCharge),
      osup_nongst: { txval: rupees(model.outward.nonGst) },
    },
    inter_sup: {
      unreg_details: posRows(model.interState.unregistered),
      comp_details: posRows(model.interState.composition),
      uin_details: posRows(model.interState.uin),
    },
    itc_elg: {
      itc_avl: available,
      itc_rev: reversed,
      itc_net: amounts(net),
      itc_inelg: ineligible,
    },
    inward_sup: {
      isup_details: [
        {
          ty: 'GST',
          inter: rupees(model.inwardExempt.gst.interState),
          intra: rupees(model.inwardExempt.gst.intraState),
        },
        {
          ty: 'NONGST',
          inter: rupees(model.inwardExempt.nonGst.interState),
          intra: rupees(model.inwardExempt.nonGst.intraState),
        },
      ],
    },
  };

  if (model.ecommerce) {
    payload.eco_dtls = {
      eco_sup: taxed(model.ecommerce.ecoPaysTax),
      eco_reg_sup: { txval: rupees(model.ecommerce.registeredViaEco) },
    };
  }
  if (model.interest || model.lateFee) {
    payload.intr_ltfee = {
      intr_details: amounts(model.interest ?? { igst: 0, cgst: 0, sgst: 0, cess: 0 }),
      ...(model.lateFee
        ? { ltfee_details: { camt: rupees(model.lateFee.cgst), samt: rupees(model.lateFee.sgst) } }
        : {}),
    };
  }

  return { mapperId: GSTR3B_MAPPER_ID, payload, issues };
}

export const gstr3bMapper: ReturnMapper<Gstr3bReturn, Gstr3bPayload> = {
  meta: { id: GSTR3B_MAPPER_ID, form: 'gstr3b', verification: 'schema_verified' },
  map,
};
