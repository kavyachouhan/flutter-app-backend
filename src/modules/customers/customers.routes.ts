import { Router } from 'express';
import { requirePermission } from '../../middleware/authorize.js';
import { validate, validated } from '../../middleware/validate.js';
import { idParams } from '../../lib/validators.js';
import * as customersService from './customers.service.js';
import {
  createCustomerBody,
  customerAddressParams,
  ledgerQuery,
  listCustomersQuery,
  updateCustomerBody,
  upsertCustomerAddressBody,
} from './customers.schemas.js';

export const customersRouter: Router = Router();

const list = { query: listCustomersQuery };
customersRouter.get('/', requirePermission('customers:read'), validate(list), async (req, res) => {
  const { query } = validated<typeof list>(req);
  res.json(await customersService.listCustomers(query));
});

const byId = { params: idParams };
customersRouter.get(
  '/:id',
  requirePermission('customers:read'),
  validate(byId),
  async (req, res) => {
    const { params } = validated<typeof byId>(req);
    res.json({ data: await customersService.getCustomer(params.id) });
  },
);

const statement = { params: idParams, query: ledgerQuery };
customersRouter.get(
  '/:id/ledger',
  requirePermission('customers:read'),
  validate(statement),
  async (req, res) => {
    const { params, query } = validated<typeof statement>(req);
    res.json(await customersService.getStatement(params.id, query));
  },
);

customersRouter.get(
  '/:id/addresses',
  requirePermission('customers:read'),
  validate(byId),
  async (req, res) => {
    const { params } = validated<typeof byId>(req);
    res.json({ data: await customersService.listCustomerAddresses(params.id) });
  },
);

const putAddress = { params: customerAddressParams, body: upsertCustomerAddressBody };
customersRouter.put(
  '/:id/addresses/:addressId',
  requirePermission('customers:write'),
  validate(putAddress),
  async (req, res) => {
    const { params, body } = validated<typeof putAddress>(req);
    res.json({
      data: await customersService.upsertCustomerAddress({ ...body, id: params.addressId, customerId: params.id }),
    });
  },
);

const addressById = { params: customerAddressParams };
customersRouter.delete(
  '/:id/addresses/:addressId',
  requirePermission('customers:write'),
  validate(addressById),
  async (req, res) => {
    const { params } = validated<typeof addressById>(req);
    await customersService.deleteCustomerAddress(params.id, params.addressId);
    res.status(204).end();
  },
);

const create = { body: createCustomerBody };
customersRouter.post(
  '/',
  requirePermission('customers:write'),
  validate(create),
  async (req, res) => {
    const { body } = validated<typeof create>(req);
    res.status(201).json({ data: await customersService.createCustomer(body) });
  },
);

const update = { params: idParams, body: updateCustomerBody };
customersRouter.patch(
  '/:id',
  requirePermission('customers:write'),
  validate(update),
  async (req, res) => {
    const { params, body } = validated<typeof update>(req);
    res.json({ data: await customersService.updateCustomer(params.id, body) });
  },
);

customersRouter.delete(
  '/:id',
  requirePermission('customers:write'),
  validate(byId),
  async (req, res) => {
    const { params } = validated<typeof byId>(req);
    await customersService.deleteCustomer(params.id);
    res.status(204).end();
  },
);
