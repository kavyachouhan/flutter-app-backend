import { z } from 'zod';
import { errorResponses } from '../../openapi/common.js';
import {
  accessTokenSecurity,
  calendarDate,
  dataEnvelope,
  jsonResponse,
  pageEnvelope,
  paise,
  quantity,
  registry,
  timestamp,
  uuid,
} from '../../openapi/registry.js';
import {
  BREACH_KINDS,
  createPriceListBody,
  createPriceRevisionBody,
  listDiscountApprovalsQuery,
  listPriceListsQuery,
  listPriceRevisionsQuery,
  listRevisionRowsQuery,
  PRICE_LIST_BASES,
  PRICE_LIST_KINDS,
  putDiscountPolicyBody,
  putPriceListItemsBody,
  resolvePriceQuery,
  REVISION_OPERATIONS,
  updatePriceListBody,
} from './price-lists.schemas.js';

const priceList = registry.register(
  'PriceList',
  z.object({
    id: uuid,
    name: z.string(),
    kind: z.enum(PRICE_LIST_KINDS),
    basis: z.enum(PRICE_LIST_BASES),
    basisValue: z.string(),
    minPriceFloor: paise.nullable(),
    isDefault: z.boolean(),
    effectiveFrom: calendarDate.nullable(),
    effectiveTo: calendarDate.nullable(),
    isActive: z.boolean(),
    createdAt: timestamp,
    updatedAt: timestamp,
  }),
);

const priceListItem = registry.register(
  'PriceListItem',
  z.object({
    priceListId: uuid,
    itemId: uuid,
    itemName: z.string(),
    minQuantity: quantity,
    unitPrice: paise,
    pricesIncludeTax: z.boolean(),
  }),
);

const resolvedPrice = registry.register(
  'ResolvedPrice',
  z.object({
    unitPrice: paise,
    pricesIncludeTax: z.boolean(),
    source: z.enum(['price_list_item', 'price_list_rule', 'item']).openapi({
      description:
        'Which rule produced the price, so a device can reproduce the same answer offline instead of asking again.',
    }),
    priceListId: uuid.optional(),
    flooredToMinimum: z.boolean(),
  }),
);

const discountPolicy = registry.register(
  'DiscountPolicy',
  z.object({
    id: uuid,
    outletId: uuid.nullable().openapi({
      description: 'Null is the business-wide policy that outlet rows inherit from.',
    }),
    maxLineDiscountPercent: z.string().nullable(),
    maxBillDiscountPercent: z.string().nullable(),
    maxDiscountAmount: paise.nullable(),
    minMarginPercent: z.string().nullable(),
    requireApprovalAbovePercent: z.string().nullable(),
    approverPermission: z.string(),
    createdAt: timestamp,
    updatedAt: timestamp,
  }),
);

const discountApproval = registry.register(
  'DiscountApproval',
  z.object({
    id: uuid,
    outletId: uuid,
    invoiceId: uuid.nullable(),
    invoiceLineId: uuid.nullable(),
    breachKind: z.enum(BREACH_KINDS),
    requestedValue: z.string(),
    allowedValue: z.string(),
    requestedBy: uuid,
    approvedBy: uuid,
    approverRole: z.string().openapi({
      description:
        'The role the approver held at the time. Memberships change, and whether this person could approve it then has to stay answerable.',
    }),
    reason: z.string().nullable(),
    approvedAt: timestamp,
    createdAt: timestamp,
  }),
);

const revisionProgress = registry.register(
  'PriceRevision',
  z.object({
    id: uuid,
    target: z.enum(['item_sale_price', 'price_list']),
    priceListId: uuid.nullable(),
    operation: z.enum(REVISION_OPERATIONS),
    operationValue: z.number(),
    status: z.enum([
      'pending',
      'analysing',
      'analysed',
      'applying',
      'applied',
      'failed',
      'cancelled',
    ]),
    totalRows: z.number().int(),
    analysedUpToRow: z.number().int(),
    appliedUpToRow: z.number().int(),
    changeCount: z.number().int(),
    skipCount: z.number().int(),
    errorCount: z.number().int(),
    errorSummary: z.record(z.unknown()).nullable(),
    effectiveFrom: calendarDate.nullable(),
    analysedAt: timestamp.nullable(),
    appliedAt: timestamp.nullable(),
    done: z.boolean().openapi({ description: 'True when the client can stop calling.' }),
  }),
);

const revisionRow = registry.register(
  'PriceRevisionRow',
  z.object({
    id: uuid,
    rowNo: z.number().int(),
    itemId: uuid,
    itemName: z.string(),
    minQuantity: quantity,
    action: z.enum(['pending', 'change', 'skip', 'error']),
    oldPrice: paise.nullable(),
    newPrice: paise.nullable(),
    reason: z.string().nullable(),
    appliedAt: timestamp.nullable(),
  }),
);

// --- Price lists -----------------------------------------------------------

registry.registerPath({
  method: 'get',
  path: '/v1/price-lists',
  tags: ['Pricing'],
  summary: 'Price lists',
  security: accessTokenSecurity,
  request: { query: listPriceListsQuery },
  responses: { 200: jsonResponse('By name.', pageEnvelope(priceList)), ...errorResponses() },
});

registry.registerPath({
  method: 'post',
  path: '/v1/price-lists',
  tags: ['Pricing'],
  summary: 'Create a price list',
  description: [
    'A list is a set of *overrides*, not a whitelist. An item the list holds no price for falls',
    'through to the list’s basis and then to the item’s own selling price, so a wholesale customer',
    'buying something nobody has priced for wholesale is still billable.',
    '',
    'A `fixed` basis means only the explicit per-item prices apply. `percent_off_sale` discounts',
    'the item’s selling price; `percent_on_cost` marks up its moving-average cost, which keeps',
    'margin intact as buying prices move — set `minPriceFloor` with it, because a cost-plus list',
    'with a stale cost is how a shop sells below what it paid without noticing.',
  ].join('\n'),
  security: accessTokenSecurity,
  request: { body: { content: { 'application/json': { schema: createPriceListBody } } } },
  responses: {
    201: jsonResponse('Created.', dataEnvelope(priceList)),
    200: jsonResponse('Already created; the stored list is returned.', dataEnvelope(priceList)),
    ...errorResponses(422),
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/price-lists/resolve',
  tags: ['Pricing'],
  summary: 'What this customer pays for this item',
  description: [
    'The authoritative price for one item, for one customer, at one quantity. A till warms its',
    'cache from this and then prices offline with the same pure resolver the server runs, which',
    'is why the answer carries `source` and `priceListId` as well as the number.',
    '',
    'Resolution order is most specific first: an explicit entry on the customer’s list (taking the',
    'highest quantity break at or below what is being sold), then the list’s own rule, then the',
    'item’s selling price. A list outside its effective window prices nothing and falls through,',
    'rather than charging a rate that has expired.',
  ].join('\n'),
  security: accessTokenSecurity,
  request: { query: resolvePriceQuery },
  responses: {
    200: jsonResponse('The price and why.', dataEnvelope(resolvedPrice)),
    ...errorResponses(),
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/price-lists/{id}',
  tags: ['Pricing'],
  summary: 'One price list',
  security: accessTokenSecurity,
  request: { params: z.object({ id: uuid }) },
  responses: { 200: jsonResponse('List.', dataEnvelope(priceList)), ...errorResponses() },
});

registry.registerPath({
  method: 'patch',
  path: '/v1/price-lists/{id}',
  tags: ['Pricing'],
  summary: 'Update a price list',
  security: accessTokenSecurity,
  request: {
    params: z.object({ id: uuid }),
    body: { content: { 'application/json': { schema: updatePriceListBody } } },
  },
  responses: { 200: jsonResponse('Updated.', dataEnvelope(priceList)), ...errorResponses(422) },
});

registry.registerPath({
  method: 'delete',
  path: '/v1/price-lists/{id}',
  tags: ['Pricing'],
  summary: 'Delete a price list',
  description:
    'Refused while customers are priced on it: deleting it would silently reprice them to the item price, which is a margin change nobody asked for. Move them to another list first.',
  security: accessTokenSecurity,
  request: { params: z.object({ id: uuid }) },
  responses: { 204: { description: 'Deleted.' }, ...errorResponses(409) },
});

registry.registerPath({
  method: 'get',
  path: '/v1/price-lists/{id}/items',
  tags: ['Pricing'],
  summary: 'Prices on a list',
  security: accessTokenSecurity,
  request: { params: z.object({ id: uuid }) },
  responses: {
    200: jsonResponse('By item name.', pageEnvelope(priceListItem)),
    ...errorResponses(),
  },
});

registry.registerPath({
  method: 'put',
  path: '/v1/price-lists/{id}/items',
  tags: ['Pricing'],
  summary: 'Set prices on a list',
  description: [
    'Upserts a batch of prices. `replace: true` clears the list first; otherwise these merge in.',
    '',
    'Several rows for one item form a quantity-break ladder: each applies from its `minQuantity`',
    'up, and the resolver takes the highest break at or below what is being sold.',
    '',
    'Capped at 1000 rows, because this is the interactive path. Repricing a larger catalogue is a',
    'revision job, which previews what it will do before it writes anything.',
  ].join('\n'),
  security: accessTokenSecurity,
  request: {
    params: z.object({ id: uuid }),
    body: { content: { 'application/json': { schema: putPriceListItemsBody } } },
  },
  responses: {
    200: jsonResponse(
      'How many prices were written.',
      dataEnvelope(
        z.object({ priceListId: uuid, count: z.number().int(), replaced: z.boolean() }),
      ),
    ),
    ...errorResponses(422),
  },
});

registry.registerPath({
  method: 'delete',
  path: '/v1/price-lists/{id}/items/{itemId}',
  tags: ['Pricing'],
  summary: 'Remove an item from a list',
  security: accessTokenSecurity,
  request: { params: z.object({ id: uuid, itemId: uuid }) },
  responses: { 204: { description: 'Removed.' }, ...errorResponses() },
});

// --- Discount policy -------------------------------------------------------

registry.registerPath({
  method: 'get',
  path: '/v1/discount-policies',
  tags: ['Pricing'],
  summary: 'Discount caps',
  description:
    'The business-wide row (`outletId: null`) and any outlet overrides. An outlet inherits field by field, so a branch can override one number without restating the policy.',
  security: accessTokenSecurity,
  responses: {
    200: jsonResponse('Policies.', dataEnvelope(z.array(discountPolicy))),
    ...errorResponses(),
  },
});

registry.registerPath({
  method: 'put',
  path: '/v1/discount-policies',
  tags: ['Pricing'],
  summary: 'Set discount caps',
  description: [
    'Sets the business-wide policy, or one outlet’s override when `outletId` is given.',
    '',
    'Every limit is nullable and **null means no limit, not zero** — a cap of zero is a shop that',
    'forbids discounts outright, which is a different and legitimate setting.',
    '',
    'The caps are enforced at the till, which holds this policy and the same pure cap check the',
    'server runs. The server re-runs it on upload and reports a breach as a',
    '`DISCOUNT_CAP_EXCEEDED` warning on a successful write: an offline sale has already happened,',
    'so rejecting it would strand a completed transaction. `minMarginPercent` is the one limit',
    'that catches a discount inside every percentage cap that still loses money.',
  ].join('\n'),
  security: accessTokenSecurity,
  request: { body: { content: { 'application/json': { schema: putDiscountPolicyBody } } } },
  responses: { 200: jsonResponse('Saved.', dataEnvelope(discountPolicy)), ...errorResponses(422) },
});

registry.registerPath({
  method: 'get',
  path: '/v1/discount-approvals',
  tags: ['Pricing'],
  summary: 'Who approved which discount',
  description: [
    'The margin-giveaway trail, newest first.',
    '',
    'Read-only by design. An approval is created as part of the invoice that carries the discount,',
    'never posted on its own, so the authority and the discount it authorises can never be',
    'committed apart and an offline sale uploads its evidence with it. The table is append-only.',
  ].join('\n'),
  security: accessTokenSecurity,
  request: { query: listDiscountApprovalsQuery },
  responses: {
    200: jsonResponse('Newest first.', pageEnvelope(discountApproval)),
    ...errorResponses(),
  },
});

// --- Bulk price revision ---------------------------------------------------

registry.registerPath({
  method: 'get',
  path: '/v1/price-revisions',
  tags: ['Pricing'],
  summary: 'Price revisions',
  security: accessTokenSecurity,
  request: { query: listPriceRevisionsQuery },
  responses: {
    200: jsonResponse('Newest first.', pageEnvelope(revisionProgress)),
    ...errorResponses(),
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/price-revisions',
  tags: ['Pricing'],
  summary: 'Start a bulk price revision',
  description: [
    'Raise a category 7%, reprice a wholesale list from cost, round everything to the rupee.',
    '',
    'Creating a revision writes nothing. The client then calls `analyse` repeatedly to build a',
    'preview — every row with its old and new price, and a reason for each one that will not',
    'change — and only then calls `apply`. The preview exists because a price change is not',
    'reversible by reading the result: once the price has moved, what it was is gone.',
    '',
    '`roundToPaise` rounds each new price to a multiple, so a 7% rise does not leave the shelf at',
    '₹10.73. `set_from_cost` skips any item with no average cost rather than pricing it at zero.',
  ].join('\n'),
  security: accessTokenSecurity,
  request: { body: { content: { 'application/json': { schema: createPriceRevisionBody } } } },
  responses: {
    201: jsonResponse('Created.', dataEnvelope(revisionProgress)),
    200: jsonResponse('Already created.', dataEnvelope(revisionProgress)),
    ...errorResponses(422),
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/price-revisions/{id}',
  tags: ['Pricing'],
  summary: 'Revision progress',
  security: accessTokenSecurity,
  request: { params: z.object({ id: uuid }) },
  responses: {
    200: jsonResponse('Progress.', dataEnvelope(revisionProgress)),
    ...errorResponses(),
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/price-revisions/{id}/rows',
  tags: ['Pricing'],
  summary: 'The preview',
  description:
    'What each row will become, and why some will not change. Filter by `action` to review only the errors.',
  security: accessTokenSecurity,
  request: { params: z.object({ id: uuid }), query: listRevisionRowsQuery },
  responses: {
    200: jsonResponse('In row order.', pageEnvelope(revisionRow)),
    ...errorResponses(),
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/price-revisions/{id}/analyse',
  tags: ['Pricing'],
  summary: 'Price one chunk and preview it',
  description:
    'Call until `done`. Each call takes a row lock on the job, so two tabs cannot claim the same slice. Re-analysing from `pending` clears the previous preview, but never a row already applied.',
  security: accessTokenSecurity,
  request: { params: z.object({ id: uuid }) },
  responses: {
    200: jsonResponse('Progress.', dataEnvelope(revisionProgress)),
    ...errorResponses(409),
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/price-revisions/{id}/apply',
  tags: ['Pricing'],
  summary: 'Write one chunk of the new prices',
  description: [
    'Call until `done`. Each row carries its own `appliedAt`, so a resumed apply writes each price',
    'exactly once even if a chunk committed just before the client gave up waiting.',
    '',
    'Refused with 409 when the catalogue has moved since the preview: a revision analysed this',
    'morning must not quietly reprice items added since, or apply a percentage to a price somebody',
    'has already changed by hand. Re-run the preview.',
  ].join('\n'),
  security: accessTokenSecurity,
  request: { params: z.object({ id: uuid }) },
  responses: {
    200: jsonResponse('Progress.', dataEnvelope(revisionProgress)),
    ...errorResponses(409),
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/price-revisions/{id}/cancel',
  tags: ['Pricing'],
  summary: 'Cancel a revision',
  description:
    'Only before anything is written. Half-applied prices cannot be rolled back by cancelling — the old prices live only in the preview, and restoring them is a new revision.',
  security: accessTokenSecurity,
  request: { params: z.object({ id: uuid }) },
  responses: { 204: { description: 'Cancelled.' }, ...errorResponses(409) },
});
