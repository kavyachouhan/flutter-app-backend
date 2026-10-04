import { Router } from 'express';
import { z } from 'zod';
import { pageQuery } from '../../lib/pagination.js';
import { idParams } from '../../lib/validators.js';
import { requirePermission } from '../../middleware/authorize.js';
import { validate, validated } from '../../middleware/validate.js';
import * as revisions from './revisions.service.js';
import * as service from './price-lists.service.js';
import {
  createPriceListBody,
  createPriceRevisionBody,
  listDiscountApprovalsQuery,
  listPriceListsQuery,
  listPriceRevisionsQuery,
  listRevisionRowsQuery,
  putDiscountPolicyBody,
  putPriceListItemsBody,
  resolvePriceQuery,
  updatePriceListBody,
} from './price-lists.schemas.js';

export const priceListsRouter: Router = Router();

const list = { query: listPriceListsQuery };
priceListsRouter.get(
  '/',
  requirePermission('price_lists:read'),
  validate(list),
  async (req, res) => {
    const { query } = validated<typeof list>(req);
    res.json(await service.listPriceLists(query));
  },
);

/**
 * Registered before `/:id` so the literal path wins, as with
 * `/items/by-barcode`.
 *
 * Only `catalogue:read` rather than `price_lists:read`: a cashier has to be
 * able to price what they are selling, which is the whole point, while still
 * having no way to see or change the lists themselves.
 */
const resolve = { query: resolvePriceQuery };
priceListsRouter.get(
  '/resolve',
  requirePermission('catalogue:read'),
  validate(resolve),
  async (req, res) => {
    const { query } = validated<typeof resolve>(req);
    res.json({ data: await service.resolveItemPrice(query) });
  },
);

const create = { body: createPriceListBody };
priceListsRouter.post(
  '/',
  requirePermission('price_lists:write'),
  validate(create),
  async (req, res) => {
    const { body } = validated<typeof create>(req);
    res.status(201).json({ data: await service.createPriceList(body) });
  },
);

const byId = { params: idParams };
priceListsRouter.get(
  '/:id',
  requirePermission('price_lists:read'),
  validate(byId),
  async (req, res) => {
    const { params } = validated<typeof byId>(req);
    res.json({ data: await service.getPriceList(params.id) });
  },
);

const update = { params: idParams, body: updatePriceListBody };
priceListsRouter.patch(
  '/:id',
  requirePermission('price_lists:write'),
  validate(update),
  async (req, res) => {
    const { params, body } = validated<typeof update>(req);
    res.json({ data: await service.updatePriceList(params.id, body) });
  },
);

priceListsRouter.delete(
  '/:id',
  requirePermission('price_lists:write'),
  validate(byId),
  async (req, res) => {
    const { params } = validated<typeof byId>(req);
    await service.deletePriceList(params.id);
    res.status(204).end();
  },
);

const items = { params: idParams, query: pageQuery };
priceListsRouter.get(
  '/:id/items',
  requirePermission('price_lists:read'),
  validate(items),
  async (req, res) => {
    const { params, query } = validated<typeof items>(req);
    res.json(await service.listPriceListItems(params.id, query));
  },
);

const putItems = { params: idParams, body: putPriceListItemsBody };
priceListsRouter.put(
  '/:id/items',
  requirePermission('price_lists:write'),
  validate(putItems),
  async (req, res) => {
    const { params, body } = validated<typeof putItems>(req);
    res.json({ data: await service.putPriceListItems(params.id, body) });
  },
);

const itemParams = {
  params: z.object({ id: z.string().uuid(), itemId: z.string().uuid() }),
};
priceListsRouter.delete(
  '/:id/items/:itemId',
  requirePermission('price_lists:write'),
  validate(itemParams),
  async (req, res) => {
    const { params } = validated<typeof itemParams>(req);
    await service.deletePriceListItem(params.id, params.itemId);
    res.status(204).end();
  },
);

// --- Discount policy -------------------------------------------------------

export const discountPoliciesRouter: Router = Router();

discountPoliciesRouter.get('/', requirePermission('discount_policies:read'), async (_req, res) => {
  res.json({ data: await service.getDiscountPolicies() });
});

const putPolicy = { body: putDiscountPolicyBody };
discountPoliciesRouter.put(
  '/',
  requirePermission('discount_policies:manage'),
  validate(putPolicy),
  async (req, res) => {
    const { body } = validated<typeof putPolicy>(req);
    res.json({ data: await service.putDiscountPolicy(body) });
  },
);

/**
 * Read-only. An approval is created as part of the invoice that carries the
 * discount, never on its own, so the authority and the discount commit
 * together — see `discounts.repository.ts`.
 *
 * Gated on `reports:financial` rather than `discount_policies:read`: this is
 * the margin-giveaway trail, which is an owner's report, not a till screen.
 */
export const discountApprovalsRouter: Router = Router();

const listApprovals = { query: listDiscountApprovalsQuery };
discountApprovalsRouter.get(
  '/',
  requirePermission('reports:financial'),
  validate(listApprovals),
  async (req, res) => {
    const { query } = validated<typeof listApprovals>(req);
    res.json(await service.listDiscountApprovals(query));
  },
);

// --- Bulk price revision ---------------------------------------------------

export const priceRevisionsRouter: Router = Router();

const listRevisions = { query: listPriceRevisionsQuery };
priceRevisionsRouter.get(
  '/',
  requirePermission('price_lists:read'),
  validate(listRevisions),
  async (req, res) => {
    const { query } = validated<typeof listRevisions>(req);
    res.json(await revisions.listPriceRevisions(query));
  },
);

const createRevision = { body: createPriceRevisionBody };
priceRevisionsRouter.post(
  '/',
  requirePermission('price_lists:write'),
  validate(createRevision),
  async (req, res) => {
    const { body } = validated<typeof createRevision>(req);
    res.status(201).json({ data: await revisions.createPriceRevision(body) });
  },
);

priceRevisionsRouter.get(
  '/:id',
  requirePermission('price_lists:read'),
  validate(byId),
  async (req, res) => {
    const { params } = validated<typeof byId>(req);
    res.json({ data: await revisions.getPriceRevision(params.id) });
  },
);

const revisionRows = { params: idParams, query: listRevisionRowsQuery };
priceRevisionsRouter.get(
  '/:id/rows',
  requirePermission('price_lists:read'),
  validate(revisionRows),
  async (req, res) => {
    const { params, query } = validated<typeof revisionRows>(req);
    res.json(await revisions.listPriceRevisionRows(params.id, query));
  },
);

/**
 * Analyse and apply are both chunked and both idempotent on their cursor, so
 * the client calls each repeatedly until `done`. Neither returns 201: they
 * advance a job rather than creating anything.
 */
priceRevisionsRouter.post(
  '/:id/analyse',
  requirePermission('price_lists:write'),
  validate(byId),
  async (req, res) => {
    const { params } = validated<typeof byId>(req);
    res.json({ data: await revisions.analysePriceRevision(params.id) });
  },
);

priceRevisionsRouter.post(
  '/:id/apply',
  requirePermission('price_lists:write'),
  validate(byId),
  async (req, res) => {
    const { params } = validated<typeof byId>(req);
    res.json({ data: await revisions.applyPriceRevision(params.id) });
  },
);

priceRevisionsRouter.post(
  '/:id/cancel',
  requirePermission('price_lists:write'),
  validate(byId),
  async (req, res) => {
    const { params } = validated<typeof byId>(req);
    await revisions.cancelPriceRevision(params.id);
    res.status(204).end();
  },
);
