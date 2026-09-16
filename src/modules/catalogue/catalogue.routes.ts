import { Router } from 'express';
import { requirePermission } from '../../middleware/authorize.js';
import { validate, validated } from '../../middleware/validate.js';
import { idParams } from '../../lib/validators.js';
import * as catalogueService from './catalogue.service.js';
import {
  barcodeParams,
  createCategoryBody,
  createItemBody,
  listItemsQuery,
  updateCategoryBody,
  updateItemBody,
} from './catalogue.schemas.js';

export const catalogueRouter: Router = Router();

const byId = { params: idParams };

catalogueRouter.get('/categories', requirePermission('catalogue:read'), async (_req, res) => {
  res.json({ data: await catalogueService.listCategories() });
});

const createCategory = { body: createCategoryBody };
catalogueRouter.post(
  '/categories',
  requirePermission('catalogue:write'),
  validate(createCategory),
  async (req, res) => {
    const { body } = validated<typeof createCategory>(req);
    res.status(201).json({ data: await catalogueService.createCategory(body) });
  },
);

const updateCategory = { params: idParams, body: updateCategoryBody };
catalogueRouter.patch(
  '/categories/:id',
  requirePermission('catalogue:write'),
  validate(updateCategory),
  async (req, res) => {
    const { params, body } = validated<typeof updateCategory>(req);
    res.json({ data: await catalogueService.updateCategory(params.id, body) });
  },
);

catalogueRouter.delete(
  '/categories/:id',
  requirePermission('catalogue:write'),
  validate(byId),
  async (req, res) => {
    const { params } = validated<typeof byId>(req);
    await catalogueService.deleteCategory(params.id);
    res.status(204).end();
  },
);

const listItems = { query: listItemsQuery };
catalogueRouter.get(
  '/items',
  requirePermission('catalogue:read'),
  validate(listItems),
  async (req, res) => {
    const { query } = validated<typeof listItems>(req);
    res.json(await catalogueService.listItems(query));
  },
);

const byBarcode = { params: barcodeParams };
catalogueRouter.get(
  '/items/by-barcode/:barcode',
  requirePermission('catalogue:read'),
  validate(byBarcode),
  async (req, res) => {
    const { params } = validated<typeof byBarcode>(req);
    res.json({ data: await catalogueService.getItemByBarcode(params.barcode) });
  },
);

catalogueRouter.get(
  '/items/:id',
  requirePermission('catalogue:read'),
  validate(byId),
  async (req, res) => {
    const { params } = validated<typeof byId>(req);
    res.json({ data: await catalogueService.getItem(params.id) });
  },
);

const createItem = { body: createItemBody };
catalogueRouter.post(
  '/items',
  requirePermission('catalogue:write'),
  validate(createItem),
  async (req, res) => {
    const { body } = validated<typeof createItem>(req);
    res.status(201).json({ data: await catalogueService.createItem(body) });
  },
);

const updateItem = { params: idParams, body: updateItemBody };
catalogueRouter.patch(
  '/items/:id',
  requirePermission('catalogue:write'),
  validate(updateItem),
  async (req, res) => {
    const { params, body } = validated<typeof updateItem>(req);
    res.json({ data: await catalogueService.updateItem(params.id, body) });
  },
);

catalogueRouter.delete(
  '/items/:id',
  requirePermission('catalogue:write'),
  validate(byId),
  async (req, res) => {
    const { params } = validated<typeof byId>(req);
    await catalogueService.deleteItem(params.id);
    res.status(204).end();
  },
);
