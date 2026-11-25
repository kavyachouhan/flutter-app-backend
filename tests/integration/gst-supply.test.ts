/**
 * A3 through the real API: the place of supply follows the scenario, Rule 46 refuses an incomplete
 * tax invoice, documents print what they froze, and the legal wording reaches paper.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeOwnerClient, ownerClient } from './setup/database.js';
import { createTenant, type TenantFixture } from './setup/tenant.js';
import { createItem, createSeries, invoicePayload, leaseBlock } from './setup/fixtures.js';
import { data, error } from './setup/body.js';
import { closePool } from '../../src/db/pool.js';
import { gstinCheckCharacter } from '../../src/domain/gst/gstin.js';

function validGstin(state: string): string {
  const letters = randomUUID().replace(/[^a-f]/g, '').toUpperCase().padEnd(5, 'A').slice(0, 5);
  const digits = String(Math.floor(Math.random() * 10_000)).padStart(4, '0');
  const first14 = `${state}${letters}${digits}B1Z`;
  return first14 + gstinCheckCharacter(first14);
}

interface PrintDoc {
  title: string;
  customer?: { name: string; stateName?: string; addressLines: string[] };
  shipTo?: { addressLines: string[]; stateName?: string };
  meta: { label: string; value: string }[];
  totals: { label: string; paise?: number }[];
  termsLines: string[];
  taxRows: { rate: string; igst?: string }[];
  stateTaxLabel?: string;
  amountInWords?: string;
}

type Details = Record<string, unknown>;

const KA_ADDRESS = { line1: '5 Brigade Road', city: 'Bengaluru', pincode: '560001', stateCode: '29' };

describe('GST supply and printing', () => {
  let shop: TenantFixture;
  let seriesId: string;
  let next = 0;
  let item: { id: string };
  const PRICE = 10_000;

  const seq = (): number => {
    next += 1;
    return next;
  };

  /** A paid bill of one piece, so no test here depends on a khata. */
  const bill = (over: Record<string, unknown>, unitPrice = PRICE) => {
    const base = invoicePayload(shop, {
      seriesId,
      sequenceNo: seq(),
      lines: [{ itemId: item.id, quantity: 1000, unitPrice, taxRatePercent: 18 }],
    });
    const tax = Math.round(unitPrice * 0.18);
    const payload: Record<string, unknown> = {
      ...base,
      payments: [{ id: randomUUID(), mode: 'cash', amount: unitPrice + tax }],
      ...over,
    };
    if ('placeOfSupplyStateCode' in over === false) delete payload['placeOfSupplyStateCode'];
    return shop.post('/v1/invoices').send(payload);
  };

  const printOf = async (id: string): Promise<PrintDoc> =>
    data<PrintDoc>(await shop.get(`/v1/invoices/${id}/print-payload`).expect(200));

  const customer = async (fields: Record<string, unknown>): Promise<string> => {
    const id = randomUUID();
    await shop.post('/v1/customers').send({ id, name: 'A Buyer', ...fields }).expect(201);
    return id;
  };

  beforeAll(async () => {
    shop = await createTenant({ stateCode: '27' });
    item = await createItem(shop, { salePrice: PRICE, taxRatePercent: 18, trackStock: false });
    const series = await createSeries(shop);
    seriesId = series.id;
    await leaseBlock(shop, seriesId, 200);
  });

  afterAll(async () => {
    await closeOwnerClient();
    await closePool();
  });

  it('keeps an out-of-state customer buying at the counter in the seller state', async () => {
    const customerId = await customer(KA_ADDRESS);
    const res = await bill({ customerId, supplyScenario: 'counter_sale' }).expect(201);
    const invoice = data<{ placeOfSupplyStateCode: string; supplyType: string; totalCgst: number; posProvision: string }>(res);
    expect(invoice).toMatchObject({ placeOfSupplyStateCode: '27', supplyType: 'intra_state', posProvision: 'igst_10_1_c' });
    expect(invoice.totalCgst).toBe(900);
  });

  it('taxes a delivery to another state as inter-state', async () => {
    const customerId = await customer(KA_ADDRESS);
    const res = await bill({ customerId, supplyScenario: 'delivered', placeOfSupplyStateCode: '29' }).expect(201);
    expect(data(res)).toMatchObject({ supplyType: 'inter_state', totalIgst: 1800, totalCgst: 0 });
  });

  it('refuses a place of supply that does not follow from the scenario', async () => {
    const customerId = await customer(KA_ADDRESS);
    const res = await bill({ customerId, supplyScenario: 'counter_sale', placeOfSupplyStateCode: '29' }).expect(422);
    expect(error(res).code).toBe('PLACE_OF_SUPPLY_MISMATCH');
  });

  it('refuses a reserved scenario with its typed error', async () => {
    const res = await bill({ supplyScenario: 'deemed_export' }).expect(422);
    expect(error(res).code).toBe('UNSUPPORTED_SCENARIO');
  });

  it('applies Rule 46 at exactly ₹50,000 and not below', async () => {
    await bill({ supplyScenario: 'counter_sale' }, 4_999_999).expect(201);
    const refused = await bill({ supplyScenario: 'counter_sale' }, 5_000_000).expect(422);
    expect(error(refused).code).toBe('RULE_46_DETAILS_MISSING');
    expect((error(refused).details as Details)['missing']).toEqual([
      'recipient_name',
      'recipient_address',
      'recipient_state',
      'delivery_address',
      'delivery_state',
    ]);
  });

  it('accepts the details typed at the till for a walk-in with no saved customer', async () => {
    const buyerSnapshot = {
      name: 'Walk In Buyer',
      legalName: null,
      gstin: null,
      uin: null,
      gstTreatment: 'consumer',
      address: { line1: '1 Hill Road', line2: null, city: 'Pune', postalCode: '411001', stateCode: '27', countryCode: 'IN' },
      phone: null,
      email: null,
    };
    const res = await bill({ supplyScenario: 'counter_sale', buyerSnapshot }, 5_000_000).expect(201);
    const doc = await printOf(data<{ id: string }>(res).id);
    expect(doc.customer?.name).toBe('Walk In Buyer');
    expect(doc.customer?.stateName).toBe('Maharashtra (27)');
  });

  it('requires a registered buyer to have an address at any value', async () => {
    const customerId = await customer({ gstin: validGstin('27') });
    const res = await bill({ customerId, supplyScenario: 'counter_sale' }).expect(422);
    expect((error(res).details as Details)['missing']).toEqual(['recipient_address']);
  });

  it('prints what the document froze after the customer changes', async () => {
    const customerId = await customer({ ...KA_ADDRESS, name: 'Old Name' });
    const res = await bill({ customerId, supplyScenario: 'delivered' }).expect(201);
    const id = data<{ id: string }>(res).id;
    const before = await printOf(id);
    await shop.patch(`/v1/customers/${customerId}`).send({ name: 'New Name', addressLine1: 'Moved Away' }).expect(200);
    const after = await printOf(id);
    expect(after.customer).toEqual(before.customer);
    expect(after.customer?.name).toBe('Old Name');
  });

  it('copies the frozen parties onto a credit note', async () => {
    const customerId = await customer({ ...KA_ADDRESS, name: 'Returning Buyer' });
    const res = await bill({ customerId, supplyScenario: 'delivered' }).expect(201);
    const id = data<{ id: string }>(res).id;
    const lines = data<{ lines: { id: string }[] }>(await shop.get(`/v1/invoices/${id}`).expect(200)).lines;
    await shop.patch(`/v1/customers/${customerId}`).send({ name: 'Renamed Since' }).expect(200);

    const credits = await createSeries(shop, { prefix: 'CN', documentType: 'credit_note' });
    await leaseBlock(shop, credits.id, 5);
    const note = data<{ id: string }>(
      await shop
        .post('/v1/credit-notes')
        .send({
          id: randomUUID(),
          originalInvoiceId: id,
          seriesId: credits.id,
          sequenceNo: 1,
          documentDate: new Date().toISOString().slice(0, 10),
          issuedAt: new Date().toISOString(),
          lines: [{ id: randomUUID(), invoiceLineId: lines[0]?.id, quantity: 1000 }],
          reasonCode: 'return',
          refundMode: 'khata',
        })
        .expect(201),
    );

    const db = await ownerClient();
    const { rows } = await db.query<{
      seller_snapshot: { gstin: string };
      buyer_snapshot: { name: string };
      dispatch_from_snapshot: unknown;
      supply_scenario: string;
      pos_provision: string;
    }>(
      `SELECT seller_snapshot, buyer_snapshot, dispatch_from_snapshot, supply_scenario, pos_provision
         FROM credit_notes WHERE id = $1`,
      [note.id],
    );
    expect(rows[0]?.seller_snapshot.gstin).toMatch(/^27/);
    expect(rows[0]?.buyer_snapshot.name).toBe('Returning Buyer');
    expect(rows[0]?.dispatch_from_snapshot).not.toBeNull();
    expect(rows[0]).toMatchObject({ supply_scenario: 'delivered', pos_provision: 'igst_10_1_a' });

    const printed = data<PrintDoc>(await shop.get(`/v1/credit-notes/${note.id}/print-payload`).expect(200));
    expect(printed.customer?.name).toBe('Returning Buyer');
    expect(printed.totals.map((t) => t.label)).toContain('IGST');
  });

  it('delivers to a saved address and prints it as the address of delivery', async () => {
    const customerId = await customer({ addressLine1: '9 Station Road', city: 'Pune', stateCode: '27' });
    const addressId = randomUUID();
    const put = await shop
      .put(`/v1/customers/${customerId}/addresses/${addressId}`)
      .send({ id: addressId, customerId, line1: '5 Brigade Road', city: 'Bengaluru', stateCode: '29', postalCode: '560001', isDefault: true })
      .expect(200);
    expect(data(put)).toMatchObject({ stateCode: '29', isDefault: true });
    const listed = data<unknown[]>(await shop.get(`/v1/customers/${customerId}/addresses`).expect(200));
    expect(listed).toHaveLength(1);

    const res = await bill({ customerId, supplyScenario: 'delivered', shipToAddressId: addressId }).expect(201);
    const invoice = data<{ id: string; placeOfSupplyStateCode: string }>(res);
    expect(invoice.placeOfSupplyStateCode).toBe('29');
    const doc = await printOf(invoice.id);
    expect(doc.shipTo?.addressLines[0]).toBe('5 Brigade Road');
    expect(doc.shipTo?.stateName).toBe('Karnataka (29)');
  });

  it('prints IGST and the Rule 46 endorsement on an SEZ supply in the same state', async () => {
    const customerId = await customer({
      gstin: validGstin('27'),
      gstTreatment: 'sez_unit',
      addressLine1: 'SEZ Park',
      city: 'Pune',
    });
    const res = await bill({ customerId, supplyScenario: 'supply_to_sez', sezAuthorisedOperations: true, sezUnderLut: false }).expect(201);
    const invoice = data<{ id: string; supplyType: string; totalIgst: number }>(res);
    expect(invoice).toMatchObject({ supplyType: 'sez_with_tax', totalIgst: 1800 });
    const doc = await printOf(invoice.id);
    expect(doc.totals.map((t) => t.label)).toContain('IGST');
    expect(doc.termsLines[0]).toBe(
      'SUPPLY MEANT FOR EXPORT/SUPPLY TO SEZ UNIT OR SEZ DEVELOPER FOR AUTHORISED OPERATIONS ON PAYMENT OF INTEGRATED TAX',
    );
  });

  it('charges no tax on an export under LUT and names the country of destination', async () => {
    const customerId = await customer({
      gstTreatment: 'overseas',
      countryCode: 'US',
      addressLine1: '1 Main Street',
      city: 'Boston',
      pincode: '02108',
    });
    const res = await bill({
      customerId,
      supplyScenario: 'export_goods_under_lut',
      payments: [{ id: randomUUID(), mode: 'cash', amount: PRICE }],
      expectedTotals: { grandTotal: PRICE, totalTax: 0, taxableAmount: PRICE },
    }).expect(201);
    const invoice = data<{ id: string; placeOfSupplyStateCode: string; totalIgst: number }>(res);
    expect(invoice).toMatchObject({ placeOfSupplyStateCode: '96', totalIgst: 0 });
    const doc = await printOf(invoice.id);
    expect(doc.customer?.stateName).toBe('United States');
    expect(doc.termsLines[0]).toContain('UNDER BOND OR LETTER OF UNDERTAKING');
  });

  it('states the rate, place of supply and reverse charge on the compact layout', async () => {
    const res = await bill({ supplyScenario: 'counter_sale' }).expect(201);
    const doc = await printOf(data<{ id: string }>(res).id);
    expect(doc.meta).toEqual(
      expect.arrayContaining([
        { label: 'Place of supply', value: 'Maharashtra (27)' },
        { label: 'Tax payable on reverse charge', value: 'No' },
      ]),
    );
    expect(doc.taxRows.length).toBeGreaterThan(0);
    expect(doc.amountInWords).toBeTruthy();
  });

  it('records an override with who and why', async () => {
    const customerId = await customer(KA_ADDRESS);
    const res = await bill({
      customerId,
      supplyScenario: 'counter_sale',
      posOverride: { placeOfSupply: '29', reason: 'Goods were sent after billing' },
      placeOfSupplyStateCode: '29',
    }).expect(201);
    const invoice = data<{ id: string; posProvision: string; posOverride: { reason: string; by: string } }>(res);
    expect(invoice.posProvision).toBe('override');
    expect(invoice.posOverride.reason).toBe('Goods were sent after billing');
    expect(invoice.posOverride.by).toBe(shop.userId);
    const db = await ownerClient();
    const audit = await db.query('SELECT 1 FROM audit_log WHERE entity_id = $1 AND action = $2', [
      invoice.id,
      'invoice.place_of_supply_overridden',
    ]);
    expect(audit.rowCount).toBe(1);
  });

  it('labels the state half UTGST in a union territory without a legislature', async () => {
    const ut = await createTenant({ stateCode: '04' });
    const utItem = await createItem(ut, { salePrice: PRICE, taxRatePercent: 18, trackStock: false });
    const series = await createSeries(ut);
    await leaseBlock(ut, series.id, 5);
    const base = invoicePayload(ut, {
      seriesId: series.id,
      sequenceNo: 1,
      lines: [{ itemId: utItem.id, quantity: 1000, unitPrice: PRICE, taxRatePercent: 18 }],
    });
    const { placeOfSupplyStateCode: _ignored, ...payload } = base;
    const res = await ut
      .post('/v1/invoices')
      .send({ ...payload, supplyScenario: 'counter_sale', payments: [{ id: randomUUID(), mode: 'cash', amount: PRICE + 1800 }] })
      .expect(201);
    const doc = data<PrintDoc>(await ut.get(`/v1/invoices/${data<{ id: string }>(res).id}/print-payload`).expect(200));
    expect(doc.totals.map((t) => t.label)).toContain('UTGST');
    expect(doc.stateTaxLabel).toBe('UTGST');
  });

  it('refuses a taxed purchase from a supplier with no state, rather than guessing', async () => {
    const supplierId = randomUUID();
    await shop.post('/v1/suppliers').send({ id: supplierId, name: 'No State Traders' }).expect(201);
    const today = new Date().toISOString().slice(0, 10);
    const res = await shop
      .post('/v1/purchase-bills')
      .send({
        id: randomUUID(),
        outletId: shop.outletId,
        supplierId,
        supplierInvoiceNo: 'S-1',
        supplierInvoiceDate: today,
        documentDate: today,
        receivedAt: new Date().toISOString(),
        lines: [{ id: randomUUID(), itemId: item.id, quantity: 1000, unitPrice: 100, taxRatePercent: 18 }],
        expectedTotals: { grandTotal: 118, totalTax: 18, taxableAmount: 100 },
      })
      .expect(400);
    expect(error(res).code).toBe('VALIDATION_FAILED');
    expect(error(res).message).toMatch(/supplier's state/);
  });
});
