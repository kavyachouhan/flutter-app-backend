# Endpoint reference: everything added after the P0 set

79 new endpoints across two passes, plus ten existing ones that changed. Each
entry says **what** it does, **why** it exists, and **how** to use it correctly.

- **Part one (46)** — print payloads, uploads, bulk import, export, barcode
  labels, purchases, suppliers, debit notes.
- **Part two (33)** — price lists, bulk price revision, discount caps, GST
  returns, the ITC register, GSTR-2B reconciliation, plus the ten changed
  endpoints and 26 new reports.

Background and design reasoning: [REMAINING_FEATURES.md](REMAINING_FEATURES.md).
Live schemas: `/v1/docs` (Swagger UI, env-gated) or `GET /v1/openapi.json`.

**Conventions.** Money is integer paise; quantities are integer thousandths
of a unit. Success is `{ data }` or `{ data, nextCursor }`; every error is
`{ error: { code, message, details?, requestId } }` and clients branch on
`code`. Documents and masters take a **client-generated `id`**, so creating
with an id that already exists returns the existing record and offline
retries are safe. A resource in another tenant answers 404, never 403.

---

## Print payloads — tag `Invoices` / `Credit notes` / `Payments`

### `GET /v1/invoices/:id/print-payload`

**What** Returns the invoice as a finished `PrintDocument`: every string
formatted, every total computed, every custom field labelled and ordered.
**Why** So the device never decides what a bill says. The legally required
strings (TAX INVOICE vs BILL OF SUPPLY, the composition declaration) are
decided server-side, where getting them wrong is fixable by deploy rather
than by app-store release.
**How** `?copyIndex=0` picks which GST rule-48 copy this is; `?template=a4_tax`
overrides the counter default for one bill while keeping the tenant's own
flag overrides. The response is safely cacheable on the device — it never
changes for an issued document except for the copy label. Permission
`invoices:read`.

### `GET /v1/credit-notes/:id/print-payload`

**What** The same contract for a credit note, with `originalDocumentNumber`
set so the original can be found.
**Why** A return handed to a customer is as much a legal document as the sale.
**How** Identical query parameters. The refund mode drives the tender block;
`khata` shows as credited to the customer's account rather than as cash out.
Permission `credit_notes:read`.

### `GET /v1/payments/:id/print-payload`

**What** A khata collection slip for a payment received.
**Why** A customer paying down their account expects a receipt.
**How** Note the receipt is identified by `RCPT-<8 hex of the payment id>`,
not a numbered series — payments have no `document_series` yet. Permission
`payments:read`.

---

## Print settings — tag `Print settings`

### `GET /v1/print-profiles`

**What** All print profiles (tenant default plus per-outlet) and the
catalogue of available templates.
**Why** Drives the print-settings screen, which needs both what is configured
and what could be.
**How** Profiles come back default-first. Permission `tenant:read`.

### `PUT /v1/print-profiles/:outletId`

**What** Creates or replaces a profile: template choice, the five display
overrides, logo and signature object keys, UPI ID, bank/terms/footer lines.
**Why** Branding and bank details belong to the business, not to a build.
**How** Pass the literal `default` as `outletId` for the tenant-wide profile
every outlet inherits from **field by field** — so setting one branch's GSTIN
does not lose shared terms. An override of `null` means "inherit the
template's own decision"; `false` means "off". Permission `tenant:manage`.

### `GET /v1/custom-fields`

**What** The tenant's custom field definitions, in print order.
**Why** The billing screen needs to know which extra fields to prompt for,
and which are required.
**How** `?includeInactive=true` to show retired ones. Permission `tenant:read`.

### `POST /v1/custom-fields`

**What** Defines a field — vehicle no, PO no, ticket no — with a key, label,
data type, required flag and which document types it applies to.
**Why** `invoices.custom_fields` accepted any JSONB bag with no label, no
ordering and no validation. This is the missing half.
**How** The `key` is a permanent wire identifier (`^[a-z][a-z0-9_]{0,39}$`)
that older installed apps will keep sending; choose it carefully, because it
cannot be changed. `maxLength` applies to text fields only. Permission
`tenant:manage`.

### `PATCH /v1/custom-fields/:id`

**What** Updates the label, ordering, required flag, applicable documents or
active state.
**Why** A shop renames things; the stored key must not move with the label.
**How** `key` is deliberately absent from the body — issued documents already
carry it. Permission `tenant:manage`.

### `DELETE /v1/custom-fields/:id`

**What** Retires a definition (soft delete).
**Why** New documents should stop carrying a field the shop abandoned.
**How** Documents already issued keep printing it, labelled from a humanised
form of the key — dropping it would quietly remove a line from a legal
record. Permission `tenant:manage`.

---

## Uploads — tag `Uploads`

### `POST /v1/uploads/sign`

**What** Returns a short-lived URL to PUT a file to, plus the durable
`objectKey` to store on whatever record owns it.
**Why** No file byte transits this API. Proxying multipart would cost a
request's worth of memory per megabyte and give a shop on flaky 4G no way to
resume.
**How** Send `kind` (`logo`|`signature`|`receipt`|`import`|`export`),
`contentType` and `sizeBytes`. Both are validated here because signing is the
last moment the server sees the request: logo 2 MB, signature 1 MB
(png/jpeg/webp), receipt 5 MB (+pdf), import 10 MB (xlsx/csv). `export` is
server-written and refused. Then PUT the bytes with the **same Content-Type**.
Any authenticated session may call it; the object is useless until referenced
by a record whose own write is permission-checked.

### `GET /v1/uploads/url?key=`

**What** Resolves an object key to a short-lived readable URL.
**Why** Print payloads return `logoObjectKey` rather than a URL, because URLs
expire and a printer may be offline when a bill is reprinted.
**How** A key outside the caller's tenant prefix answers 403. Keys with `..`,
a leading `/` or `//` are rejected outright.

---

## Bulk import — tag `Imports`

> Call `analyse` and then `apply` **repeatedly until `done` is true**. Both
> are idempotent on their cursor, so a retry after a dropped response repeats
> no work. Every response carries the same progress object, so the UI can
> show a real progress bar and resume after being backgrounded.

### `POST /v1/imports`

**What** Creates an import job and returns a signed `uploadUrl`.
**Why** The first step of the one feature that makes onboarding possible — a
shop will not retype a 500-item price list.
**How** Upload the spreadsheet to the returned URL, then call `ingest`.
Gated on the `bulk_edit` entitlement. Permission `imports:write`.

### `POST /v1/imports/:id/ingest`

**What** Reads the file exactly once, stores every row raw, and guesses the
column mapping from the header row.
**Why** Separating this from analysis is what makes chunking affordable:
re-opening the spreadsheet per chunk would be quadratic.
**How** Recognises the exported header names plus common alternatives
("Particulars", "Rate", "Opening Qty"…). Answers `IMPORT_COLUMN_UNMAPPED` if
nothing maps to a required field, `IMPORT_TOO_LARGE` past the row limit.
Safe to re-run after a crash — it clears anything a previous attempt left.
Permission `imports:write`.

### `POST /v1/imports/:id/analyse`

**What** Validates, matches and diffs the next chunk of rows.
**Why** This is the review step: the shopkeeper needs to see "412 new, 88
price changes, 6 errors" before anything is written.
**How** Loop until `done`. Pass an explicit `columnMap` from a mapping screen
to override the guess — that **restarts analysis from the first row**, since
earlier rows were judged against the old mapping. Permission `imports:write`.

### `GET /v1/imports/:id/rows`

**What** The reviewable diff, one entry per spreadsheet row, with `raw`,
`parsed`, `diff` and `errors`.
**Why** The whole value of a dry run is being able to inspect it.
**How** Filter with `?action=update` to show what will change, `?action=error`
to show what will not import. `matchRule` says _why_ a row matched an
existing item. Permission `imports:read`.

### `POST /v1/imports/:id/apply`

**What** Writes the next chunk of create/update rows in one transaction.
**Why** Chunked rather than one giant transaction, which would hold locks for
its whole duration and sit against the statement timeout.
**How** Loop until `done`. Each chunk commits on its own, so an interrupted
apply leaves `applying` with `appliedUpToRow` set and simply calling again
resumes — every row is written at most once. Answers `IMPORT_STALE` if the
catalogue changed since the review, in which case re-run `analyse`.
Permission `imports:write`.

### `GET /v1/imports/:id`

**What** The job's status, cursors and summary counts.
**Why** Lets a client that was backgrounded work out where to resume.
**How** Permission `imports:read`.

### `GET /v1/imports`

**What** Recent imports, newest first.
**Why** Surfaces jobs a client abandoned mid-way, so the UI can offer resume
or cancel. This is what the absence of a worker costs, made visible.
**How** Permission `imports:read`.

### `POST /v1/imports/:id/cancel`

**What** Abandons a job, discards its stored rows and purges the upload.
**Why** An abandoned upload should not sit in the bucket forever.
**How** Refused once any row has been applied — this performs no undo and
must not imply one. Permission `imports:write`.

---

## Export and labels — tags `Exports`, `Labels`

### `POST /v1/exports`

**What** Generates an `.xlsx` of items, customers, stock or invoices, stores
it, and returns a short-lived `downloadUrl`.
**Why** A shop must be able to get its own data out — table stakes, and the
other half of import.
**How** Keep the `objectKey`: the URL expires but the key does not, and
`GET /v1/uploads/url` re-signs it. The **items** export is round-trippable
(its headers are exactly what the importer recognises), so export → edit →
import is supported; opening stock is omitted on purpose, because
re-importing it would re-apply an opening balance. `truncated: true` means
the row cap was hit and the file is partial. `outletId` is required for a
stock export. Permission `reports:read`, entitlement `bulk_edit`.

### `GET /v1/labels/templates`

**What** The catalogue of label stationery: three A4 sheet sizes and two
thermal rolls, with dimensions in millimetres.
**Why** Millimetres are what is printed on the packet of labels a shopkeeper
buys; converting here and back would help nobody.
**How** `labelsPerPage` is null on a continuous roll. Permission
`catalogue:read`.

### `POST /v1/labels/payload`

**What** Label data ready to draw: wrapped name lines, formatted price text,
a barcode value and a chosen symbology, per label, with copy counts.
**Why** Data rather than a PDF, so the same payload drives an A4 sticker
sheet and an ESC/POS label printer — the latter takes commands, not pages.
**How** Symbology is chosen, not assumed: numeric values are `ean13`/`upca`/
`ean8` only when the **check digit validates**, otherwise `code128`, because
encoding an invalid EAN prints a label that scans as a different product.
`priceField: 'mrp'` falls back to the sale price when there is no MRP **and
drops the "MRP" wording** — it is a declaration under the Legal Metrology
Act, not a synonym for "the price". Items with neither barcode nor code come
back in `errors` with their names. Permission `catalogue:read`, entitlement
`barcode_printing`.

---

## Terms & Conditions — tag `Terms & Conditions`

Reusable terms a shop attaches to a sale, purchase bill or purchase order.
Each entry has a `title`, a `description` and `applicableFor` (any of `sale`,
`sale_order`, `purchase`, `purchase_order`).

### `GET /v1/terms`

**What** Saved terms, by title. `?applicableFor=sale` returns only entries
that may be attached to that document type. Permission `terms:read`.

### `POST /v1/terms`

**What** Adds terms. Client-generated `id`, so a retry returns the existing
record. Permission `terms:write`.

### `GET /v1/terms/:id` · `PATCH /v1/terms/:id` · `DELETE /v1/terms/:id`

**What** Read, update or soft-delete one entry. Permission `terms:read` /
`terms:write`.

### Attaching terms to a document

`POST /v1/invoices`, `/v1/purchase-bills` and `/v1/purchase-orders` accept an
optional `termsId`. The terms must exist and be applicable to that document
type (otherwise `422`). The document stores the reference **and** a
`termsSnapshot` (`{title, description}`), so editing or deleting the entry
later never changes an issued document. An invoice prints its snapshot in
place of the shop-wide default terms lines. Omitting `termsId` keeps the
previous behaviour.

## Suppliers — tag `Suppliers`

> **Sign convention.** `balance` positive means **the shop owes the
> supplier** — the opposite of a customer balance. On the ledger, credit
> increases what is owed and debit reduces it.

### `GET /v1/suppliers`

**What** The supplier master, searchable by name or phone.
**Why** The other half of the party model; purchasing needs someone to buy
from.
**How** `?q=` searches name and phone, `?includeInactive=true` includes
retired suppliers. Permission `suppliers:read`.

### `POST /v1/suppliers`

**What** Adds a supplier, optionally with an opening balance carried from a
paper ledger.
**Why** Onboarding a shop that already has outstanding payables.
**How** Client-generated `id`, so a retry returns the existing record.
`openingBalance` positive means the shop already owes that much.
`paymentTermsDays` drives the due date on bills and the ageing buckets.
Permission `suppliers:write`, entitlement `purchases`.

### `GET /v1/suppliers/:id`

**What** One supplier with its current balance.
**How** Permission `suppliers:read`.

### `PATCH /v1/suppliers/:id`

**What** Updates supplier details, terms or active state.
**How** Permission `suppliers:write`.

### `DELETE /v1/suppliers/:id`

**What** Soft-deletes a supplier.
**Why** Keeps historical bills intact while removing the supplier from
pickers.
**How** Refused while the supplier has a non-zero balance; settle it first.
Permission `suppliers:write`.

### `GET /v1/suppliers/:id/statement`

**What** The supplier ledger, oldest first, with a running balance.
**Why** What a shopkeeper reconciles against the supplier's own statement.
**How** Paginated. Permission `suppliers:read`.

### `GET /v1/suppliers/ageing`

**What** Payables bucketed 0-30 / 31-60 / 61-90 / 90+, per supplier.
**Why** Answers "who do I owe, and how overdue is it" — the question that
decides who gets paid this week.
**How** Measured from the due date where the supplier has payment terms and
from the bill date otherwise, against the **shop's own calendar day**, not
the server's. `?supplierId=` narrows to one. Empty buckets are returned as
zero so a client can render four columns unconditionally. Permission
`reports:financial`.

### `GET /v1/suppliers/:id/outstanding-bills`

**What** Issued bills with money still owed, oldest first.
**Why** The order to pay them in, and what a payment screen allocates against.
**How** `outstanding` is the bill total less issued payments less issued
debit notes. Permission `purchases:read`.

---

## Purchases — tag `Purchases`

### `POST /v1/purchase-bills`

**What** Records a supplier bill: stock in, item cost moved, payable created,
all in one transaction.
**Why** The feature that gives the system a real stock cost. Without it,
margin is computed against whatever an item costs today.
**How** Carries **both** numbers — the supplier's `supplierInvoiceNo` and our
own allocated `documentNumber`. Re-entering the same supplier invoice in the
same financial year answers `DUPLICATE_SUPPLIER_INVOICE` naming the existing
document. `freightAmount` is apportioned per `landedCostBasis`
(`value`|`quantity`|`none`) and folded into the moving average. `itcEligible`
decides whether GST is capitalised into cost; it is forced false for an
unregistered or composition business. Pass `paidAmount` + `paymentMode` to
settle at the counter. Link to an order with `purchaseOrderId` plus per-line
`purchaseOrderLineId`. 200 on replay, 201 on first write. Permission
`purchases:create`, entitlement `purchases`.

### `GET /v1/purchase-bills`

**What** Purchase bills, newest first, with amount paid.
**Why** The purchase register.
**How** Filters: `from`, `to`, `status`, `supplierId`, `outletId`,
`unpaidOnly=true`. Permission `purchases:read`.

### `GET /v1/purchase-bills/:id`

**What** One bill with its lines, including `landedCostShare` and
`effectiveUnitCost` per line and the computed `outstanding`.
**Why** `effectiveUnitCost` is the figure that actually moved the item's
average, so it is worth being able to see.
**How** Permission `purchases:read`.

### `GET /v1/purchase-bills/:id/returnable`

**What** Each bill line with how much has already been returned and how much
can still go back.
**Why** Partial returns are the normal case; the debit-note screen needs to
know the remaining quantity before it can validate anything.
**How** Mirrors `/invoices/:id/returnable`. Permission `debit_notes:read`.

### `POST /v1/purchase-bills/:id/void`

**What** Reverses stock, cost and the payable.
**Why** Bills are immutable — they moved stock and cost that later sales have
consumed, so a correction screen cannot honestly unwind them. Void and
re-enter instead.
**How** Refused while payments or debit notes exist against the bill; undo
those first. **The cost reversal is exact only if nothing has been sold
since** — once the blended average has been consumed, no arithmetic restores
the prior figure, so it approximates. Permission `purchases:void`.

### `POST /v1/purchase-orders`

**What** Raises a purchase order.
**Why** Closes the reorder-to-purchase loop: decide what to buy, then receive
against it.
**How** An order moves no stock and creates no payable — it is an intention.
Numbered from an auto-provisioned `PO` series. Permission `purchases:create`.

### `GET /v1/purchase-orders`

**What** Orders, newest first.
**How** `?openOnly=true` for draft/sent/partial — the ones still awaiting
goods. Permission `purchases:read`.

### `GET /v1/purchase-orders/:id`

**What** One order with per-line ordered, received and pending quantities.
**Why** `quantityPending` is what a receiving screen counts against.
**How** Permission `purchases:read`.

### `POST /v1/purchase-orders/:id/cancel`

**What** Cancels an order.
**Why** Orders get abandoned; they should not sit open forever.
**How** Refused once anything has been received — those goods and their bill
are real, and an order marked cancelled while its lines show receipts would
misdescribe what happened. Leave it partial instead. Permission
`purchases:create`.

### `PUT /v1/purchase-orders/:id`

**What** Edits an order: replaces its header and lines in one transaction.
**How** Lines are matched by `id`. A line that has received goods keeps its
item, cannot be removed and cannot drop below what was received; the supplier is
fixed once anything has arrived. Refused once the order is cancelled or fully
received. Permission `purchases:create`.

### `DELETE /v1/purchase-orders/:id`

**What** Deletes an order (soft: its number stays accounted for). `204`.
**How** Refused once anything has been received. Permission `purchases:void`.

## Sales orders

An order moves no stock and issues no GST document. It is fulfilled by raising
invoices against it (`salesOrderId` on `POST /v1/invoices`, and
`salesOrderLineId` on each line it covers). Two facts are kept apart:
**fulfilment** (`open` → `partial` → `closed`, derived from the lines) and
**payment** (the advance, a real `payments` row of kind `order_advance` plus a
khata credit). Taking an advance never changes the status.

### `POST /v1/sales-orders`

**What** Takes a sales order. `201`, or `200` with `replayed: true` when the
client `id` was already used.
**How** Numbered from an auto-provisioned `SO` series. Totals come from the same
tax engine as invoices and must match `expectedTotals` (`TOTALS_MISMATCH`).
`customerId` or `customerName` is required; an advance needs a saved customer, a
`paymentMode`, and may not exceed the total (`OVERPAYMENT`). An order may have no
`lines` and a typed `manualTotal`, but not both. `termsId` is snapshotted
(applicable to `sale_order`). `attachments` are `order_attachment` upload keys
and must belong to the caller's business. Permission `sales_orders:create`.

### `GET /v1/sales-orders`

**What** Orders, newest first. `?status=all|open|partial|closed`, `customerId`,
`outletId`. Permission `sales_orders:read`.

### `GET /v1/sales-orders/summary`

**What** `{ all, open, partial, closed }` counts, behind the list's filter chips.

### `GET /v1/sales-orders/:id`

**What** One order with per-line `quantity`, `quantityFulfilled` and
`quantityPending`, `advanceAmount` and `balanceDue`.

### `PUT /v1/sales-orders/:id`

**What** Edits an order, replacing header and lines atomically. A changed
advance voids the old payment and writes a new one, with matching khata entries.
**How** A line already invoiced keeps its item, cannot be removed and cannot drop
below the invoiced quantity (`FULFILMENT_EXCEEDS_ORDER`); the customer is fixed
once invoiced. Refused when closed or cancelled (`SALES_ORDER_CLOSED`).
A closed order can be edited (adding quantity or a line re-opens it). Edit is
owner-only: managers and cashiers do not hold `sales_orders:update`.
Permission `sales_orders:update`.

### `DELETE /v1/sales-orders/:id`

**What** Deletes an order. An advance not yet used on an invoice is refunded
first (`?refundMode=` one of khata, cash, upi, card, bank_transfer, cheque,
wallet; default the mode it was taken by). `204`, or `200` with the refund when
there was one.
**How** Refused once anything has been invoiced. Owner-only: permission
`sales_orders:delete`.

### `POST /v1/sales-orders/:id/cancel` and `/close`

**What** Cancel (refused once invoiced) or close by hand (short-shipped). Body
`{reason, refundMode?}` / `{refundMode?}`. The unused advance is refunded in the
chosen mode, atomically with the status change; `khata` leaves it as customer
credit. Cancel defaults to the original mode, close defaults to `khata`. The
response carries `refund` when money moved. Open stock reservations are released.
Permission `sales_orders:cancel` (owner and manager, not cashier).

### `GET /v1/sales-orders/:id/print-payload`

**What** The order formatted for print or share, like the invoice payload.
Permission `sales_orders:read`.

### Stock reservation

Open and partial orders reserve their pending catalogue quantity
(`stock_balances.reserved`; available = quantity - reserved). Custom lines never
reserve. An order above available stock returns a `RESERVATION_SHORTFALL`
warning, and is refused (`INSUFFICIENT_STOCK`) only when the business has
`allow_negative_stock` off. Other invoices warn with `RESERVED_STOCK`.
`POST /v1/stock/reservations/reconcile` recomputes the projection from the orders.

### Amending an invoice

An invoice is amended by a full credit note plus a replacement invoice that
carries `amendsInvoiceId`. The server accepts the replacement only when the
original is fully credited, not already replaced, and has no additional charges.
Fulfilment on the order is reversed by the credit note and re-applied by the
replacement.

### Plan gating

Sales orders are the `sales_orders` plan feature (Standard, Pro, Trial); other
plans receive `402 FEATURE_NOT_IN_PLAN`, including on an invoice with `salesOrderId`.

### `POST /v1/supplier-payments`

**What** Records money paid to a supplier, optionally allocated across
specific bills.
**Why** Without it the payable only ever grows.
**How** Each allocation is checked against what is actually still outstanding
on that bill, with the bill row locked, so two payments cannot both claim the
last rupee. Omitting `allocations` leaves the money **on account** as an
advance; either way the full amount reduces the supplier balance.
Permission `purchases:create`.

### `GET /v1/supplier-payments`

**What** Payments made, newest first, with how much of each is allocated.
**How** Filter by `supplierId`, `from`, `to`. Permission `purchases:read`.

### `POST /v1/supplier-payments/:id/void`

**What** Reverses a payment and its allocations.
**Why** Cheques bounce and entries get made twice.
**How** Writes a reversing ledger entry rather than deleting anything.
Permission `purchases:void`.

---

## Debit notes — tag `Debit notes`

### `POST /v1/debit-notes`

**What** Returns goods or value to a supplier: stock out, cost unwound,
payable reduced.
**Why** A debit note is a GST document the shop **issues**, so unlike a
purchase bill it gets a real series and counts towards GSTR-1 Table 13.
**How** Lines are given by `purchaseBillLineId` + quantity, and **rates come
from the original bill** — a return is settled at what was paid, so our note
and the supplier's credit note agree to the paisa. Stock leaves at the
`effectiveUnitCost` the goods came in at, not today's average. Set
`restock: false` for damaged or expired goods the supplier credits without
collecting; no stock then moves. Answers `RETURN_EXCEEDS_BILL` if more is
returned than remains. Permission `debit_notes:create`.

### `GET /v1/debit-notes`

**What** Debit notes, newest first.
**How** Filter by `supplierId`, `purchaseBillId`, `from`, `to`. Permission
`debit_notes:read`.

### `GET /v1/debit-notes/:id`

**What** One note with its lines.
**How** Permission `debit_notes:read`.

### `POST /v1/debit-notes/:id/void`

**What** Reverses the return: stock back in, payable back up.
**Why** Returns get entered in error like anything else.
**How** The stock reversal is guarded, so a repeated void cannot restore
stock twice. Permission `debit_notes:void`.

---

## New error codes

| Code                         | Meaning                                                       |
| ---------------------------- | ------------------------------------------------------------- |
| `CUSTOM_FIELD_UNKNOWN`       | The document carried a key the tenant has not defined.        |
| `CUSTOM_FIELD_INVALID`       | A defined field was missing, too long or the wrong type.      |
| `IMPORT_TOO_LARGE`           | The file has more rows than `IMPORT_MAX_ROWS`.                |
| `IMPORT_STALE`               | The catalogue changed between review and apply; re-analyse.   |
| `IMPORT_WRONG_STATE`         | That step is not next for this job.                           |
| `IMPORT_COLUMN_UNMAPPED`     | No column maps to a required field.                           |
| `IMPORT_UNREADABLE`          | The upload is not a readable spreadsheet.                     |
| `DUPLICATE_SUPPLIER_INVOICE` | That supplier invoice is already recorded this year.          |
| `RECEIPT_EXCEEDS_ORDER`      | More received than remains on the purchase order.             |
| `PURCHASE_ORDER_CLOSED`      | The order is cancelled, or already fully received.            |
| `RETURN_EXCEEDS_BILL`        | More returned than remains on the bill line.                  |
| `BILL_NOT_RETURNABLE`        | The bill is void; nothing can be returned or paid against it. |
| `OVERALLOCATION`             | Allocations exceed the payment, or a bill's outstanding.      |

## New permissions

`imports:read`, `imports:write`, `suppliers:read`, `suppliers:write`,
`purchases:read`, `purchases:create`, `purchases:void`, `debit_notes:read`,
`debit_notes:create`, `debit_notes:void`.

Owner and manager get all of them. **Cashier gets none** — a cashier who can
enter a purchase bill can inflate stock and create a payable, and the
supplier ledger is what the shop owes, not something a counter needs.
Accountant and viewer pick up the `:read` set automatically.

## Changed behaviour on an existing endpoint

`GET /v1/reports/daily-pnl` now costs goods at the moving average recorded on
each invoice line at the time of sale, instead of the item's _current_
purchase price. A new `costBasis` column reads `Actual`, or `Estimated` on any
day where some lines predate costing and had to fall back.

---

# Pricing, discount caps, GST returns, and the reports expansion

33 further endpoints, plus changes to ten existing ones across seven areas,
and 26 new report ids.
Same conventions as above: paise and thousandths, `{ data }` envelopes,
client-generated ids, 404 rather than 403 across tenants.

Design reasoning for this set: [REMAINING_FEATURES.md](REMAINING_FEATURES.md)
sections 8–13.

---

## Price lists — tag `Pricing`

### `GET /v1/price-lists/resolve`

**What** The authoritative price for one item, for one customer, at one
quantity — with `source` and `priceListId` saying which rule produced it.
**Why** A shop selling at both retail and wholesale knows what a given
customer should pay, and before this there was nowhere to put that knowledge:
it leaked into the cashier's judgement at the till.
**How** `?itemId=&customerId=&quantity=&outletId=`. Resolution is most
specific first — an explicit entry on the customer's list (taking the highest
quantity break at or below what is being sold), then the list's own rule, then
the item's own selling price. A till warms its cache from this and then prices
**offline** with the same pure resolver the server runs, which is why the
answer carries the rule and not just the number. Permission `catalogue:read`
rather than `price_lists:read`: a cashier must be able to price what they are
selling while still having no way to see or change the lists.

### `GET /v1/price-lists`

**What** Every price list, by name.
**Why** Drives the pricing screen and the list picker on a customer.
**How** `?kind=retail|wholesale|distributor|custom&includeInactive=`. Keyset
paginated on name. Permission `price_lists:read`.

### `POST /v1/price-lists`

**What** Creates a list: a `kind`, a `basis`, and optionally a floor and an
effective window.
**Why** So wholesale pricing is a rule rather than a column somebody edits by
hand on every item.
**How** A list is a set of **overrides, not a whitelist**: an item it holds no
price for falls through to the basis and then to the item's own price, so a
wholesale customer buying something nobody priced for wholesale is still
billable. `basis: fixed` means only explicit prices apply;
`percent_off_sale` discounts the item's price; `percent_on_cost` marks up
moving-average cost, which holds margin as buying prices move — **set
`minPriceFloor` with it**, because a cost-plus list with a stale cost is how a
shop sells below what it paid without noticing. Replay-safe on `id`: 201 first,
200 after. Permission `price_lists:write`, feature `price_lists`.

### `GET /v1/price-lists/:id` · `PATCH /v1/price-lists/:id`

**What** One list, and edits to it.
**Why** Changing a list changes what every customer on it pays, so the change
is audited with its before and after rather than merely noted.
**How** `PATCH` with `isDefault: true` demotes whatever list was default —
"make this the default" means that, and the partial unique index would
otherwise reject it as a duplicate the caller has to interpret. Permissions
`price_lists:read` / `price_lists:write`.

### `DELETE /v1/price-lists/:id`

**What** Soft-deletes a list.
**Why** / **How** Refused with 409 while customers are priced on it. Deleting
it would silently reprice them to the item price, which is a margin change
nobody asked for; move them to another list first. Permission
`price_lists:write`.

### `GET /v1/price-lists/:id/items` · `PUT /v1/price-lists/:id/items`

**What** The prices a list holds, and a batch upsert of them.
**Why** The bulk editor behind the pricing screen.
**How** Several rows for one item form a **quantity-break ladder**: each
applies from its `minQuantity` up. `replace: true` clears the list first;
otherwise rows merge in, and a row re-added after deletion is revived.
`pricesIncludeTax` is per price, independent of the item's and the invoice's
flags — a wholesale list is usually quoted exclusive even in a shop that
prices retail inclusive. Capped at 1000 rows, because repricing more than that
is a revision job with a preview. Permissions `price_lists:read` /
`price_lists:write`.

### `DELETE /v1/price-lists/:id/items/:itemId`

**What** Removes an item's price from a list.
**Why** / **How** Soft, not hard. The sync change feed reads the table itself,
so a row that no longer exists cannot be reported as deleted — a hard delete
would leave every till pricing at a figure the shop removed, indefinitely.
Permission `price_lists:write`.

---

## Discount caps — tag `Pricing`

### `GET /v1/discount-policies`

**What** The business-wide policy (`outletId: null`) and any outlet overrides.
**Why** The till needs the policy to enforce the cap offline; the settings
screen needs it to show what is configured.
**How** An outlet inherits **field by field**, so a branch can override one
number without restating the policy. Synced to devices pull-only. Permission
`discount_policies:read` — a cashier has it, because the till cannot enforce a
cap it has never seen.

### `PUT /v1/discount-policies`

**What** Sets the business-wide policy, or one outlet's override when
`outletId` is given.
**Why** To stop a cashier giving away margin unchecked — the stated problem
this feature exists for.
**How** Every limit is nullable and **null means no limit, not zero**: a cap of
zero is a shop that forbids discounts, which is a different and legitimate
setting. `minMarginPercent` is the one limit that catches a discount inside
every percentage cap that still loses money.
`requireApprovalAbovePercent` unset makes the caps absolute — the owner set a
limit and said nothing about an override. Permission
`discount_policies:manage`, feature `discount_rules`.

### `GET /v1/discount-approvals`

**What** The margin-giveaway trail: who approved which over-cap discount,
when, with what reason, and the role they held at the time.
**Why** A cap is only worth having if breaching it leaves a record. The role is
stored because memberships change and "was this person entitled to approve it
*then*" has to stay answerable.
**How** Read-only, and deliberately so: **an approval is created as part of the
invoice that carries the discount**, never posted on its own, so the authority
and the discount can never be committed apart and an offline sale uploads its
evidence with it. The table is append-only. Filter by `from`, `to`,
`approvedBy`, `invoiceId`. Permission `reports:financial` — this is an owner's
report, not a till screen.

---

## Bulk price revision — tag `Pricing`

### `POST /v1/price-revisions`

**What** Starts a revision: raise a category 7%, reprice a wholesale list from
cost, round everything to the rupee.
**Why** Repricing a catalogue by hand is the job nobody does, so prices drift
behind costs until margin quietly disappears.
**How** **Creating it writes nothing.** The client then calls `analyse`
repeatedly to build a preview and only then `apply`. `target` is
`item_sale_price` or `price_list` (with `priceListId`); narrow with
`categoryId` or `supplierId`. `roundToPaise` rounds each new price to a
multiple, so a 7% rise does not leave the shelf at ₹10.73. `set_from_cost`
skips any item with no average cost rather than pricing it at zero.
Permission `price_lists:write`, features `bulk_edit` and `price_lists`.

### `POST /v1/price-revisions/:id/analyse`

**What** Prices one chunk and stores the preview — every row with its old and
new price, and a reason for each one that will not change.
**Why** A price change is not reversible by reading the result: once the price
has moved, what it was is gone. The preview is what the shopkeeper approves.
**How** Call until `done`. Each call takes a row lock on the job, so a double
tap or two open tabs cannot claim the same slice. Re-analysing from `pending`
clears the previous preview but **never a row already applied**, so a
part-applied revision cannot have its own history rewritten underneath it.
Permission `price_lists:write`.

### `GET /v1/price-revisions/:id/rows`

**What** The preview itself.
**Why** / **How** `?action=change|skip|error` to review one bucket — `error`
is the list to read before applying (no average cost, a price below the list
floor). Permission `price_lists:read`.

### `POST /v1/price-revisions/:id/apply`

**What** Writes one chunk of the new prices.
**Why** Chunked because every repriced row republishes to every device through
the sync feed, and a five-thousand-item revision should not arrive as one
lock-held burst against the per-tenant sequence counter.
**How** Call until `done`. Each row carries its own `appliedAt`, so a resumed
apply writes each price **exactly once** even if a chunk committed just before
the client gave up waiting. Refused with 409 when the catalogue has moved since
the preview: a revision analysed this morning must not quietly reprice items
added since, or apply a percentage to a price somebody has already changed by
hand. Permission `price_lists:write`.

### `GET /v1/price-revisions` · `GET /v1/price-revisions/:id` · `POST /v1/price-revisions/:id/cancel`

**What** The job list, one job's progress, and cancellation.
**Why** / **How** Cancel only works before anything is written: half-applied
prices cannot be rolled back by cancelling, because the old prices live only in
the preview — restoring them is a new revision. 409 otherwise. Permissions
`price_lists:read` / `price_lists:write`.

---

## GST return periods — tag `GST`

### `POST /v1/gst/periods`

**What** Opens a period to work on.
**Why** A return is a thing with a lifecycle — open, prepared, filed — and the
figures have to be pinned at the moment they are declared.
**How** Computes nothing; `prepare` does that. Returns are per **GSTIN**, not
per business: a shop trading in two states holds a registration per state and
files separately for each. Omit `gstin` and the business's own is used; a
business with more than one must name which. A composition dealer files CMP-08
and a regular dealer GSTR-1 and GSTR-3B — asking for the wrong one is refused,
because filing a return you do not owe tends to come with the one you do left
unfiled. Permission `gst:manage`, feature `gst_workings`.

### `POST /v1/gst/periods/:id/prepare`

**What** Computes the return and stores the workings.
**Why** Snapshotted rather than recomputed on read, for the same reason
`day_closes` stores its figures: a void raised in November must not restate
October's filed return.
**How** Re-runnable as often as the shop likes while open or prepared —
entering a missing bill and preparing again is the normal workflow, not an
error. **Refused with 409 once filed**; a correction belongs in a later period
as an amendment. GSTR-1 workings carry the itemised tables (B2B, B2CL,
exports, SEZ, CDNR, CDNUR), the B2CS rate-wise aggregate, the
nil/exempt/non-GST totals, the HSN summary and documents-issued. GSTR-3B
carries the 3.1 sections, the self-assessed reverse-charge liability, and ITC
split the four ways table 4 requires. Also folds any pre-register purchase
bills into the ITC register, idempotently. Permission `gst:manage`.

### `POST /v1/gst/periods/:id/file`

**What** Records who declared the return, when, and the portal's
acknowledgement number.
**Why** **Nothing here files anything on the shop's behalf.** The figures are
the shop's own declaration to the department, so the act of declaring them is
always a person's.
**How** Requires `confirm: true` — a deliberate speed bump, because an
accidental POST would otherwise record a filing that never happened and the
next period would build on it. Refuses a period that has not been prepared and
reviewed. Cannot be undone. Permission `gst:manage`.

### `GET /v1/gst/periods/:id/export`

**What** A prepared return as a workbook (one sheet per table) or as JSON.
**Why** The filing itself happens on the portal or through an accountant, so
the figures have to leave the system in a form either can use.
**How** `?format=xlsx|json`. Reads the **snapshotted** workings, never
recomputing: the file an accountant was given last week and the figures on
screen today have to be the same thing, or nobody can tell which was filed.
422 before the period is prepared. The JSON carries the workings under an
identifying header and is deliberately **not** reshaped into the portal's
abbreviated upload keys — that mapping belongs with a filing integration that
can be tested against the real API, and inventing it here would produce a file
that looks official and may not upload. Returns a short-lived signed URL.
Permission `gst:read`.

### `GET /v1/gst/periods` · `GET /v1/gst/periods/:id`

**What** The period list and one period with its workings.
**Why** / **How** Filter by `gstin`, `returnType`, `status`. Newest first.
Permission `gst:read`.

---

## Input tax credit — tag `GST`

### `GET /v1/gst/itc-register`

**What** Every credit the shop has claimed or could claim, signed so the
register sums to the claimable figure.
**Why** GSTR-3B table 4 splits credit four ways and `purchase_bills.itc_eligible`
— a single boolean — could not fill it. The credit also has its own life:
claimed in a period that need not be the bill's, reversed if the supplier never
files, reclaimed when they do.
**How** Filter by `gstin`, `from`, `to`, `state`, `itcCategory`, `supplierId`.
A row is **never deleted**; the state moves instead (`available` → `claimed`
once a 2B row supports it, `reversed` on a void, `ineligible` for a §17(5)
blocked credit), because this is the ledger an assessment is defended with.
`matched2bId: null` is the interesting case — credit paid for that no supplier
has reported. Permission `gst:read`.

---

## GSTR-2B reconciliation — tag `GST`

### `POST /v1/gst/2b-imports`

**What** Registers a statement and returns a signed URL to PUT the bytes to.
**Why** This is where GST-registered shops actually lose money: a bill the
supplier forgot to upload is input tax already paid and unreclaimable, and
nothing else in the system can see it.
**How** The file never passes through this API, as with the catalogue importer.
`format` is `json` (the portal's own download, the default) or `xlsx`, since
that is what some accountants hand over. Then call `ingest`, then `reconcile`.
Permission `gst:manage`, feature `gst_workings`.

### `POST /v1/gst/2b-imports/:id/ingest`

**What** Parses the statement and stores its rows as received.
**Why** Deliberately **not** folded into the purchase register: this is
somebody else's assertion about what they filed, and the whole value of the
feature is the difference between it and ours.
**How** Handles the portal's own shapes — rupees with decimals rather than
paise, `DD-MM-YYYY` dates, abbreviated keys, invoices nested per supplier, and
the `b2b`/`b2ba`/`cdnr`/`cdnra`/`impg` blocks. Rows that cannot be read are
reported in `errorSummary` rather than dropped, because **a row nobody could
identify is not the same as a supplier who never filed**, and only one of those
is worth chasing. `ingesting` and `failed` are both re-runnable. Permission
`gst:manage`.

### `POST /v1/gst/2b-imports/:id/reconcile`

**What** Matches the statement against the purchase register and returns
`creditAtRisk`.
**Why** `creditAtRisk` is the number this whole area of the product exists to
produce.
**How** Three passes, narrowing in confidence. Same GSTIN and normalised
invoice number with amounts agreeing is `exact`; the same document with a
figure that disagrees is `mismatch` (the useful case — one side keyed something
wrong); the same supplier and amount with a different number is `probable`,
which needs a human. What is left over is the point: `missing_in_2b` is a bill
in the books no supplier reported; `missing_in_books` is usually a bill nobody
entered. Numbers are normalised before comparison, so `INV-001`, `inv 001` and
`INV001` match — treating them as three is how a reconciliation sends a
shopkeeper to chase a supplier who filed correctly. **Bills from unregistered
suppliers are skipped**, not reported missing: such a supplier files nothing, so
its absence is correct and listing it would bury the real gaps. The comparison
window is `GSTR2B_COMPARISON_MONTHS` either side of the period. An `exact`
match claims the credit in the ITC register. Permission `gst:manage`.

### `GET /v1/gst/2b-imports/:id/matches`

**What** What reconciliation concluded, with both sides side by side and the
differing fields for a mismatch.
**Why** / **How** `?matchType=` to review one bucket. `missing_in_2b` is the
one to act on. Permission `gst:read`.

### `POST /v1/gst/2b-imports/:id/matches/:matchId/accept`

**What** Confirms a probable match or a mismatch a human has looked at.
**Why** Always a human decision: a probable match is two documents that look
alike but are numbered differently, and accepting one wrongly claims credit
against somebody else's invoice — the exact error this feature exists to
prevent.
**How** Records who accepted it and any note; a later reconciliation then
**leaves it alone** rather than undoing the decision. Claims the credit in the
ITC register. 422 on an `exact` or `missing_*` match, which needs no
confirming. Permission `gst:manage`.

### `GET /v1/gst/2b-imports` · `GET /v1/gst/2b-imports/:id`

**What** The reconciliation list and one job's progress with its credit at
risk.
**Why** / **How** Newest first. Permission `gst:read`.

---

## Changes to existing endpoints

### `POST /v1/invoices`

Three additions, all optional on the wire so an installed app that predates
them keeps uploading:

- **`lines[].supplyCategory`** — `taxable` (the default) | `exempt` |
  `nil_rated` | `non_gst`. Omitted, the item's own classification applies. A
  0% line is not evidence of anything on its own, and GSTR-1 table 8 reports
  the four separately.
- **`supplyType`** — declares an export or SEZ supply, which no state code
  implies. Omitted, it is derived from the place of supply as before.
- **`isReverseCharge`** — the recipient pays the tax, so the document carries
  none while still reporting the value.
- **`discountApprovals[]`** — approvals for discounts that breach the policy,
  travelling with the document so the authority and the discount commit
  together. The server re-runs the cap check and **verifies each named approver
  actually holds the permission the policy requires**, rejecting with
  `APPROVER_NOT_PERMITTED` if not — an approval from someone not entitled to
  give it is not evidence of anything.

Two new warnings on a successful write, never rejections, because an offline
sale has already happened:

- **`DISCOUNT_CAP_EXCEEDED`** — a discount breaches the policy and no approval
  accompanied it. The breach details are in `details.breaches`.
- **`PRICE_LIST_MISMATCH`** — the price charged is not what the customer's
  price list says. Reported, never corrected: the device priced from the list it
  held, and rewriting the figure would make the stored invoice disagree with the
  bill the customer is holding.

Each line now also records `priceListId` and `priceSource`, so a margin or
discount report reads what was true at the sale rather than re-deriving against
today's prices.

### `POST /v1/purchase-bills`

- **`itcCategory`** — `inputs` (the default) | `input_services` |
  `capital_goods` | `ineligible`, for GSTR-3B table 4.
- **`itcIneligibleReason`** — a §17(5) reason, recorded on the register.
- **`isReverseCharge`** — the supplier charged no tax and the business owes it
  instead. The bill carries no tax while the line rates stay on it, because
  GSTR-3B reports the self-assessed liability and the matching credit from
  those rates.
- **`lines[].supplyCategory`** — as on an invoice.

Entering a bill now also writes its ITC register row; voiding it reverses the
credit rather than deleting the row.

### `POST /v1/debit-notes`

Inherits `supplyType`, `isReverseCharge` and each line's `supplyCategory` from
the bill, and writes a **negative** ITC register row — returning goods gives
back the credit claimed on them. `restock` is now persisted, so a void reverses
only what actually moved.

### `POST /v1/items` · `PATCH /v1/items/:id`

**`supplyCategory`** on the item, so a till is not asked to classify every line
it bills.

### `POST /v1/customers` · `PATCH /v1/customers/:id`

**`priceListId`** — which list this customer is billed at. Null takes the
tenant default, which is how a walk-in and an unassigned customer end up priced
the same way.

### `POST /v1/onboarding/tenants` · `PATCH /v1/tenant`

**`compositionCategory`** (`trader` | `manufacturer` | `restaurant` |
`service`) and **`compositionRatePercent`**, which decide the CMP-08 liability;
**`filingFrequency`** (`monthly` | `qrmp`), which decides which periods exist
to file at all; and **`registrationEffectiveFrom`**, before which supplies are
outside GST for this business. The rate is stored separately from the category
because the notified rates change and a CMP-08 already filed must keep
reporting the rate it was filed at.

### `GET /v1/reports/:reportId`

**`?format=csv`** returns the same report as a file. The conversion is
generic — it reads the column `kind` and nothing else — so every report exports
without its own code, which is what the column schema was for. Money and
quantity columns are converted to rupees and units there, since a spreadsheet
is read by a person rather than a client that knows the scales. Values
beginning `=`, `+`, `-` or `@` are tab-prefixed, because report rows carry
names a customer chose and those execute as formulas in Excel.

Plan gating also moved: it was a comma-separated list of report ids in the
environment, which did not survive the jump from thirteen reports to
thirty-nine. Each definition now names the feature that unlocks it, and
`GET /v1/reports` still reports `locked` and `restricted` per report so the
client shows an upsell rather than discovering a 402 after the user has picked a
date range.

---

## New reports

26 added, taking the registry from 13 to **39**. All run through the same
`GET /v1/reports/:reportId`, so none of them needed an endpoint.

| Report id | Group | Feature | Extra permission |
| --- | --- | --- | --- |
| `cashier-wise-sales` | sales | `reports.all` | — |
| `counter-wise-sales` | sales | `reports.all` | — |
| `hourly-sales-heatmap` | sales | `reports.all` | — |
| `discount-audit` | sales | `discount_rules` | `reports:financial` |
| `returns-and-voids` | sales | `reports.all` | — |
| `gross-margin-by-item` | sales | `reports.all` | `reports:financial` |
| `gross-margin-by-category` | sales | `reports.all` | `reports:financial` |
| `stock-valuation` | inventory | `reports.all` | `reports:financial` |
| `stock-ledger` | inventory | `reports.all` | — |
| `purchase-register` | money | `purchases` | `reports:financial` |
| `supplier-wise-purchases` | money | `purchases` | `reports:financial` |
| `purchase-order-status` | money | `purchases` | — |
| `payables-ageing` | money | `purchases` | `reports:financial` |
| `receivables-ageing` | customers | `reports.all` | `reports:financial` |
| `cash-flow` | money | `reports.all` | `reports:financial` |
| `price-change-history` | money | `price_lists` | `reports:financial` |
| `gstr1-b2b` | compliance | `gst_workings` | — |
| `gstr1-b2c` | compliance | `gst_workings` | — |
| `gstr1-credit-debit-notes` | compliance | `gst_workings` | — |
| `gstr1-hsn-summary` | compliance | `gst_workings` | — |
| `gstr1-nil-exempt` | compliance | `gst_workings` | — |
| `gstr1-documents-issued` | compliance | `gst_workings` | — |
| `gstr3b-summary` | compliance | `gst_workings` | `reports:financial` |
| `gstr2b-reconciliation` | compliance | `gst_workings` | `reports:financial` |
| `itc-register` | compliance | `gst_workings` | `reports:financial` |
| `composition-turnover` | compliance | `gst_workings` | `reports:financial` |

Worth knowing about a few of them:

- **`stock-ledger` needs `itemId`** and **`receivables-ageing` /
  `payables-ageing` take an optional subject**; without an item the ledger
  would be every item's movements interleaved, which is not a document anyone
  wants — the same reason `khata-statement` requires a customer.
- **`payables-ageing` is not outlet-scoped**, deliberately, like
  `customer-outstanding`. What a business owes a supplier is owed by the
  business, not by the branch that received the goods, and four partial
  balances are not something any supplier would recognise.
- **`cash-flow` is built from payments and expenses, not invoices.** A sale
  billed to a customer's khata moves no money, and counting it would tell a
  shop it is solvent when it is not.
- **Every margin figure reads the cost snapshotted on the line at the moment of
  sale**, never the item's current cost, and reports lines with no snapshot as
  *unknown* rather than zero — zero cost reads as pure profit. The `No cost`
  column says how much of the revenue has a real cost behind it.
- **The compliance group reads live documents**, so it answers "what would this
  period look like if I filed it now", which is what an accountant wants
  mid-month. A *prepared* return under `/v1/gst` is the other thing: a snapshot
  that must not move once filed. Both exist because they answer different
  questions.
- **New filters** on the kernel: `supplierId`, `gstin`, `userId`, `counterId`,
  `priceListId`, `hsnCode`, `taxRatePercent`. Compliance reports scope by
  `gstin` rather than by outlet, because filing is per registration and a
  figure spanning two would be wrong for either.
