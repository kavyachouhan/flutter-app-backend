import { z } from 'zod';
import { errorResponses } from '../../openapi/common.js';
import {
  accessTokenSecurity,
  calendarDate,
  dataEnvelope,
  jsonResponse,
  pageEnvelope,
  paise,
  percent,
  quantity,
  registry,
  timestamp,
  uuid,
} from '../../openapi/registry.js';
import {
  createDebitNoteBody,
  DEBIT_NOTE_REASONS,
  listDebitNotesQuery,
  voidDebitNoteBody,
} from './debit-notes.schemas.js';

const debitNote = registry.register(
  'DebitNote',
  z.object({
    id: uuid,
    outletId: uuid,
    supplierId: uuid,
    purchaseBillId: uuid,
    originalDocumentNumber: z.string(),
    documentNumber: z.string(),
    documentDate: calendarDate,
    reasonCode: z.enum(DEBIT_NOTE_REASONS),
    taxableAmount: paise,
    totalTax: paise,
    grandTotal: paise,
    status: z.enum(['issued', 'void']),
    issuedAt: timestamp,
    lines: z.array(
      z.object({
        id: uuid,
        purchaseBillLineId: uuid,
        lineNo: z.number().int(),
        itemId: uuid,
        itemName: z.string(),
        quantity,
        unitPrice: paise,
        taxRatePercent: percent,
        lineTotal: paise,
        effectiveUnitCost: paise,
      }),
    ),
  }),
);

const summary = registry.register(
  'DebitNoteSummary',
  z.object({
    id: uuid,
    documentNumber: z.string(),
    documentDate: calendarDate,
    supplierId: uuid,
    supplierName: z.string(),
    grandTotal: paise,
    status: z.string(),
  }),
);

registry.registerPath({
  method: 'post',
  path: '/v1/debit-notes',
  tags: ['Debit notes'],
  summary: 'Return goods or value to a supplier',
  description: [
    'A debit note is a GST document the shop *issues*, so unlike a purchase bill it carries only',
    'our own number, from a real series, and it counts towards GSTR-1 Table 13.',
    '',
    'Rates come from the original bill line, never the item master: a return is settled at what',
    'was paid, so our note and the supplier’s credit note agree to the paisa. Stock leaves at the',
    '`effectiveUnitCost` the goods came in at, unwinding exactly the value they added rather than',
    'today’s blended average.',
    '',
    'Set `restock: false` for damaged or expired goods the supplier credits without collecting —',
    'no stock then moves, because it already left usable inventory by other means.',
  ].join('\n'),
  security: accessTokenSecurity,
  request: { body: { content: { 'application/json': { schema: createDebitNoteBody } } } },
  responses: {
    201: jsonResponse('Issued.', dataEnvelope(debitNote)),
    200: jsonResponse('Already issued; the stored note is returned.', dataEnvelope(debitNote)),
    ...errorResponses(422),
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/debit-notes',
  tags: ['Debit notes'],
  summary: 'Debit notes',
  security: accessTokenSecurity,
  request: { query: listDebitNotesQuery },
  responses: { 200: jsonResponse('Newest first.', pageEnvelope(summary)), ...errorResponses() },
});

registry.registerPath({
  method: 'get',
  path: '/v1/debit-notes/{id}',
  tags: ['Debit notes'],
  summary: 'One debit note',
  security: accessTokenSecurity,
  request: { params: z.object({ id: uuid }) },
  responses: { 200: jsonResponse('Note.', dataEnvelope(debitNote)), ...errorResponses() },
});

registry.registerPath({
  method: 'post',
  path: '/v1/debit-notes/{id}/void',
  tags: ['Debit notes'],
  summary: 'Void a debit note',
  security: accessTokenSecurity,
  request: {
    params: z.object({ id: uuid }),
    body: { content: { 'application/json': { schema: voidDebitNoteBody } } },
  },
  responses: { 200: jsonResponse('Voided.', dataEnvelope(debitNote)), ...errorResponses(422) },
});
