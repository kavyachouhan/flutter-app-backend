/**
 * Supplies made through e-commerce operators, from the supplier's side (GSTR-1 table 14,
 * Notification 26/2022-CT; GSTN advisory on tables 14 and 15, live from the January 2024 period).
 * Pure.
 *
 *   14(a) the operator collects tax at source under s.52: the sales stay in tables 4-10 as usual,
 *         and the operator-wise totals (net of notes) are reported here as well. Not auto-filled
 *         into GSTR-3B.
 *   14(b) the operator pays the tax under s.9(5): the supplier charges no tax and reports the sales
 *         only here, not in tables 4, 5, 7 or 8 (26/2022 instructions to 4A, 4B and 8). Their value
 *         goes to GSTR-3B 3.1.1(ii). The tax shown is what the operator pays at the line's rate.
 *
 * The JSON layout follows the official Save schema in `data/gstn-schemas/GSTR1`, which keys 14(a)
 * rows by operator GSTIN, place of supply, recipient type and tax period. The portal manual and the
 * Offline Tool show operator-wise totals only; the schema layout is not confirmed by a portal
 * sample (GST_PENDING §1).
 */
import type { EngineDoc } from './gstr1-engine.js';
import type { TaxedValue } from './model.js';

export interface EcoTcsRow {
  readonly operatorGstin: string;
  readonly placeOfSupply: string;
  readonly recipientRegistered: boolean;
  readonly value: TaxedValue;
}

export interface EcoS95Row {
  readonly operatorGstin: string;
  readonly value: TaxedValue;
}

export interface Gstr1Ecommerce {
  readonly tcs: readonly EcoTcsRow[];
  readonly s9_5: readonly EcoS95Row[];
}

const ZERO: TaxedValue = { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
const add = (a: TaxedValue, b: TaxedValue, k: number): TaxedValue => ({
  taxable: a.taxable + k * b.taxable,
  igst: a.igst + k * b.igst,
  cgst: a.cgst + k * b.cgst,
  sgst: a.sgst + k * b.sgst,
  cess: a.cess + k * b.cess,
});

export function isS95(d: EngineDoc): boolean {
  return d.ecoLiability === 's9_5' && d.ecoGstin !== null;
}

/**
 * Splits the period's documents: s.9(5) supplies leave the regular tables, and both 14(a) and 14(b)
 * are summed by operator.
 */
export function splitEcommerce(docs: readonly EngineDoc[]): {
  forTables: EngineDoc[];
  ecommerce: Gstr1Ecommerce;
} {
  const forTables: EngineDoc[] = [];
  const tcs = new Map<string, EcoTcsRow>();
  const s95 = new Map<string, EcoS95Row>();
  for (const d of docs) {
    const issued = d.status === 'issued';
    const sign = d.kind === 'credit_note' ? -1 : 1;
    const lines = d.lines.filter((l) => l.category === 'taxable');
    if (isS95(d)) {
      if (!issued) continue;
      const intra = d.supplyType === 'intra_state';
      // The operator's tax at the line rate: this invoice carries none.
      const value = lines.reduce<TaxedValue>((s, l) => {
        const tax = (l.taxable * l.ratePercent) / 100;
        return add(
          s,
          {
            taxable: l.taxable,
            igst: intra ? 0 : Math.round(tax),
            cgst: intra ? Math.round(tax / 2) : 0,
            sgst: intra ? Math.round(tax / 2) : 0,
            cess: l.cess,
          },
          sign,
        );
      }, ZERO);
      const key = d.ecoGstin!;
      const cur = s95.get(key);
      s95.set(key, { operatorGstin: key, value: add(cur?.value ?? ZERO, value, 1) });
      continue;
    }
    forTables.push(d);
    if (!issued || !d.ecoGstin) continue;
    const value = lines.reduce<TaxedValue>(
      (s, l) => add(s, { taxable: l.taxable, igst: l.igst, cgst: l.cgst, sgst: l.sgst, cess: l.cess }, sign),
      ZERO,
    );
    const pos = d.placeOfSupply ?? '';
    const registered = Boolean(d.customerGstin);
    const key = `${d.ecoGstin}|${pos}|${registered}`;
    const cur = tcs.get(key);
    tcs.set(key, {
      operatorGstin: d.ecoGstin,
      placeOfSupply: pos,
      recipientRegistered: registered,
      value: add(cur?.value ?? ZERO, value, 1),
    });
  }
  return { forTables, ecommerce: { tcs: [...tcs.values()], s9_5: [...s95.values()] } };
}

/** Operator-wise totals of 14(a), as the portal screen and the Offline Tool show them. */
export function tcsByOperator(e: Gstr1Ecommerce): { operatorGstin: string; value: TaxedValue }[] {
  const m = new Map<string, TaxedValue>();
  for (const r of e.tcs) m.set(r.operatorGstin, add(m.get(r.operatorGstin) ?? ZERO, r.value, 1));
  return [...m.entries()].map(([operatorGstin, value]) => ({ operatorGstin, value }));
}
