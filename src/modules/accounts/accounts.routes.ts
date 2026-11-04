import { Router } from 'express';
import { idParams } from '../../lib/validators.js';
import { requirePermission } from '../../middleware/authorize.js';
import { validate, validated } from '../../middleware/validate.js';
import * as accountsService from './accounts.service.js';
import {
  adjustCashBody,
  createBankAccountBody,
  listChequesQuery,
  listTransactionsQuery,
  transferBody,
  updateAccountBody,
} from './accounts.schemas.js';

export const accountsRouter: Router = Router();

accountsRouter.get('/', requirePermission('accounts:read'), async (_req, res) => {
  res.json({ data: await accountsService.listAccounts() });
});

const create = { body: createBankAccountBody };
accountsRouter.post(
  '/',
  requirePermission('accounts:write'),
  validate(create),
  async (req, res) => {
    const { body } = validated<typeof create>(req);
    res.status(201).json({ data: await accountsService.createBankAccount(body) });
  },
);

const cheques = { query: listChequesQuery };
accountsRouter.get(
  '/cheques',
  requirePermission('accounts:read'),
  validate(cheques),
  async (req, res) => {
    const { query } = validated<typeof cheques>(req);
    res.json(await accountsService.listCheques(query));
  },
);

const adjustCash = { body: adjustCashBody };
accountsRouter.post(
  '/cash/adjust',
  requirePermission('accounts:write'),
  validate(adjustCash),
  async (req, res) => {
    const { body } = validated<typeof adjustCash>(req);
    res.status(201).json({ data: await accountsService.adjustCash(body) });
  },
);

const transfer = { body: transferBody };
accountsRouter.post(
  '/transfer',
  requirePermission('accounts:write'),
  validate(transfer),
  async (req, res) => {
    const { body } = validated<typeof transfer>(req);
    res.status(201).json({ data: await accountsService.transfer(body) });
  },
);

const byId = { params: idParams };
accountsRouter.get(
  '/:id',
  requirePermission('accounts:read'),
  validate(byId),
  async (req, res) => {
    const { params } = validated<typeof byId>(req);
    res.json({ data: await accountsService.getAccount(params.id) });
  },
);

const update = { params: idParams, body: updateAccountBody };
accountsRouter.patch(
  '/:id',
  requirePermission('accounts:write'),
  validate(update),
  async (req, res) => {
    const { params, body } = validated<typeof update>(req);
    res.json({ data: await accountsService.updateAccount(params.id, body) });
  },
);

const transactions = { params: idParams, query: listTransactionsQuery };
accountsRouter.get(
  '/:id/transactions',
  requirePermission('accounts:read'),
  validate(transactions),
  async (req, res) => {
    const { params, query } = validated<typeof transactions>(req);
    res.json(await accountsService.listTransactions(params.id, query));
  },
);
