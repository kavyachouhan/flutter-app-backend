import { Router } from 'express';
import { idParams } from '../../lib/validators.js';
import { requirePermission } from '../../middleware/authorize.js';
import { validate, validated } from '../../middleware/validate.js';
import * as service from './operations.service.js';
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

// --- Held bills -------------------------------------------------------------
// Parking a bill is part of billing, so it rides on the billing permissions
// rather than introducing a pair only this screen would use.

export const heldBillsRouter: Router = Router();

const listHeld = { query: listHeldBillsQuery };
heldBillsRouter.get(
  '/',
  requirePermission('invoices:read'),
  validate(listHeld),
  async (req, res) => {
    const { query } = validated<typeof listHeld>(req);
    res.json({ data: await service.listHeldBills(query) });
  },
);

const byId = { params: idParams };
heldBillsRouter.get(
  '/:id',
  requirePermission('invoices:read'),
  validate(byId),
  async (req, res) => {
    const { params } = validated<typeof byId>(req);
    res.json({ data: await service.getHeldBill(params.id) });
  },
);

const upsert = { body: upsertHeldBillBody };
heldBillsRouter.put(
  '/',
  requirePermission('invoices:create'),
  validate(upsert),
  async (req, res) => {
    const { body } = validated<typeof upsert>(req);
    res.json({ data: await service.upsertHeldBill(body) });
  },
);

const release = { params: idParams, body: releaseHeldBillBody };
heldBillsRouter.post(
  '/:id/release',
  requirePermission('invoices:create'),
  validate(release),
  async (req, res) => {
    const { params, body } = validated<typeof release>(req);
    res.json({ data: await service.releaseHeldBill(params.id, body) });
  },
);

// --- Expenses ---------------------------------------------------------------

export const expensesRouter: Router = Router();

expensesRouter.get('/categories', requirePermission('expenses:read'), async (_req, res) => {
  res.json({ data: await service.listExpenseCategories() });
});

const createCategory = { body: createExpenseCategoryBody };
expensesRouter.post(
  '/categories',
  requirePermission('expenses:write'),
  validate(createCategory),
  async (req, res) => {
    const { body } = validated<typeof createCategory>(req);
    res.status(201).json({ data: await service.createExpenseCategory(body) });
  },
);

const updateCategory = { params: idParams, body: updateExpenseCategoryBody };
expensesRouter.patch(
  '/categories/:id',
  requirePermission('expenses:write'),
  validate(updateCategory),
  async (req, res) => {
    const { params, body } = validated<typeof updateCategory>(req);
    res.json({ data: await service.updateExpenseCategory(params.id, body) });
  },
);

expensesRouter.delete(
  '/categories/:id',
  requirePermission('expenses:write'),
  validate(byId),
  async (req, res) => {
    const { params } = validated<typeof byId>(req);
    await service.deleteExpenseCategory(params.id);
    res.status(204).end();
  },
);

const listExpense = { query: listExpensesQuery };
expensesRouter.get(
  '/',
  requirePermission('expenses:read'),
  validate(listExpense),
  async (req, res) => {
    const { query } = validated<typeof listExpense>(req);
    res.json(await service.listExpenses(query));
  },
);

expensesRouter.get('/:id', requirePermission('expenses:read'), validate(byId), async (req, res) => {
  const { params } = validated<typeof byId>(req);
  res.json({ data: await service.getExpense(params.id) });
});

const createExpense = { body: createExpenseBody };
expensesRouter.post(
  '/',
  requirePermission('expenses:write'),
  validate(createExpense),
  async (req, res) => {
    const { body } = validated<typeof createExpense>(req);
    const { expense, replayed } = await service.createExpense(body);
    res.status(replayed ? 200 : 201).json({ data: expense, replayed });
  },
);

const voidExpense = { params: idParams, body: voidExpenseBody };
expensesRouter.post(
  '/:id/void',
  requirePermission('expenses:void'),
  validate(voidExpense),
  async (req, res) => {
    const { params, body } = validated<typeof voidExpense>(req);
    res.json({ data: await service.voidExpense(params.id, body.reason) });
  },
);

// --- Day close --------------------------------------------------------------

export const dayCloseRouter: Router = Router();

const expected = { query: dayCloseExpectedQuery };
dayCloseRouter.get(
  '/expected',
  requirePermission('day_close:read'),
  validate(expected),
  async (req, res) => {
    const { query } = validated<typeof expected>(req);
    res.json({ data: await service.getDayCloseExpectation(query) });
  },
);

const listCloses = { query: listDayClosesQuery };
dayCloseRouter.get(
  '/',
  requirePermission('day_close:read'),
  validate(listCloses),
  async (req, res) => {
    const { query } = validated<typeof listCloses>(req);
    res.json(await service.listDayCloses(query));
  },
);

dayCloseRouter.get(
  '/:id',
  requirePermission('day_close:read'),
  validate(byId),
  async (req, res) => {
    const { params } = validated<typeof byId>(req);
    res.json({ data: await service.getDayClose(params.id) });
  },
);

const createClose = { body: createDayCloseBody };
dayCloseRouter.post(
  '/',
  requirePermission('day_close:create'),
  validate(createClose),
  async (req, res) => {
    const { body } = validated<typeof createClose>(req);
    const { dayClose, warnings, replayed } = await service.createDayClose(body);
    res.status(replayed ? 200 : 201).json({ data: dayClose, warnings, replayed });
  },
);
