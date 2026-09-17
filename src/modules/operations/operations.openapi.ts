import { z } from 'zod';
import { idParams } from '../../lib/validators.js';
import {
  documentStatusSchema,
  errorResponses,
  tenderModeSchema,
  warningSchema,
} from '../../openapi/common.js';
import {
  accessTokenSecurity,
  calendarDate,
  dataEnvelope,
  jsonResponse,
  noContent,
  pageEnvelope,
  paise,
  registry,
  timestamp,
  uuid,
} from '../../openapi/registry.js';
import {
  createDayCloseBody,
  createExpenseBody,
  createExpenseCategoryBody,
  dayCloseExpectedQuery,
  listDayClosesQuery,
  listExpensesQuery,
  listHeldBillsQuery,
  releaseHeldBillBody,
  updateExpenseCategoryBody,
  upsertHeldBillBody,
  voidExpenseBody,
} from './operations.schemas.js';

const body = (schema: z.ZodTypeAny) => ({ content: { 'application/json': { schema } } });

export const heldBillSchema = registry.register(
  'HeldBill',
  z.object({
    id: uuid,
    outletId: uuid,
    counterId: uuid.nullable(),
    deviceId: uuid,
    label: z.string().nullable(),
    customerId: uuid.nullable(),
    customerName: z.string().nullable(),
    lineCount: z.number().int(),
    estimatedTotal: paise,
    payload: z.record(z.unknown()).openapi({
      description:
        'The device’s draft, stored verbatim. The server never interprets it: a parked bill is not a document.',
    }),
    status: z.enum(['held', 'released', 'discarded']),
    invoiceId: uuid.nullable(),
    heldAt: timestamp,
    heldBy: uuid,
    releasedAt: timestamp.nullable(),
  }),
);

export const expenseCategorySchema = registry.register(
  'ExpenseCategory',
  z.object({
    id: uuid,
    name: z.string(),
    isDirect: z.boolean().openapi({
      description: 'Direct costs sit above the gross-margin line in the daily P&L.',
    }),
    isActive: z.boolean(),
  }),
);

export const expenseSchema = registry.register(
  'Expense',
  z.object({
    id: uuid,
    outletId: uuid,
    categoryId: uuid.nullable(),
    categoryName: z.string().nullable(),
    amount: paise,
    mode: tenderModeSchema,
    vendorName: z.string().nullable(),
    reference: z.string().nullable(),
    note: z.string().nullable(),
    receiptObjectKey: z.string().nullable(),
    spentAt: timestamp,
    spentBy: uuid,
    status: documentStatusSchema,
    voidReason: z.string().nullable(),
    voidedAt: timestamp.nullable(),
  }),
);

export const dayCloseSchema = registry.register(
  'DayClose',
  z.object({
    id: uuid,
    outletId: uuid,
    counterId: uuid.nullable(),
    businessDate: calendarDate,
    openedAt: timestamp,
    closedAt: timestamp,
    openingFloat: paise,
    expectedCash: paise,
    countedCash: paise,
    cashVariance: paise.openapi({
      description: 'counted − expected. Negative is short, positive is over.',
    }),
    tenderBreakdown: z.record(z.object({ expected: paise, counted: paise.nullable() })),
    salesTotal: paise,
    cashSales: paise,
    cashReceipts: paise,
    cashRefunds: paise,
    cashExpenses: paise,
    invoiceCount: z.number().int(),
    closingFloat: paise,
    note: z.string().nullable(),
    closedBy: uuid,
  }),
);

export const dayCloseExpectationSchema = registry.register(
  'DayCloseExpectation',
  z.object({
    outletId: uuid,
    counterId: uuid.nullable(),
    businessDate: calendarDate,
    openedAt: timestamp,
    asOf: timestamp,
    openingFloat: paise,
    expectedCash: paise,
    salesTotal: paise,
    invoiceCount: z.number().int(),
    cashSales: paise,
    cashReceipts: paise,
    cashRefunds: paise,
    cashExpenses: paise,
    byMode: z.record(paise),
    alreadyClosed: z.boolean(),
  }),
);

// --- Held bills -------------------------------------------------------------

registry.registerPath({
  method: 'get',
  path: '/v1/held-bills',
  tags: ['Operations'],
  summary: 'Bills parked at a counter',
  security: accessTokenSecurity,
  request: { query: listHeldBillsQuery },
  responses: {
    200: jsonResponse('Held bills, newest first.', dataEnvelope(z.array(heldBillSchema))),
    ...errorResponses(),
  },
});
registry.registerPath({
  method: 'get',
  path: '/v1/held-bills/{id}',
  tags: ['Operations'],
  summary: 'Get a parked bill',
  security: accessTokenSecurity,
  request: { params: idParams },
  responses: {
    200: jsonResponse('Held bill.', dataEnvelope(heldBillSchema)),
    ...errorResponses(),
  },
});
registry.registerPath({
  method: 'put',
  path: '/v1/held-bills',
  tags: ['Operations'],
  summary: 'Park a bill, or update one already parked',
  description:
    'Idempotent on the draft id, which stays the same while the cashier keeps adding lines. Capped per counter.',
  security: accessTokenSecurity,
  request: { body: body(upsertHeldBillBody) },
  responses: {
    200: jsonResponse('Parked.', dataEnvelope(heldBillSchema)),
    ...errorResponses(409, 422),
  },
});
registry.registerPath({
  method: 'post',
  path: '/v1/held-bills/{id}/release',
  tags: ['Operations'],
  summary: 'Take a bill off hold',
  description:
    'Idempotent: a device that billed the draft and lost the response may send this again, and a bill released on another device answers the same way.',
  security: accessTokenSecurity,
  request: { params: idParams, body: body(releaseHeldBillBody) },
  responses: {
    200: jsonResponse('Released.', dataEnvelope(z.object({ released: z.boolean() }))),
    ...errorResponses(),
  },
});

// --- Expenses ---------------------------------------------------------------

registry.registerPath({
  method: 'get',
  path: '/v1/expenses/categories',
  tags: ['Operations'],
  summary: 'List expense categories',
  security: accessTokenSecurity,
  responses: {
    200: jsonResponse('Categories.', dataEnvelope(z.array(expenseCategorySchema))),
    ...errorResponses(),
  },
});
registry.registerPath({
  method: 'post',
  path: '/v1/expenses/categories',
  tags: ['Operations'],
  summary: 'Create an expense category',
  security: accessTokenSecurity,
  request: { body: body(createExpenseCategoryBody) },
  responses: {
    201: jsonResponse('Created.', dataEnvelope(expenseCategorySchema)),
    ...errorResponses(409),
  },
});
registry.registerPath({
  method: 'patch',
  path: '/v1/expenses/categories/{id}',
  tags: ['Operations'],
  summary: 'Update an expense category',
  security: accessTokenSecurity,
  request: { params: idParams, body: body(updateExpenseCategoryBody) },
  responses: {
    200: jsonResponse('Updated.', dataEnvelope(expenseCategorySchema)),
    ...errorResponses(409),
  },
});
registry.registerPath({
  method: 'delete',
  path: '/v1/expenses/categories/{id}',
  tags: ['Operations'],
  summary: 'Delete an unused expense category',
  security: accessTokenSecurity,
  request: { params: idParams },
  responses: { 204: noContent('Deleted.'), ...errorResponses(422) },
});

registry.registerPath({
  method: 'get',
  path: '/v1/expenses',
  tags: ['Operations'],
  summary: 'List expenses',
  security: accessTokenSecurity,
  request: { query: listExpensesQuery },
  responses: {
    200: jsonResponse('Expenses, newest first.', pageEnvelope(expenseSchema)),
    ...errorResponses(),
  },
});
registry.registerPath({
  method: 'get',
  path: '/v1/expenses/{id}',
  tags: ['Operations'],
  summary: 'Get an expense',
  security: accessTokenSecurity,
  request: { params: idParams },
  responses: {
    200: jsonResponse('Expense.', dataEnvelope(expenseSchema)),
    ...errorResponses(),
  },
});
registry.registerPath({
  method: 'post',
  path: '/v1/expenses',
  tags: ['Operations'],
  summary: 'Record an expense',
  description:
    'Cash expenses leave the drawer and therefore reduce the day-close expectation. `receiptObjectKey` comes from the uploads endpoint, never a URL.',
  security: accessTokenSecurity,
  request: { body: body(createExpenseBody) },
  responses: {
    201: jsonResponse('Recorded.', z.object({ data: expenseSchema, replayed: z.boolean() })),
    200: jsonResponse(
      'Already recorded earlier (replay).',
      z.object({ data: expenseSchema, replayed: z.boolean() }),
    ),
    ...errorResponses(),
  },
});
registry.registerPath({
  method: 'post',
  path: '/v1/expenses/{id}/void',
  tags: ['Operations'],
  summary: 'Void an expense',
  description: 'Expenses are immutable; a correction is a void and a fresh entry.',
  security: accessTokenSecurity,
  request: { params: idParams, body: body(voidExpenseBody) },
  responses: {
    200: jsonResponse('Voided.', dataEnvelope(expenseSchema)),
    ...errorResponses(409),
  },
});

// --- Day close --------------------------------------------------------------

registry.registerPath({
  method: 'get',
  path: '/v1/day-close/expected',
  tags: ['Operations'],
  summary: 'What the drawer should hold right now',
  description:
    'Opening float + cash tenders + cash receipts − cash refunds − cash expenses, over the window since the last close. Read this immediately before counting: it moves with every sale.',
  security: accessTokenSecurity,
  request: { query: dayCloseExpectedQuery },
  responses: {
    200: jsonResponse('Expectation.', dataEnvelope(dayCloseExpectationSchema)),
    ...errorResponses(),
  },
});
registry.registerPath({
  method: 'get',
  path: '/v1/day-close',
  tags: ['Operations'],
  summary: 'List cash-ups',
  security: accessTokenSecurity,
  request: { query: listDayClosesQuery },
  responses: {
    200: jsonResponse('Cash-ups, newest first.', pageEnvelope(dayCloseSchema)),
    ...errorResponses(),
  },
});
registry.registerPath({
  method: 'get',
  path: '/v1/day-close/{id}',
  tags: ['Operations'],
  summary: 'Get a cash-up',
  security: accessTokenSecurity,
  request: { params: idParams },
  responses: {
    200: jsonResponse('Cash-up.', dataEnvelope(dayCloseSchema)),
    ...errorResponses(),
  },
});
registry.registerPath({
  method: 'post',
  path: '/v1/day-close',
  tags: ['Operations'],
  summary: 'Close the day',
  description:
    'Stores what was expected as well as what was counted, so the cash-up still reads correctly after a later void changes the arithmetic. A variance beyond the configured tolerance comes back as a `CASH_VARIANCE_EXCEEDED` warning, never a rejection — the money is already whatever it is.',
  security: accessTokenSecurity,
  request: { body: body(createDayCloseBody) },
  responses: {
    201: jsonResponse(
      'Closed.',
      z.object({
        data: dayCloseSchema,
        warnings: z.array(warningSchema),
        replayed: z.boolean(),
      }),
    ),
    ...errorResponses(409),
  },
});
