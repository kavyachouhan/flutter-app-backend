# Khata — project context and API reference

> **Who this is for.** Anyone picking up either side of the product: a Flutter
> developer who needs to know what the API offers and how to call it, and a
> backend developer or AI session continuing the build. Load it first; it
> records what exists, what it does, and what has deliberately not been built.
>
> **State as of 18 September 2026.** Contains no secrets.

---

## 1. The product in one paragraph

GST billing and khata (customer credit) for Indian retail. One Node/Express
backend serves Flutter clients on Android, iOS, Windows and macOS, and a future
React web back office. The defining constraint is that **a shop must be able to
bill with no network at all** — so the device holds a full local copy, issues
legally numbered invoices from number blocks it leased earlier, computes totals
with the same tax engine the server runs, and uploads later.

Product backlog: [`master-feature-list.md`](../master-feature-list.md).
Programme plan: `~/.claude/plans/role-you-are-wise-whisper.md`.

---

## 2. Where the build has got to

| Milestone  | What it delivered                                                    | State                                                         |
| ---------- | -------------------------------------------------------------------- | ------------------------------------------------------------- |
| M1         | Schema hardening, audit route, entitlement primitives                | ✅                                                            |
| M2         | Integration test harness against a real Supabase project             | ✅                                                            |
| Pre-flight | Pluggable OTP delivery, `DATABASE_SSL_CA`, contract vectors          | ✅                                                            |
| M3         | OpenAPI 3.1 from the Zod schemas, `/v1/openapi.json`, `/v1/docs`     | ✅                                                            |
| M4         | Sync: change feed, operation push, per-device cursors, lease top-ups | ✅                                                            |
| M5         | Credit notes and returns, refunds, GSTR-1 gap view across types      | ✅                                                            |
| M6         | Held bills, expenses, day close                                      | ✅                                                            |
| M7         | Reports kernel and thirteen reports                                  | ✅                                                            |
| M8         | Print payloads, templates, custom fields                             | 🚧 pure domain written (`src/domain/print/`), no endpoint yet |
| M9         | Outbox, idempotency middleware, WhatsApp, alerts                     | ⏳                                                            |
| M10        | Bulk import/export, barcode labels                                   | ⏳ → P0 complete                                              |
| M11–M21    | P1, P2, P3                                                           | ⏳                                                            |

| Flutter milestone | What it delivered                                              | State     |
| ----------------- | -------------------------------------------------------------- | --------- |
| F0                | Packages, offline database, auth, router, theme, i18n, flavors | ✅ mostly |
| F1                | Catalogue and customers on the device                          | ⏳ next   |
| F2                | Billing screen                                                 | ⏳        |
| F3                | Sync cutover (REST outbox → `/sync/push`)                      | ⏳        |

Backend is on branch `phase1`; the Flutter repo is on `frontend`. Neither has
been pushed or merged to `main`.

---

## 3. Contracts that apply to every endpoint

Read this section before the endpoint list; it is most of what a client needs.

### 3.1 Envelopes

```jsonc
// A single resource
{ "data": { ... } }

// A list
{ "data": [ ... ], "nextCursor": "eyJrIjoi…" }   // nextCursor null on the last page

// A write that can be replayed
{ "data": { ... }, "replayed": false, "warnings": [] }

// Any failure
{ "error": { "code": "TOTALS_MISMATCH", "message": "…", "details": { … }, "requestId": "…" } }
```

**Branch on `code`, never on `message`.** Messages get reworded and translated;
codes are additive-only and never renamed. An unknown code must be tolerated —
the server adds them without waiting for clients to update.

### 3.2 Money and quantities

- **Money is always an integer number of paise.** `12345` is ₹123.45. There are
  no decimal amounts anywhere in the API.
- **Quantities are integer thousandths of a unit.** `1500` is 1.5 kg.
- Tax and cess rates are the exception: they are decimals (`18`, `0.25`).

### 3.3 Client-generated ids, and why retries are safe

The client generates a **UUID v7** for every document and master record it
creates and sends it as `id`. Creating with an id the server already has
returns the existing record instead of making a second one:

- `POST /invoices` answers **201** on the first write and **200** with
  `replayed: true` on a retry.
- The same holds for customers, items, categories, payments, credit notes,
  stock adjustments, expenses and day closes.

This is what makes an offline queue safe to drain more than once. It is also
why a POST that carries an `id` is retried automatically by the Dart client.

### 3.4 Pagination

Keyset, not offset. Pass `?limit=` and `?cursor=`; send back the `nextCursor`
you were given, and treat it as opaque — it encodes the server's sort key.

### 3.5 Permissions

`GET /auth/me` returns the member's `permissions` array. Hide actions the user
lacks; the server enforces them regardless. Roles are `owner`, `manager`,
`cashier`, `accountant`, `viewer`, and there are 37 permissions
(`src/modules/auth/permissions.ts` is the list).

### 3.6 Warnings versus errors

An offline sale has already happened by the time the server sees it. So the
server rejects only structural problems — an unleased number, totals that
disagree with its own tax engine, unpaid credit with no customer — and reports
everything a device could not have known as a **warning** on a successful
write: `CREDIT_LIMIT_EXCEEDED`, `NEGATIVE_STOCK`, `CASH_VARIANCE_EXCEEDED`.

### 3.7 Headers

| Header                                 | Direction | Purpose                                                                                       |
| -------------------------------------- | --------- | --------------------------------------------------------------------------------------------- |
| `Authorization: Bearer <access token>` | →         | Every tenant-scoped route                                                                     |
| `X-Request-Id`                         | ↔         | Send one; it is echoed and lands in logs and the audit trail. The single string support needs |
| `Retry-After`                          | ←         | On 429, with `details.retryAfterSeconds`                                                      |
| `RateLimit-Remaining`                  | ←         | On every response                                                                             |

### 3.8 Error codes worth handling specifically

| Code                                    | HTTP    | What the client should do                                                    |
| --------------------------------------- | ------- | ---------------------------------------------------------------------------- |
| `TOKEN_EXPIRED`                         | 401     | Refresh once, replay the request (the Dart client does this)                 |
| `TOKEN_INVALID`, `ACCOUNT_DISABLED`     | 401/403 | Sign in again; nothing retryable                                             |
| `TOTALS_MISMATCH`                       | 409     | A client/server engine drift. Not the user's fault — report it, do not retry |
| `NUMBER_NOT_LEASED`                     | 422     | The device used a number it does not hold. Re-lease and re-issue             |
| `CREDIT_SALE_REQUIRES_CUSTOMER`         | 422     | An unpaid balance needs a customer                                           |
| `RETURN_EXCEEDS_INVOICE`                | 422     | More units returned than remain returnable                                   |
| `STALE_WRITE`                           | 409     | Someone edited this master elsewhere. Show both versions                     |
| `SYNC_RESET_REQUIRED`                   | 409     | Wipe local data and pull from `since=0`                                      |
| `FEATURE_NOT_IN_PLAN`, `QUOTA_EXCEEDED` | 402     | Show an upsell, not an error                                                 |
| `RATE_LIMITED`                          | 429     | Honour `Retry-After`                                                         |
| `DEPENDENCY_UNAVAILABLE`                | 503     | Transient. Keep the operation queued                                         |

---

## 4. API reference

Base URL is `<host>/v1`. `GET /v1/openapi.json` serves the full machine-readable
spec and `/v1/docs` a browsable version, when `OPENAPI_ENABLED=true`.

### 4.1 Auth

| Method | Path                | Purpose                                                                |
| ------ | ------------------- | ---------------------------------------------------------------------- |
| POST   | `/auth/otp/request` | Send a one-time code to a phone number                                 |
| POST   | `/auth/otp/verify`  | Exchange the code for an **identity token** and the list of businesses |
| POST   | `/auth/sessions`    | Open a session in one business; registers this device                  |
| POST   | `/auth/refresh`     | Rotate the refresh token                                               |
| POST   | `/auth/logout`      | Revoke this device, or every device                                    |
| GET    | `/auth/me`          | Who the signed-in member is, and their permissions                     |
| POST   | `/auth/dev-login`   | Development only; sign in with no OTP                                  |

**`POST /auth/otp/request`** — body `{ phone }`. Answers **202** with
`{ channel, maskedDestination, expiresInSeconds, resendAfterSeconds }`.
`channel` is `sms`, `whatsapp` or `voice`: **display what the server says**, do
not hardcode "SMS". The delivery vendor is pluggable and expected to change.
Rate limited per IP _and_ per normalised phone number.

**`POST /auth/otp/verify`** — body `{ phone, code }` → `{ identityToken,
identityTokenExpiresAt, userId, tenants[] }`. The identity token proves the
phone only; it carries no tenant and is accepted only by the onboarding routes.
An empty `tenants` array means a first-time user: send them straight to creating
a business.

**`POST /auth/sessions`** — identity token in the header; body
`{ tenantId, device: { deviceKey, platform, label?, appVersion?, osVersion? } }`
→ a `Session` with `accessToken`, `refreshToken`, `role`, `outletIds`,
`deviceId`.

`deviceKey` is generated once per install and kept in the keystore. It is what
re-attaches a reinstalled app to its existing device row — **and to the number
blocks that row still holds.** Losing it strands those numbers as GSTR-1 gaps.

**`POST /auth/refresh`** — presenting an already-rotated token outside the grace
window is treated as theft and revokes the whole device session. So refresh must
be **single-flight**: never let two concurrent 401s each start a refresh.

### 4.2 Onboarding and the business

| Method | Path                   | Purpose                                                             |
| ------ | ---------------------- | ------------------------------------------------------------------- |
| GET    | `/onboarding/tenants`  | Businesses this phone belongs to (identity token)                   |
| POST   | `/onboarding/tenants`  | Create a business, its first outlet and counter, and open a session |
| GET    | `/tenant`              | The current business profile                                        |
| PATCH  | `/tenant`              | Update it                                                           |
| GET    | `/tenant/subscription` | Plan, quotas, feature grants and live usage                         |

**`POST /onboarding/tenants`** does everything in one call — tenant, free
subscription, owner membership, first outlet, first counter, session — because a
half-created business is not a state anyone can recover from on a phone. Every
id (`id`, `outlet.id`, `counter.id`) is client-generated, so a retry after a
timeout returns the same business.

Body highlights: `name`, `isGstRegistered`, `stateCode` (two digits, decides
CGST+SGST vs IGST), `gstin` when registered, `defaultPricesIncludeTax`,
`outlet: { id, name, code }`, `counter: { id, name, code }`, `device`.

**`GET /tenant/subscription`** returns `maxUsers/maxOutlets/maxCounters/maxItems`
(null means unlimited), `features` (a grant map), and live `usage`. Feature
lookup order is the key itself → its `group.*` wildcard → `*`, and an explicit
`false` beats a wildcard. Cache this locally and gate screens from it so the
client shows an upsell rather than discovering a 402.

### 4.3 Outlets, counters, members, devices

| Method         | Path                      | Purpose                                                        |
| -------------- | ------------------------- | -------------------------------------------------------------- |
| GET / POST     | `/outlets`                | Branches. Each may hold its own GSTIN and state code           |
| PATCH / DELETE | `/outlets/:id`            | The `code` cannot change once a series prints it               |
| GET / POST     | `/counters`               | Tills. `?outletId=` filters                                    |
| PATCH / DELETE | `/counters/:id`           |                                                                |
| GET / POST     | `/members`                | Staff. Adding one counts against the user quota                |
| PATCH / DELETE | `/members/:id`            | Role, outlet scope, active state. Last owner cannot be removed |
| GET            | `/devices`                | Registered devices, with each one's sync position              |
| PATCH          | `/devices/:id`            | Relabel, or bind to an outlet/counter                          |
| POST           | `/devices/:id/deactivate` | Revokes its tokens immediately                                 |

A member's `outletIds` is `null` for "every outlet", or an array confining them
to specific branches. The server enforces this on every outlet-scoped route.

### 4.4 Catalogue

| Method         | Path                         | Purpose                                                                                      |
| -------------- | ---------------------------- | -------------------------------------------------------------------------------------------- |
| GET / POST     | `/categories`                | Hierarchical; `parentId` nests them                                                          |
| PATCH / DELETE | `/categories/:id`            | Delete refused while items reference it                                                      |
| GET            | `/items`                     | `?q=` fuzzy across name, code and aliases; `?categoryId=`, `?itemType=`, `?includeInactive=` |
| GET            | `/items/by-barcode/:barcode` | The scan path. Resolves to exactly one live item                                             |
| GET / POST     | `/items`                     | Create counts against the item quota                                                         |
| PATCH / DELETE | `/items/:id`                 | Passing `barcodes` **replaces the whole set**                                                |

An item carries `hsnCode`, `taxRatePercent`, `cessRatePercent`, `unit`, `mrp`,
`salePrice`, `purchasePrice`, `pricesIncludeTax`, `trackStock`, `reorderLevel`,
`aliases` (lower-cased alternate names — "kanda" finds Onion) and `barcodes`.
Service items (`itemType: "service"`) cannot track stock.

### 4.5 Customers and khata

| Method               | Path                    | Purpose                                                              |
| -------------------- | ----------------------- | -------------------------------------------------------------------- |
| GET                  | `/customers`            | `?q=` matches name or phone                                          |
| GET / POST           | `/customers`            | `openingBalance` carries over a paper khata; positive means they owe |
| GET / PATCH / DELETE | `/customers/:id`        | Delete refused while the balance is non-zero                         |
| GET                  | `/customers/:id/ledger` | The khata statement, with a running balance per entry                |

`balance` on a customer is a trigger-maintained projection — positive means the
customer owes the shop, negative is an advance held. **Never recompute it on the
client**: the till must show the figure the server would.

### 4.6 Document numbering — the offline billing mechanism

| Method     | Path                           | Purpose                                                       |
| ---------- | ------------------------------ | ------------------------------------------------------------- |
| GET / POST | `/numbering/series`            | A series per (outlet, counter, document type, financial year) |
| POST       | `/numbering/series/:id/leases` | Reserve a contiguous block of numbers for **this device**     |
| GET        | `/numbering/leases`            | Blocks this device currently holds                            |
| GET        | `/numbering/series/:id/gaps`   | Reserved-but-unused numbers, for GSTR-1 Table 13              |

This is how a till bills with no network, and it is the product's headline
differentiator, so it is worth understanding:

1. While online, the device calls `POST …/leases` and receives a block:
   `{ id, seriesId, startSeq, endSeq, consumedUpTo, expiresAt }`, plus the
   series with its `format`, `financialYear`, `maxSequence` and `maxLength`.
2. Offline, the device takes the next number from the block **in the same local
   transaction as the invoice**, and renders the document number itself with the
   ported `formatDocumentNumber`.
3. On upload, the server checks the number came from a block leased to that
   device (`NUMBER_NOT_LEASED` otherwise) and marks it consumed.

A database exclusion constraint makes overlapping blocks impossible, so no two
tills can ever print the same invoice number. Unused numbers in an expired block
are reported as gaps and never reissued.

Series creation validates the format against **the highest number it will ever
print**, so a format cannot work in April and overflow in November.

### 4.7 Invoices

| Method | Path                       | Purpose                                                  |
| ------ | -------------------------- | -------------------------------------------------------- |
| GET    | `/invoices`                | `?from=&to=&status=&customerId=&outletId=`, keyset paged |
| GET    | `/invoices/:id`            | Header, lines and tenders                                |
| POST   | `/invoices`                | Issue (usually an upload of a bill made offline)         |
| POST   | `/invoices/:id/void`       | Void with a reason                                       |
| POST   | `/invoices/:id/printed`    | Record a print                                           |
| GET    | `/invoices/:id/returnable` | Per-line quantities still returnable                     |

**`POST /invoices`** is the most important call in the product. Body:

```jsonc
{
  "id": "<uuid v7>",
  "outletId": "…",
  "counterId": "…",
  "seriesId": "…",
  "sequenceNo": 42, // from a block this device holds
  "documentDate": "2026-06-14", // calendar date, no timezone
  "issuedAt": "2026-06-14T18:42:11+05:30", // device clock at billing
  "customerId": null,
  "placeOfSupplyStateCode": "27",
  "pricesIncludeTax": true,
  "roundOff": true,
  "lines": [
    {
      "id": "<uuid>",
      "itemId": "…",
      "quantity": 2000,
      "unitPrice": 4500,
      "taxRatePercent": 18,
      "discount": { "kind": "percent", "value": 5 },
    },
  ],
  "billDiscount": { "kind": "amount", "value": 1000 },
  "additionalCharges": [{ "id": "c1", "label": "Delivery", "amount": 5000, "taxable": false }],
  "payments": [{ "id": "<uuid>", "mode": "cash", "amount": 9500, "tenderedAmount": 10000 }],
  "customFields": { "Vehicle no": "MH12AB1234" },
  "expectedTotals": { "grandTotal": 9500, "totalTax": 1449, "taxableAmount": 8051 },
}
```

`expectedTotals` is the device's own computation. The server runs the same tax
engine and rejects disagreement with `TOTALS_MISMATCH` — that is a bug on one
side, never a user error. Whatever is not covered by `payments` becomes a khata
balance, which requires a customer.

Void keeps the number (GST requires the series to account for it) and writes
reversing stock and ledger entries. An invoice with collected receipts against
it must have those voided first.

### 4.8 Payments

| Method | Path                 | Purpose                                               |
| ------ | -------------------- | ----------------------------------------------------- |
| GET    | `/payments`          | `?customerId=`                                        |
| GET    | `/payments/:id`      | With its allocations                                  |
| POST   | `/payments`          | A khata receipt, optionally allocated across invoices |
| POST   | `/payments/:id/void` | Only receipts; tenders are voided with their invoice  |

A receipt credits the customer's ledger. `allocations: [{ invoiceId, amount }]`
settles specific bills; anything unallocated stays as an advance. Over-allocating
an invoice answers `OVERPAYMENT`.

Payment `kind` is one of `invoice_tender` (taken at billing), `receipt`
(collected later) or `refund` (paid out against a credit note).

### 4.9 Credit notes and returns

| Method | Path                        | Purpose                                       |
| ------ | --------------------------- | --------------------------------------------- |
| GET    | `/credit-notes`             | `?originalInvoiceId=` among the usual filters |
| GET    | `/credit-notes/:id`         | With lines and the refund payment, if any     |
| POST   | `/credit-notes`             | Issue a return against an invoice             |
| POST   | `/credit-notes/:id/void`    | Reverses stock, khata and refund together     |
| POST   | `/credit-notes/:id/printed` |                                               |

Flow: call `GET /invoices/:id/returnable` for per-line `returnableQuantity`, let
the user pick, then post lines of `{ id, invoiceLineId, quantity }`. Prices,
rates and discounts are **derived from the original line** by the shared
`deriveReturnLine` rule — the client does not send them.

- `reasonCode`: `return | damaged | wrong_item | price_correction | quality | other`
- `refundMode`: `khata` credits the ledger; any tender mode pays money out now
- `restock`: defaults to true except for `damaged`
- Needs its own `credit_note` series and a leased block, exactly like an invoice
- Requires the `credit_notes` plan feature

### 4.10 Stock

| Method | Path                 | Purpose                                                         |
| ------ | -------------------- | --------------------------------------------------------------- |
| GET    | `/stock/balances`    | `?outletId=` required; `?belowReorder=true` for the buying list |
| GET    | `/stock/ledger`      | Movement history for one item at one outlet                     |
| POST   | `/stock/adjustments` | Manual correction with a reason code                            |

Stock is an append-only ledger; `stock_balances` is a trigger-maintained
projection. Reason codes: `damage`, `theft`, `expiry`, `count_correction`,
`opening`, `other`. Unlike a synced sale, an adjustment is made online, so the
tenant's negative-stock rule is enforced rather than warned about.

### 4.11 Counter operations

| Method         | Path                       | Purpose                                                         |
| -------------- | -------------------------- | --------------------------------------------------------------- |
| GET            | `/held-bills`              | Bills parked at a counter. `?outletId=&counterId=`              |
| GET            | `/held-bills/:id`          |                                                                 |
| PUT            | `/held-bills`              | Park a bill, or update one already parked                       |
| POST           | `/held-bills/:id/release`  | `{ outcome: "billed" \| "discarded", invoiceId? }`              |
| GET / POST     | `/expenses/categories`     | `isDirect` puts a category above the gross-margin line          |
| PATCH / DELETE | `/expenses/categories/:id` |                                                                 |
| GET / POST     | `/expenses`                | Cash expenses reduce the drawer and the day-close expectation   |
| GET            | `/expenses/:id`            |                                                                 |
| POST           | `/expenses/:id/void`       | Expenses are immutable; a correction is a void plus a new entry |
| GET            | `/day-close/expected`      | What the drawer should hold **right now**                       |
| GET / POST     | `/day-close`               | List, or close the day                                          |
| GET            | `/day-close/:id`           |                                                                 |

**Held bills.** The server stores the device's draft verbatim in `payload` and
never interprets it — a parked bill is not a document, and a second
implementation of the same draft would eventually disagree with the first. Send
`lineCount` and `estimatedTotal` alongside so the list screen renders without
parsing every draft. Idempotent on the draft id, which stays the same while the
cashier keeps adding lines. Capped per counter (`HELD_BILL_LIMIT_REACHED`).

**Day close.** `GET /day-close/expected` computes
`opening float + cash tenders + cash receipts − cash refunds − cash expenses`
over the window since the last close, in the shop's own timezone. Read it
immediately before counting; it moves with every sale. `POST /day-close` stores
what was **expected** as well as what was counted, so a day closed on Tuesday
still reads correctly after Wednesday's void changes the arithmetic. A variance
beyond the tolerance comes back as a `CASH_VARIANCE_EXCEEDED` warning, never a
rejection — the money is already whatever it is.

### 4.12 Reports

| Method | Path                 | Purpose                                                  |
| ------ | -------------------- | -------------------------------------------------------- |
| GET    | `/reports`           | The catalogue, with `locked` and `restricted` per report |
| GET    | `/reports/:reportId` | Run one                                                  |

**One envelope for every report**, so a single widget renders all of them and
CSV export is generic:

```jsonc
{
  "data": {
    "reportId": "sales-summary",
    "title": "Sales summary",
    "columns": [{ "key": "netSales", "label": "Net", "kind": "money", "total": true }],
    "rows": [{ "date": "2026-06-14", "netSales": 1234500 }],
    "totals": { "netSales": 1234500 },
    "truncated": false,
    "generatedAt": "…",
    "params": { "from": "2026-06-01", "to": "2026-07-01", "outletId": null },
  },
}
```

`kind` carries the formatting rule: `money` (paise), `quantity` (thousandths),
`number`, `percent`, `date`, `datetime`, `text`. `secondary: true` means hide it
on a phone. `totals` is summed over the rows returned, so the footer always adds
up to what is shown. `params.to` is **exclusive**.

Query parameters: `outletId`, `from`, `to` (inclusive calendar dates),
`customerId`, `categoryId`, `itemId`, `limit`. Each report declares which it
accepts in `filters`.

The thirteen reports: `day-book`, `sales-summary`, `item-wise-sales`,
`category-wise-sales`, `payment-mode-split`, `bill-register`, `current-stock`,
`low-stock`, `stock-movement`, `customer-outstanding`, `khata-statement`,
`expense-summary`, `daily-pnl`.

`locked` means the plan does not include it — render an upsell rather than
running it. `restricted` means the role may not (P&L needs `reports:financial`,
which a cashier does not have). `khata-statement` requires a `customerId`.

Daily P&L costs goods at each item's **current** purchase price and says so in
its description; real cost arrives with purchase bills in M11.

### 4.13 Sync

| Method | Path                          | Purpose                                         |
| ------ | ----------------------------- | ----------------------------------------------- |
| GET    | `/sync/changes?since=&limit=` | Everything that changed after a sequence number |
| POST   | `/sync/push`                  | Upload queued offline operations                |
| GET    | `/sync/state`                 | This device's cursor and the entity catalogue   |

**Pull.** One tenant-wide `serverSeq` orders every table, so one integer cursor
covers the lot. Response:

```jsonc
{ "data": {
  "changes": [{ "entity": "items", "op": "upsert", "serverSeq": 4211, "row": { … } }],
  "nextSince": 4211, "hasMore": true,
  "leases": [ … ],              // blocks topped up during this pull
  "serverTime": "2026-06-14T13:12:11.000Z"
} }
```

Rules the client must follow:

1. Apply a page in **one local transaction**, and only then store `nextSince`.
   Advancing early means a lost response skips changes permanently.
2. Upsert by key where `incoming.serverSeq > local.serverSeq`; honour
   `deletedAt` by marking the row deleted, not by removing it.
3. Keep paging while `hasMore`.
4. Upsert any `leases` — this is how a till that has been offline for days gets
   more numbers, and how it survives the 1 April financial-year rollover (the
   server pre-creates and pre-leases next year's series inside a lead window).
5. `serverTime` gives you the clock skew; warn the user past a few minutes,
   because `issuedAt` is device time.

Entities in the feed: tenants, outlets, counters, memberships, subscriptions,
categories, items, item_barcodes, customers, customer_balances, document_series,
invoices, invoice_lines, credit_notes, credit_note_lines, payments,
payment_allocations, customer_ledger_entries, stock_ledger_entries,
stock_balances, held_bills, expense_categories, expenses, day_closes.

**Push.** Send up to `SYNC_PUSH_MAX_OPERATIONS` operations in outbox order:

```jsonc
{ "operations": [
  { "opId": "<uuid v7>", "type": "invoice.create", "payload": { … }, "baseServerSeq": 4109 }
] }
```

It **always answers 200**; the per-operation status is the contract:

```jsonc
{
  "data": {
    "results": [
      { "opId": "…", "type": "invoice.create", "status": "applied", "id": "…", "serverSeq": 4212 },
      {
        "opId": "…",
        "type": "customer.update",
        "status": "rejected",
        "retryable": false,
        "error": { "code": "STALE_WRITE", "details": { "currentServerSeq": 4200 } },
      },
    ],
  },
}
```

- `applied` — done. `replayed` — the server already had it; also done.
- `rejected` + `retryable: true` — leave it queued and try later.
- `rejected` + `retryable: false` — it can never succeed as sent. Surface it to
  the user; do not loop on it.

Each operation runs in its own transaction, so one bad invoice in a batch of two
hundred does not roll back the other 199. **Do not send an `Idempotency-Key`
header** — `opId` and the entity ids are the idempotency keys, and a
header-scoped cache would make a partly failed batch non-retryable.

Operation types: `invoice.create|void|printed`, `credit_note.create|void|printed`,
`payment.create|void`, `customer.create|update`, `item.create|update`,
`category.create|update`, `stock.adjust`, `held_bill.upsert|release`,
`expense.create|void`, `day_close.create`.

### 4.14 Audit and health

| Method | Path       | Purpose                                                       |
| ------ | ---------- | ------------------------------------------------------------- |
| GET    | `/audit`   | Who changed what, when. Filters by entity, action, user, time |
| GET    | `/healthz` | Liveness; touches no dependency                               |
| GET    | `/readyz`  | Fails only on Postgres; Redis is reported but not required    |
| GET    | `/metrics` | Prometheus, when enabled                                      |

Health routes sit outside `/v1` and outside authentication.

---

## 5. The Flutter side

Repo: `flutter-app`, branch `frontend`. The app lives at the repo root; the
platform projects (`android/`, `ios/`, `macos/`, `windows/`) were kept rather
than regenerated, because their permissions, plists and entitlements are correct.

### 5.1 Packages

| Package                       | What it is                                                                                                         | Depends on Flutter |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------ |
| `packages/khata_domain`       | Money, the GST tax engine, document numbering, contract enums. A port of the server's pure domain code             | No                 |
| `packages/khata_api`          | Dio client: request ids, single-flight refresh, retry policy, envelope and error mapping, typed endpoints and DTOs | No                 |
| `packages/khata_printing`     | `PrintDocument` → ESC/POS bytes or a text preview, through one composition pass                                    | Yes                |
| `packages/khata_printing_ble` | Bluetooth transport implementing `PrinterTransport`                                                                | Yes                |

**`khata_domain` is the important one.** It mirrors `src/lib/money.ts`,
`src/domain/tax/engine.ts`, `src/domain/tax/returns.ts` and
`src/domain/numbering/series.ts` so the device computes byte-identical totals
and document numbers offline. Parity traps that are already handled, and that
anyone editing it must preserve:

- `distribute` (largest-remainder apportionment) relies on a **stable** sort.
  JavaScript's is; Dart's is not, so the Dart version sorts by
  `(fraction desc, index asc)` explicitly.
- Every intermediate is computed in `double` then rounded once, matching
  JavaScript's single number type. Exact integer maths would be _more_ accurate
  and therefore _wrong_, because it would disagree with the server.
- Rounding is half away from zero, so a credit note reverses its invoice exactly.

Agreement is provable: `contracts/tax-vectors.json` and
`contracts/numbering-vectors.json` in the backend are generated from the engine
(`npm run contracts:generate`), and a unit test fails when they go stale. The
Dart parity test that consumes them is **not written yet**.

### 5.2 The app

```
lib/
  app/            MaterialApp, router, theme tokens
  core/
    auth/         SecureSessionStore — tokens, device key, database key
    db/           drift database: mirror tables, outbox, number blocks
    env/          Flavor and build-time configuration
    logging/      One Log facade
    providers.dart
  features/
    auth/         Sign-in, OTP, choose-business, AuthController
    onboarding/   Create business
    shell/        The five-tab shell
  shared/widgets/ ErrorView and friends
l10n/             ARB files: en, hi, mr, gu
env/              dev.json, staging.json, prod.json
```

**What works today:** phone → OTP → choose or create a business → a session,
with tokens in the platform keystore. The router's single redirect decides the
screen from the auth state, so a deep link cannot skip sign-in and a revoked
session cannot leave someone on the billing screen. The Android debug APK builds.

**The local database** (`lib/core/db/`) has mirror tables for what the server
owns plus three client-only tables that make offline billing work:

- `sync_state` — the cursor, `bootstrapDone`, clock skew.
- `outbox` — operations written offline. A write mutates the mirror and appends
  here in **one transaction**, so what the cashier sees and what will be
  uploaded can never disagree.
- `number_blocks` — leases, with `consumedUpTo`.

Encrypted with SQLCipher on Android, iOS and macOS. Windows and Linux have no
bundled library and open unencrypted, and the code logs that rather than
implying otherwise. `sqlcipher_flutter_libs` and `sqlite3_flutter_libs` **cannot
both be dependencies** — they ship the same Android plugin class.

**Not built yet on the client:** the sync engine and outbox drain, the catalogue
and customer screens, the billing screen, printing wired to a real document,
reports, the app lock, background sync, and any test beyond the fourteen ESC/POS
engine tests that moved into `khata_printing`.

### 5.3 Running it

```bash
flutter pub get
dart run build_runner build          # drift codegen, after changing lib/core/db/tables.dart
flutter run --flavor dev --dart-define-from-file=env/dev.json
flutter analyze lib
```

`env/dev.json` points at `http://10.0.2.2:3000/v1`, which is the Android
emulator's route to a `npm run dev` on the host. The API URL is compiled in, not
read from the device: an app whose backend could be edited on a phone is an app
that can be pointed at someone else's server.

---

## 6. Backend conventions (for anyone editing it)

- **Module layout**: `src/modules/<name>/<name>.{routes,service,repository,schemas,openapi}.ts`.
  Routes: permission check → `validate()` → service → envelope. Services own
  transactions, cross-module rules, `recordAudit` and metrics. Repositories own
  SQL and alias columns `AS "camelCase"`.
- **Database access only through `src/db/tx.ts`**. It sets tenant context with
  `set_config(..., true)` per transaction. A session-scoped `SET` leaks across
  tenants on a transaction-mode pooler — this was observed, not theorised.
- **New tenant tables** call `app.setup_tenant_table()` (forced RLS, policy,
  `server_seq`, `updated_at`, sync index). Immutable documents add
  `app.guard_document_update(...)`; append-only ledgers add `restrict_table`.
  Every migration ends with `SELECT app.grant_runtime_privileges();`.
- **Configuration**: only `src/config/env.ts` may read `process.env`
  (lint-enforced). Every variable is required, with no in-code defaults. A new
  one goes into `env.ts`, `.env.example` and `tests/fixtures/env.ts` together.
- **Error codes are additive only.** Installed apps branch on them and cannot be
  force-updated.
- **Anything a device can call offline must be replay-idempotent on a client
  UUID** before it is registered as pushable.

Migrations applied: `0001_foundation` · `0002_tenancy` ·
`0003_catalogue_customers` · `0004_billing_stock` · `0005_hardening` ·
`0006_sync` · `0007_credit_notes` · `0008_operations`.

---

## 7. Decisions already made — do not re-litigate

1. **No server-side PDF.** The server returns a resolved print payload as JSON;
   Flutter renders ESC/POS and PDF locally.
2. **Sync**: one tenant-wide `server_seq` watermark; push dispatches to the
   existing module services and holds no business logic of its own; one
   transaction per operation; optimistic concurrency via `baseServerSeq`.
3. **Credit notes have their own tables**, not a discriminator on `invoices`.
4. **Reports**: one kernel and registry behind `GET /reports/:reportId`. Never a
   generic query endpoint — it would be an RLS-bypass surface and would make the
   plan gate unenforceable.
5. **Print**: layouts live in code; template selection, overrides, custom-field
   definitions and the print profile live in the database. Custom field _values_
   are write-once JSONB on the document.
6. **OTP delivery is pluggable.** The vendor will change; a swap is one file
   under `src/modules/auth/delivery/providers/` plus env. See
   `docs/ADDING_A_DELIVERY_PROVIDER.md`.
7. **No vertical-specific module.** What was going to be a pharmacy add-on
   becomes generic per-item tracking modes (none / batch+expiry / serial),
   available to every tenant.
8. **SQLCipher** for the device database.
9. **Two parallel tracks.** Each Flutter milestone consumes only backend surface
   that already exists, which is why the client's outbox transport is swappable
   from REST to `/sync/push`.

---

## 8. Known debts

1. `JWT_SECRET` is a placeholder in `.env.development`; production boot is
   blocked until it is replaced.
2. Development and integration tests still share one Supabase project, and the
   integration suite **truncates every table**. Split them before this database
   holds anything worth keeping.
3. CI secrets are not configured, so the `integration` job cannot pass.
4. No Dart parity test against the contract vectors yet — the most valuable test
   in the project and the one that proves offline billing is safe.
5. No integration tests for anything after M2 (sync, credit notes, operations,
   reports are covered by typecheck and review only).
6. The OpenAPI document has no route-coverage test, so it can rot.
7. Desktop (Windows/Linux) has no SQLCipher and no bundled SQLite.
8. Nothing is pushed: backend on `phase1`, Flutter on `frontend`.

---

## 9. Commands

**Backend**

```bash
npm run dev                  # watch mode, loads .env.development
npm run check                # typecheck + lint + unit tests
npm run format:check         # CI gate
npm run migrate              # apply pending migrations
npm run migrate:status
npm run db:bootstrap         # create the app role, revoke Data API grants
npm run test:integration     # against TEST_DATABASE_URL — TRUNCATES IT
npm run contracts:generate   # rewrite contracts/*.json after an engine change
```

Setup order on a fresh database: `migrate` → `db:bootstrap` → `dev`.

**Flutter**

```bash
flutter pub get
dart run build_runner build
flutter analyze lib
flutter test                                   # inside packages/khata_printing
flutter run   --flavor dev --dart-define-from-file=env/dev.json
flutter build apk --flavor dev --dart-define-from-file=env/dev.json
```
