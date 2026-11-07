/**
 * A4 and the rest of A3 through the real API: value-only credit notes, sales debit notes, financial
 * credit notes, what a filed return stops, invoice-cum-bill of supply, registrations as the source
 * of GST facts, and frozen parties on documents that are not tax documents.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeOwnerClient, ownerClient } from './setup/database.js';
import { createTenant, type TenantFixture } from './setup/tenant.js';
import { createItem, createSeries, invoicePayload, leaseBlock, today } from './setup/fixtures.js';
import { data, error, rows } from './setup/body.js';
import { closePool } from '../../src/db/pool.js';
import { gstinCheckCharacter } from '../../src/domain/gst/gstin.js';

function validGstin(state: string): string {
  const letters = randomUUID().replace(/[^a-f]/g, '').toUpperCase().padEnd(5, 'A').slice(0, 5);
  const digits = String(Math.floor(Math.random() * 10_000)).padStart(4, '0');
  const first14 = `${state}${letters}${digits}B1Z`;
  return first14 + gstinCheckCharacter(first14);
}

interface Line {
  id: string;
  quantity: number;
  taxableAmount: number;
  cgst: number;
  igst: number;
  adjustmentKind?: string;
}
interface Note {
  id: string;
  status: string;
  grandTotal: number;
  taxableAmount: number;
  totalTax: number;
  restock?: boolean;
  correctionReason?: string;
  recipientItcReversalStatus?: string;
  lines: Line[];
}

describe('GST corrections', () => {
  let shop: TenantFixture;
  let gstin: string;
  let invoices: string;
  let credits: string;
  let debits: string;
  let financial: string;
  let item: { id: string };
  let invoiceSeq = 0;
  let creditSeq = 0;
  let debitSeq = 0;
  let financialSeq = 0;
  const PRICE = 10_000;

  const customer = async (fields: Record<string, unknown> = {}): Promise<string> => {
    const id = randomUUID();
    await shop.post('/v1/customers').send({ id, name: 'A Buyer', addressLine1: '9 Station Road', stateCode: '27', ...fields }).expect(201);
    return id;
  };

  /** An unpaid bill on the customer's khata, two pieces at ₹100 plus 18%. */
  const bill = async (customerId: string | null, over: Record<string, unknown> = {}) => {
    invoiceSeq += 1;
    const body = {
      ...invoicePayload(shop, {
        seriesId: invoices,
        sequenceNo: invoiceSeq,
        customerId,
        lines: [{ itemId: item.id, quantity: 2000, unitPrice: PRICE, taxRatePercent: 18 }],
      }),
      ...over,
    };
    const res = await shop.post('/v1/invoices').send(body).expect(201);
    return data<{ id: string; documentNumber: string; lines: { id: string }[] }>(res);
  };

  const credit = (invoiceId: string, lines: unknown[], over: Record<string, unknown> = {}) => {
    creditSeq += 1;
    return shop.post('/v1/credit-notes').send({
      id: randomUUID(),
      originalInvoiceId: invoiceId,
      seriesId: credits,
      sequenceNo: creditSeq,
      documentDate: today(),
      issuedAt: new Date().toISOString(),
      lines,
      reasonCode: 'price_correction',
      refundMode: 'khata',
      ...over,
    });
  };

  const debit = (invoiceId: string, lines: unknown[], correctionReason = 'value_increase') => {
    debitSeq += 1;
    return shop.post('/v1/sales-debit-notes').send({
      id: randomUUID(),
      originalInvoiceId: invoiceId,
      seriesId: debits,
      sequenceNo: debitSeq,
      documentDate: today(),
      issuedAt: new Date().toISOString(),
      correctionReason,
      lines,
    });
  };

  const balance = async (customerId: string): Promise<number> =>
    data<{ balance: number }>(await shop.get(`/v1/customers/${customerId}`).expect(200)).balance;

  beforeAll(async () => {
    gstin = validGstin('27');
    shop = await createTenant({ stateCode: '27', gstin });
    item = await createItem(shop, { salePrice: PRICE, taxRatePercent: 18 });
    const setUp = async (documentType: string, prefix: string): Promise<string> => {
      const s = await createSeries(shop, { documentType, prefix });
      await leaseBlock(shop, s.id, 100);
      return s.id;
    };
    invoices = await setUp('invoice', 'INV');
    credits = await setUp('credit_note', 'CN');
    debits = await setUp('sales_debit_note', 'SDN');
    financial = await setUp('financial_credit_note', 'FCN');
  });

  afterAll(async () => {
    await closeOwnerClient();
    await closePool();
  });

  describe('value-only credit notes', () => {
    it('credits value and tax with no goods coming back', async () => {
      const customerId = await customer();
      const invoice = await bill(customerId);
      const res = await credit(invoice.id, [{ id: randomUUID(), invoiceLineId: invoice.lines[0]?.id, valueAmount: 5000 }]).expect(201);
      const note = data<Note>(res);
      expect(note).toMatchObject({ taxableAmount: 5000, totalTax: 900, grandTotal: 5900, restock: false, correctionReason: 'value_reduction' });
      expect(note.lines[0]).toMatchObject({ quantity: 0, adjustmentKind: 'value' });
      expect(await balance(customerId)).toBe(23_600 - 5900);

      const db = await ownerClient();
      const moved = await db.query('SELECT 1 FROM stock_ledger_entries WHERE reference_id = $1', [note.id]);
      expect(moved.rowCount).toBe(0);
      // The goods were never returned, so all of them can still come back.
      const returnable = data<{ lines: { returnableQuantity: number; creditableValue: number }[] }>(
        await shop.get(`/v1/invoices/${invoice.id}/returnable`),
      );
      expect(returnable.lines[0]).toMatchObject({ returnableQuantity: 2000, creditableValue: 15_000 });
    });

    it('will not credit more value than the line has left', async () => {
      const invoice = await bill(await customer());
      const lineId = invoice.lines[0]?.id;
      await credit(invoice.id, [{ id: randomUUID(), invoiceLineId: lineId, valueAmount: 15_000 }]).expect(201);
      const over = await credit(invoice.id, [{ id: randomUUID(), invoiceLineId: lineId, valueAmount: 5001 }]).expect(400);
      expect(error(over).code).toBe('VALIDATION_FAILED');
    });

    it('corrects an excess rate by taxing the value at the difference', async () => {
      const invoice = await bill(await customer());
      const res = await credit(invoice.id, [
        { id: randomUUID(), invoiceLineId: invoice.lines[0]?.id, valueAmount: 20_000, differentialRatePercent: 13 },
      ]).expect(201);
      expect(data<Note>(res)).toMatchObject({ taxableAmount: 20_000, totalTax: 2600, correctionReason: 'excess_tax_charged' });
    });

    it('tracks whether a registered buyer reversed the credit on a discount', async () => {
      const invoice = await bill(await customer({ gstin: validGstin('27') }));
      const res = await credit(
        invoice.id,
        [{ id: randomUUID(), invoiceLineId: invoice.lines[0]?.id, valueAmount: 1000 }],
        { correctionReason: 'post_supply_discount' },
      ).expect(201);
      const note = data<Note>(res);
      expect(note.recipientItcReversalStatus).toBe('pending');
      const updated = await shop.post(`/v1/credit-notes/${note.id}/recipient-reversal`).send({ status: 'verified' }).expect(200);
      expect(data<Note>(updated).recipientItcReversalStatus).toBe('verified');
    });

    it('refuses a GST credit note after the time limit in s.34(2)', async () => {
      const invoice = await bill(await customer());
      const res = await credit(invoice.id, [{ id: randomUUID(), invoiceLineId: invoice.lines[0]?.id, valueAmount: 1000 }], {
        documentDate: '2099-01-01',
      }).expect(422);
      expect(error(res).code).toBe('CREDIT_NOTE_TIME_BARRED');
    });
  });

  describe('sales debit notes', () => {
    it('adds value and tax to the khata, in its own series, and a void takes it back', async () => {
      const customerId = await customer();
      const invoice = await bill(customerId);
      const res = await debit(invoice.id, [{ id: randomUUID(), invoiceLineId: invoice.lines[0]?.id, amount: 5000 }]).expect(201);
      const note = data<Note & { documentNumber: string; originalDocumentNumber: string }>(res);
      expect(note).toMatchObject({ taxableAmount: 5000, totalTax: 900, grandTotal: 5900, originalDocumentNumber: invoice.documentNumber });
      expect(note.documentNumber).toContain('SDN');
      expect(await balance(customerId)).toBe(23_600 + 5900);

      const db = await ownerClient();
      const registry = await db.query<{ series_family: string; number_state: string }>(
        'SELECT series_family, number_state FROM gst_document_numbers WHERE document_id = $1',
        [note.id],
      );
      expect(registry.rows[0]).toEqual({ series_family: 'debit_note_outward', number_state: 'issued' });

      const printed = data<{ title: string; meta: { label: string; value: string }[] }>(
        await shop.get(`/v1/sales-debit-notes/${note.id}/print-payload`).expect(200),
      );
      expect(printed.title).toBe('DEBIT NOTE');
      expect(printed.meta).toContainEqual({ label: 'Against invoice', value: invoice.documentNumber });

      const voided = await shop.post(`/v1/sales-debit-notes/${note.id}/void`).send({ reason: 'keyed wrong' }).expect(200);
      expect(data<Note>(voided).status).toBe('void');
      expect(await balance(customerId)).toBe(23_600);
    });

    it('charges an undercharged rate at the difference, which need not be a slab', async () => {
      const invoice = await bill(await customer());
      const res = await debit(
        invoice.id,
        [{ id: randomUUID(), invoiceLineId: invoice.lines[0]?.id, amount: 20_000, differentialRatePercent: 13 }],
        'tax_undercharged',
      ).expect(201);
      expect(data<Note>(res)).toMatchObject({ taxableAmount: 20_000, totalTax: 2600 });
    });

    it('needs a rate difference on a tax correction, and a saved customer', async () => {
      const invoice = await bill(await customer());
      await debit(invoice.id, [{ id: randomUUID(), invoiceLineId: invoice.lines[0]?.id, amount: 100 }], 'tax_undercharged').expect(400);

      const walkIn = await bill(null, { payments: [{ id: randomUUID(), mode: 'cash', amount: 23_600 }] });
      const refused = await debit(walkIn.id, [{ id: randomUUID(), invoiceLineId: walkIn.lines[0]?.id, amount: 100 }]).expect(422);
      expect(error(refused).code).toBe('CORRECTION_NOT_ALLOWED');
    });
  });

  describe('financial credit notes', () => {
    it('credits the khata with no tax, never reaches the number registry, and can be voided', async () => {
      const customerId = await customer();
      await bill(customerId);
      financialSeq += 1;
      const res = await shop
        .post('/v1/financial-credit-notes')
        .send({
          id: randomUUID(),
          outletId: shop.outletId,
          customerId,
          seriesId: financial,
          sequenceNo: financialSeq,
          documentDate: today(),
          issuedAt: new Date().toISOString(),
          amount: 3000,
          reason: 'Year-end goodwill',
        })
        .expect(201);
      const note = data<{ id: string; amount: number }>(res);
      expect(await balance(customerId)).toBe(23_600 - 3000);

      const db = await ownerClient();
      const registry = await db.query('SELECT 1 FROM gst_document_numbers WHERE document_id = $1', [note.id]);
      expect(registry.rowCount).toBe(0);

      const printed = data<{ title: string; termsLines: string[]; taxRows: unknown[] }>(
        await shop.get(`/v1/financial-credit-notes/${note.id}/print-payload`).expect(200),
      );
      expect(printed.title).toBe('COMMERCIAL CREDIT NOTE');
      expect(printed.termsLines[0]).toContain('carries no GST');
      expect(printed.taxRows).toEqual([]);

      await shop.post(`/v1/financial-credit-notes/${note.id}/void`).send({ reason: 'not agreed' }).expect(200);
      expect(await balance(customerId)).toBe(23_600);
      expect(rows(await shop.get(`/v1/financial-credit-notes?customerId=${customerId}`).expect(200))).toHaveLength(1);
    });
  });

  describe('once the GSTR-1 is filed', () => {
    it('refuses to cancel the invoice or its note, while a note can still correct it', async () => {
      const invoice = await bill(await customer());
      const noted = data<Note>(
        await credit(invoice.id, [{ id: randomUUID(), invoiceLineId: invoice.lines[0]?.id, valueAmount: 100 }]).expect(201),
      );
      const other = await bill(await customer());

      const db = await ownerClient();
      const date = new Date(today());
      await db.query(
        `INSERT INTO gst_return_periods (id, tenant_id, gstin, return_type, period_year, period_month, period_from, period_to,
           status, workings, filed_at, filed_by)
         VALUES ($1, $2, $3, 'gstr1', $4, $5, $6, $6, 'filed', '{}', now(), $7)`,
        [randomUUID(), shop.tenantId, gstin, date.getUTCFullYear(), date.getUTCMonth() + 1, today(), shop.userId],
      );

      const refused = await shop.post(`/v1/invoices/${other.id}/void`).send({ reason: 'mistake' }).expect(422);
      expect(error(refused).code).toBe('CORRECTION_NOT_ALLOWED');
      const noteRefused = await shop.post(`/v1/credit-notes/${noted.id}/void`).send({ reason: 'mistake' }).expect(422);
      expect(error(noteRefused).code).toBe('CORRECTION_NOT_ALLOWED');
      await credit(other.id, [{ id: randomUUID(), invoiceLineId: other.lines[0]?.id, valueAmount: 100 }]).expect(201);
    });
  });

  describe('invoice-cum-bill of supply', () => {
    it('is what a mixed bill to an unregistered buyer is, and a registered buyer still gets a tax invoice', async () => {
      const exempt = await createItem(shop, { salePrice: PRICE, taxRatePercent: 0 });
      const lines = (itemId: string) => ({
        id: randomUUID(),
        itemId,
        quantity: 1000,
        unitPrice: PRICE,
        taxRatePercent: 0,
        supplyCategory: 'exempt',
      });
      const mixed = async (customerId: string) => {
        invoiceSeq += 1;
        const base = invoicePayload(shop, {
          seriesId: invoices,
          sequenceNo: invoiceSeq,
          customerId,
          lines: [{ itemId: item.id, quantity: 1000, unitPrice: PRICE, taxRatePercent: 18 }],
        });
        const res = await shop
          .post('/v1/invoices')
          .send({
            ...base,
            lines: [...base.lines, lines(exempt.id)],
            expectedTotals: { grandTotal: 21_800, totalTax: 1800, taxableAmount: 20_000 },
          })
          .expect(201);
        return data<{ id: string; documentType: string }>(res);
      };
      const toConsumer = await mixed(await customer());
      expect(toConsumer.documentType).toBe('invoice_cum_bill_of_supply');
      const printed = data<{ title: string }>(await shop.get(`/v1/invoices/${toConsumer.id}/print-payload`).expect(200));
      expect(printed.title).toBe('INVOICE-CUM-BILL OF SUPPLY');

      const toBusiness = await mixed(await customer({ gstin: validGstin('27') }));
      expect(toBusiness.documentType).toBe('tax_invoice');
    });
  });

  describe('registrations as the source of GST facts', () => {
    it('writes the registration first and mirrors the old columns', async () => {
      const biz = await createTenant({ stateCode: '29' });
      const before = rows<{ id: string; isPrincipal: boolean; roundOffEnabled: boolean; gstin: string }>(
        await biz.get('/v1/gst/registrations').expect(200),
      );
      expect(before).toHaveLength(1);
      expect(before[0]).toMatchObject({ isPrincipal: true, roundOffEnabled: true });

      await biz.patch('/v1/tenant').send({ isComposition: true, compositionCategory: 'trader', compositionRatePercent: 1 }).expect(200);
      const db = await ownerClient();
      const profiles = await db.query<{ taxpayer_scheme: string }>(
        `SELECT taxpayer_scheme FROM gst_registration_profiles
          WHERE registration_id = $1 AND effective_from <= current_date AND (effective_to IS NULL OR effective_to > current_date)`,
        [before[0]?.id],
      );
      expect(profiles.rows.map((p) => p.taxpayer_scheme)).toEqual(['composition']);
      const tenant = await db.query<{ is_composition: boolean; gstin: string }>('SELECT is_composition, gstin FROM tenants WHERE id = $1', [biz.tenantId]);
      expect(tenant.rows[0]).toMatchObject({ is_composition: true, gstin: before[0]?.gstin });

      const own = validGstin('27');
      const outletId = biz.outletId;
      await biz.patch(`/v1/outlets/${outletId}`).send({ gstin: own, stateCode: '27' }).expect(200);
      const linked = await db.query<{ gstin: string; registration_id: string }>('SELECT gstin, registration_id FROM outlets WHERE id = $1', [outletId]);
      expect(linked.rows[0]?.gstin).toBe(own);
      const regs = rows<{ id: string; gstin: string; isPrincipal: boolean }>(await biz.get('/v1/gst/registrations').expect(200));
      expect(regs.find((r) => r.gstin === own)).toMatchObject({ id: linked.rows[0]?.registration_id, isPrincipal: false });

      await biz.patch(`/v1/outlets/${outletId}`).send({ gstin: null, stateCode: null }).expect(200);
      const closed = await db.query<{ effective_to: Date | null }>('SELECT effective_to FROM gst_registrations WHERE gstin = $1', [own]);
      expect(closed.rows[0]?.effective_to).not.toBeNull();
    });

    it('keeps round-off as the registration\'s own setting', async () => {
      const regs = rows<{ id: string }>(await shop.get('/v1/gst/registrations').expect(200));
      const res = await shop.patch(`/v1/gst/registrations/${regs[0]?.id}`).send({ roundOffEnabled: false }).expect(200);
      expect(data<{ roundOffEnabled: boolean }>(res).roundOffEnabled).toBe(false);
      await shop.patch(`/v1/gst/registrations/${regs[0]?.id}`).send({ roundOffEnabled: true }).expect(200);
    });
  });

  describe('documents that are not tax documents', () => {
    it('freeze who they are for, and refresh when edited', async () => {
      const customerId = await customer({ name: 'Delivered To' });
      const series = await createSeries(shop, { documentType: 'delivery_challan', prefix: 'DC' });
      await leaseBlock(shop, series.id, 5);
      const id = randomUUID();
      const res = await shop.post('/v1/delivery-challans').send({
        id,
        outletId: shop.outletId,
        customerId,
        seriesId: series.id,
        sequenceNo: 1,
        documentDate: today(),
        lines: [{ id: randomUUID(), itemId: item.id, quantity: 1000 }],
      });
      expect(res.status).toBeLessThan(300);
      const db = await ownerClient();
      const stored = await db.query<{ buyer_snapshot: { name: string }; seller_snapshot: { gstin: string }; registration_id: string | null }>(
        'SELECT buyer_snapshot, seller_snapshot, registration_id FROM delivery_challans WHERE id = $1',
        [id],
      );
      expect(stored.rows[0]?.buyer_snapshot.name).toBe('Delivered To');
      expect(stored.rows[0]?.seller_snapshot.gstin).toBe(gstin);
      expect(stored.rows[0]?.registration_id).not.toBeNull();
    });
  });
});
