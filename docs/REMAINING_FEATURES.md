# Features built after the P0 set

Eight features in two passes, each a complete vertical slice. This document
explains what they do, why they are shaped the way they are, and the handful of
rules you cannot break without quietly corrupting data.

- **Part one (§1–7)** — print payloads, bulk import, export and barcode labels,
  purchases and costing, object storage.
- **Part two (§8–15)** — returns and numbering gaps, named plans, supply
  classification, price lists and discount caps, GST returns and GSTR-2B
  reconciliation, and the reports expansion to 39.

For the endpoint list, see [ENDPOINTS.md](ENDPOINTS.md). For the system's
general conventions, see [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md).

| Area            | Migration                                  | Modules                                                         | Pure domain      |
| --------------- | ------------------------------------------ | --------------------------------------------------------------- | ---------------- |
| Print payloads  | `0009_print.sql`                           | `modules/print`                                                 | `domain/print`   |
| Bulk import     | `0010_imports.sql`                         | `modules/imports`, `modules/uploads`                            | `domain/import`  |
| Export + labels | —                                          | `modules/exports`                                               | `domain/labels`  |
| Purchases       | `0011_suppliers.sql`, `0012_purchases.sql` | `modules/suppliers`, `modules/purchases`, `modules/debit-notes` | `domain/costing` |

---

## 1. Print payloads, templates and custom fields

### The problem

`src/domain/print/` could already turn a stored document into a payload a
device prints, but nothing called it. The client therefore had to decide
what a bill says — which means the legally required strings (TAX INVOICE
versus BILL OF SUPPLY, the CGST §10(5) composition declaration) depended on
which build a till happened to be running. Getting those wrong is a
compliance problem, not a rendering bug.

### How it works

`GET /v1/invoices/:id/print-payload` returns a finished `PrintDocument`:
every string formatted, every total computed, every custom field labelled
and ordered. **The renderer performs no arithmetic, consults no locale and
looks nothing up.** The same contract serves a 58 mm thermal printer and an
A4 PDF, because it describes the document and not its layout.

Three things the service deliberately does _not_ recompute:

- **`taxMode` and `supplyType`** come from the stored document. Re-deriving
  them from today's settings would rewrite history if the business later
  registered for GST or the outlet moved state.
- **Customer name and GSTIN** come from the invoice's own snapshot columns,
  not the live customer row, so a bill reprinted years later is identical to
  the one handed over at the counter.
- **Voided tenders** are filtered out. Money that was reversed is not money
  the shop holds.

### Configuration

`print_profiles` holds branding, bank lines, terms, UPI ID and the template
choice. One row per outlet, plus a tenant-wide default (`outlet_id IS NULL`).
**Inheritance is field by field**, so a chain that sets one branch's GSTIN
does not thereby lose the terms and conditions configured once for every
branch. The five template override booleans are nullable on purpose: `NULL`
means "inherit the template's own decision", so a profile written before a
template gained a flag keeps working.

`custom_field_definitions` gives `invoices.custom_fields` a schema at last.
Before this, the JSONB bag accepted any key with no label, no ordering and
no validation. Now:

- the **invoice and credit-note write paths validate** the bag before it
  becomes part of an immutable document (`modules/print/custom-fields.ts`);
- the **print path** orders fields by `sort_order` and labels them from the
  definition;
- **a key whose definition was later deleted still prints**, labelled from a
  humanised form of the key. Silently dropping a vehicle number or PO number
  from a reprinted legal document is exactly what an auditor asks about.

The `key` is immutable once created — it is already written into issued
documents, and renaming it would orphan every one of them. Deletes are soft
for the same reason.

### Known limitation: receipt numbers

`payments` has no series or document number. `payment_receipt` exists in the
`document_series` enum but nothing issues against it, so a receipt is
identified by `RCPT-<8 hex of the payment id>`. It is unique and stable
across reprints, and honest about being an internal reference rather than a
numbered legal document. Giving receipts a real series is a schema change.

---

## 2. Bulk import

### The problem

A shop arriving with an existing price list will not retype 500 items. This
is the onboarding blocker, and the real design question is not "how do we
parse xlsx" but "what happens to a 20,000-row file on a phone with a bad
connection".

### Three resumable phases

```
POST /v1/imports                 create job, get a signed upload URL
  (client PUTs the file straight to Supabase)
POST /v1/imports/:id/ingest      stream the file once, store every row raw
POST /v1/imports/:id/analyse     validate + match + diff a chunk    ← loop until done
GET  /v1/imports/:id/rows        review the diff
POST /v1/imports/:id/apply       write a chunk, one transaction     ← loop until done
```

**Why ingest is separate from analyse.** A chunked dry-run would have to
re-open and skip through the spreadsheet on every call — quadratic in the
number of chunks. Reading cells is cheap; the per-row database work
(matching against existing items, diffing) is what costs. So the file is read
exactly once and only the database-bound work is chunked.

**Why the client drives the loop.** There is no worker process. All state
lives in `import_jobs`, so when M9 introduces a worker it can drive the same
endpoints with no API change. The cost is that progress depends on a client
that stays awake — mitigated by `last_progress_at` and the `analysing` /
`applying` statuses, which let `GET /v1/imports` surface a job someone
abandoned.

### The rules that matter

- **Only columns the file supplies are compared.** A price list with no HSN
  column must not be read as "clear every HSN code". This is the single most
  important behaviour in the diff.
- **Matching is `code` → barcode → case-insensitive name**, first hit wins,
  and the rule is recorded in `match_rule` so the review screen can explain
  _why_ a row is an update.
- **Two rows claiming one existing item is an error row, not last-write-wins.**
  Enforced in memory within a chunk and by a partial unique index across the
  whole job; the in-memory set is seeded from earlier chunks so a duplicate
  straddling a chunk boundary is flagged rather than failing the chunk.
- **`NUMERIC` comes back from `pg` as a string.** `tax_rate_percent` is
  `"18.000"` while the spreadsheet parses to `18`. Comparison is typed, not
  stringified — otherwise every re-import reports 500 fake updates.
- **Barcodes are additive on update.** A shop's own barcode and a
  manufacturer's often coexist; an import must not drop one that is on a shelf.
- **Concurrency**: ingest records a `catalogue_fingerprint`; every apply
  chunk re-checks it and answers `IMPORT_STALE` if the catalogue moved.
  Re-validating every row at apply time would double the work and still race.

### Apply is chunked, so partial application is possible

Each chunk commits on its own. A client that walks away leaves the job in
`applying` with `applied_up_to_row` set, and calling apply again resumes.
This is safe because every row is an idempotent upsert keyed on `target_id`
and guarded by a per-row `applied_at`. A catalogue import is not a financial
document — half the items existing is untidy, not incorrect.

`cancel` is refused once any row has been applied, because it performs no
undo and should not imply one.

### Why ExcelJS, and why not its streaming reader

`exceljs` reads `.xlsx` and `.csv` and writes styled workbooks, so one
dependency serves both import and export. SheetJS's npm channel is no longer
the maintained one.

Its **streaming reader is unusable**: `WorkbookReader` resolves a sheet name
through `this.model.sheets` (`workbook-reader.js:303`) but guards only on
`sharedStrings && workbookRels` (`:108`), so when the zip yields a worksheet
before `xl/workbook.xml` it throws on an undefined model. That ordering is
exactly what ExcelJS's own writer produces. Its fallback path also spools
worksheets to temp files on disk. So the whole workbook is loaded and the
memory ceiling is held by the upload cap instead (10 MB for `import`). If
that ever binds, the answer is a worker with its own memory budget, not a
different parser.

---

## 3. Export and barcode labels

### Export

`POST /v1/exports` generates an `.xlsx`, stores it, and returns a short-lived
`downloadUrl`. Keep the `objectKey`: the URL expires, the key does not, and
`GET /v1/uploads/url` re-signs it.

**The items export is round-trippable.** Its columns are built from
`ITEM_COLUMNS` — the importer's own definitions — rather than restated, so
export → edit in Excel → import back works by construction. Two tests hold
this: one asserts the header lists agree, the other builds a real workbook,
reads the bytes back through the importer's parser and checks 1050 paise
comes back as 1050 paise.

**Opening stock is deliberately not exported.** It is an import-time
instruction, not a fact; a column that re-applies an opening balance on
every re-import is a quiet way to corrupt stock.

### Barcode labels

`POST /v1/labels/payload` returns label _data_, not images: pre-formatted
strings, a barcode value, a chosen symbology, and the stationery's
dimensions in millimetres. The client renders. Generating PDFs server-side
would need a barcode renderer and a PDF engine in the API and still would
not drive an ESC/POS label printer, which takes commands rather than pages.

**Symbology is chosen, not assumed.** A numeric value is `ean13`, `upca` or
`ean8` only when its **check digit validates**; anything else falls back to
`code128`. Many shops use 13-digit internal codes that are not valid EAN, and
a renderer handed `ean13` for one either throws or silently "corrects" the
last digit — printing a label that scans as a different product. Code 128
encodes the exact characters, so the scanner always returns what was stored.

**"MRP" is only printed when the value really is a declared MRP.** Asking for
MRP on an item that has none falls back to the sale price, but the prefix is
dropped with it. Maximum Retail Price is a declaration under the Legal
Metrology Act, not a synonym for "the price", and this goes on a sticker
attached to a physical packet.

An item with neither a barcode nor an item code is returned in `errors` with
its name, because printing a blank label wastes a sheet nobody can reuse.

---

## 4. Purchases, suppliers and costing

### The problem

The system only saw one side of the shop's trade. No real stock cost, no
payables, no reorder-to-purchase loop — and Daily P&L was costing goods at
the item's _current_ purchase price, which restates history every time a
buying price moves.

### Suppliers are separate from customers

A `suppliers` table mirroring `customers`, with its own ledger and balance
projection. Not a unified `parties` table: the two carry different fields
(credit limit versus payment terms and lead time), and merging them would
mean migrating every `customer_id` foreign key in invoices, payments and the
khata ledger — a destructive change to live sales data. A party who is both
is entered twice, which is the accepted cost.

> **The sign convention is inverted from the customer ledger.**
> On `supplier_ledger_entries`, **credit increases what the shop owes** and
> **debit reduces it**; `supplier_balances.balance` is `credit - debit`, and
> positive means money is owed out. The customer ledger is the other way
> round because a customer owing money is an asset. This is the single
> easiest thing in the module to get backwards.

### Costing: moving weighted average

One `avg_cost` per item per outlet in `item_costs`, updated on every receipt:

```
new_avg = (qty_on_hand × avg_cost + received_qty × effective_unit_cost)
          ÷ (qty_on_hand + received_qty)
```

`effective_unit_cost` is the supplier price, **plus** apportioned freight,
**minus** GST that will be reclaimed.

**Input tax credit decides whether tax is a cost.** A registered dealer
reclaims the GST on a purchase, so capitalising it would overstate COGS and
understate margin on every subsequent sale. A composition or unregistered
dealer never reclaims, so for them the tax _is_ part of the cost. The flag is
stored on the bill (`itc_eligible`) rather than re-derived, and the service
forces it false when the business is not a regular registered dealer.

**Freight apportionment** is by `value` (default, correct for mixed goods) or
`quantity` (correct for homogeneous bulk where the lorry charges by volume),
or `none` when freight is an expense rather than inventory cost. Shares are
computed with `distribute()` from `lib/money.ts` so they sum to exactly the
freight — rounding each share independently loses paise and leaves stock
valued at a figure that does not reconcile.

> ### ⚠ Cost must be applied before stock
>
> `lockCost` seeds a missing `item_costs` row's quantity from
> `stock_balances`, which a trigger maintains from the stock ledger. If the
> stock entries are written first, that seed already includes the goods
> arriving now — so the first purchase of an item blends the new cost against
> a pool of the same size held at zero, **halving the average**.
>
> Both `createPurchaseBill` and the debit-note path therefore run the cost
> loop _before_ `stockRepository.insertEntries`, and the void paths mirror it.
> There is a regression test in `domain/costing/costing.test.ts` that pins the
> arithmetic of both the broken and the correct ordering.

Only `trackStock` items are costed: a service has no inventory to value, and
giving it a cost quantity would make `item_costs` disagree with
`stock_balances` for a row nothing reconciles.

### The P&L fix

`invoice_lines.cogs_amount` records the moving average in force **at the
moment of sale**. Margin then reads a historical fact instead of being
recomputed against today's prices.

The column is nullable, and that is deliberate: rows written before costing
existed have no honest value, and reports must say "unknown" rather than
show a fabricated margin. `invoice_lines` forbids `UPDATE`, so it can never
be backfilled — correct, because any backfilled figure would be invented.
The Daily P&L report falls back to the old behaviour for those lines and
reports `costBasis` as `Estimated` on any day where it had to.

### Two honest limitations of weighted average

- **A receipt cannot be exactly un-done.** Once goods have been sold at the
  blended rate, reversing the receipt cannot restore the prior average
  because the sales consumed a cost that no longer exists anywhere. The
  reversal approximates and refuses to produce a negative cost.
- **History is not re-costed.** A bill entered late moves the average from
  now on; it does not retroactively change COGS already snapshotted onto
  earlier invoices.

Both are consequences of the method, not of this implementation. Re-costing
history needs FIFO layers.

### Documents

**Purchase bills carry both numbers**: the supplier's own
`supplier_invoice_no` (what the shopkeeper matches against the paper) and our
internal `document_number` from `document_series`. A unique index on
`(tenant, supplier, upper(trim(invoice_no)), fy)` is the double-entry guard —
re-keying the same bill is the commonest error in purchasing and silently
doubles both stock and the payable. The service checks it first so the error
names the existing document instead of being a generic duplicate-key
conflict.

**Bills are immutable.** They moved stock, moved cost and created a payable;
unwinding those after later sales have consumed the blended cost is not
something a correction screen can honestly do. Void and re-enter. A bill with
payments or debit notes against it must have those undone first.

**Numbering is allocated server-side** via `UPDATE ... RETURNING` on
`document_series.next_seq`, not leased to a device. Sales invoices lease
blocks because a till must number a bill offline; purchases are keyed in on a
connected screen, and an expired lease would report a false gap in the
series. A series is auto-provisioned on first use (`PB` / `DN` / `PO`), since
requiring numbering setup before the first purchase is a step with no
decision in it.

**Debit notes** are GST documents the shop _issues_, so unlike a purchase
bill they get a real series and appear in `app.issued_document_numbers` for
GSTR-1 Table 13. Purchase bills do not: their series is an internal
reference, and a gap in it is not a reporting matter. Returns price from the
original bill line, never the item master, so our note and the supplier's
credit note agree to the paisa. Stock leaves at the `effective_unit_cost` the
goods came in at.

### Permissions

`suppliers:read/write`, `purchases:read/create/void`,
`debit_notes:read/create/void`. **A cashier gets none of them** — a cashier
who can enter a purchase bill can inflate stock and create a payable, and
the supplier ledger is what the shop owes, not something a counter needs to
see. Accountant and viewer pick up the `:read` set automatically, because
`READ_ONLY` is derived from every permission ending in `:read`.

Everything is gated on the `purchases` entitlement feature.

---

## 5. Object storage

Supabase Storage, private bucket, reached over its REST API with `fetch`
(no SDK — it would be a large dependency and would tempt someone into using
it for Postgres, walking around the RLS discipline in `src/db/tx.ts`).

**No file byte transits this API.** The server mints short-lived signed URLs
and the client uploads straight to Supabase. Proxying multipart through
Express would cost a request's worth of memory per megabyte and give a shop
on a flaky 4G connection no way to resume.

That moves the security boundary, so three things hold it in place:

1. Every key is `{tenantId}/{kind}/{uuid}.{ext}`, and
   `assertKeyBelongsToTenant` re-checks the prefix on the way back in. The
   key is the only thing a client hands us, so it is the only thing we can
   verify. Traversal (`..`, leading `/`, `//`) is rejected before the prefix
   test.
2. Content type and size are validated **at signing time**, because that is
   the last moment the server sees the request. Per kind: logo 2 MB and
   signature 1 MB (png/jpeg/webp — raster only, since an SVG on a document is
   a script-execution surface), receipt 5 MB (+pdf), import 10 MB
   (xlsx/csv). `export` objects are server-written and cannot be signed for
   upload.
3. TTLs are short and signing is rate limited on its own budget, because each
   signed URL is a writable handle on the bucket.

`sizeBytes` is what the client _claims_. It is checked because it is cheap,
but the real ceiling is the bucket's own file-size limit, which **must be
configured in Supabase to match `STORAGE_MAX_UPLOAD_BYTES`**.

---

## 6. Setting it up

```bash
# 1. Create a PRIVATE bucket in Supabase matching SUPABASE_STORAGE_BUCKET
#    (default: khata-private) and set its file size limit to
#    STORAGE_MAX_UPLOAD_BYTES (default: 10485760).
# 2. Put the real service_role key in SUPABASE_SERVICE_ROLE_KEY.
#    The checked-in placeholder deliberately contains "placeholder", so
#    env.ts refuses to boot with APP_ENV=production until it is replaced.

npm run migrate        # applies 0009–0012
npm run db:bootstrap   # REQUIRED: new tables are invisible to the
                       # least-privileged app role until this re-grants.
                       # Skipping it looks like "relation does not exist".
npm run check          # typecheck + lint + unit tests
```

### Configuration added

| Variable                                | Dev value       | Notes                                           |
| --------------------------------------- | --------------- | ----------------------------------------------- |
| `SUPABASE_URL`                          | project URL     |                                                 |
| `SUPABASE_SERVICE_ROLE_KEY`             | placeholder     | Secret. Never logged.                           |
| `SUPABASE_STORAGE_BUCKET`               | `khata-private` | Must be private.                                |
| `STORAGE_UPLOAD_URL_TTL_SECONDS`        | 900             | Longer than download: a phone on 4G needs time. |
| `STORAGE_DOWNLOAD_URL_TTL_SECONDS`      | 300             | A signed URL is a bearer credential.            |
| `STORAGE_MAX_UPLOAD_BYTES`              | 10485760        | Mirror this in the bucket settings.             |
| `STORAGE_REQUEST_TIMEOUT_MS`            | 15000           |                                                 |
| `IMPORT_MAX_ROWS`                       | 50000           | A sanity bound, not a capability limit.         |
| `IMPORT_ANALYSE_CHUNK_ROWS`             | 1000            | Must be ≤ `IMPORT_MAX_ROWS`.                    |
| `IMPORT_APPLY_CHUNK_ROWS`               | 5000            | Must be ≤ `IMPORT_MAX_ROWS`.                    |
| `IMPORT_JOB_TTL_HOURS`                  | 24              | Not yet enforced — see below.                   |
| `RATE_LIMIT_UPLOAD_SIGN_POINTS`         | 120             | Per tenant.                                     |
| `RATE_LIMIT_UPLOAD_SIGN_WINDOW_SECONDS` | 60              |                                                 |

---

## 7. Known gaps (part one)

- **No integration tests for any of these four features.** The unit tests
  cover the arithmetic — tax, costing, label symbology, column parsing — but
  not the transactions. The cases that most need a real database: the
  cost-before-stock ordering, concurrent purchases of one item racing on
  `lockCost`, resumed import apply writing each row exactly once,
  `IMPORT_STALE`, and RLS isolation on all ten new tables.
- **`IMPORT_JOB_TTL_HOURS` is configured but nothing sweeps.** Abandoned jobs
  stay visible in `GET /v1/imports` and their uploads are not purged. The
  sweeper belongs with M9's worker.
- **Logo and signature object keys are returned raw** in the print payload,
  by design — a URL expires and the printer may be offline. The client
  resolves them through `GET /v1/uploads/url`.
- **Payment receipts have no real document series** (§1).
- **`npm audit` reports `uuid@8.3.2`** (moderate) reached only through
  `exceljs`, which uses v4 without the affected `buf` argument. The
  `brace-expansion` finding predates this work and comes from eslint.

---

# Part two: pricing, discount caps, GST returns, reports

Four more features, in the order they were built. The first turned out to be
mostly done already, which changed what it was; the other three are new.

| Area                 | Migration                                                | Modules                 | Pure domain      |
| -------------------- | -------------------------------------------------------- | ----------------------- | ---------------- |
| Returns and numbering | `0014_returns_hardening.sql`                            | `modules/numbering`     | `domain/numbering` |
| Plans and entitlements | `0013_plans.sql`                                       | `modules/entitlements`  | —                |
| Supply classification | `0015_supply_classification.sql`                        | every document module   | `domain/tax`     |
| Pricing and discounts | `0016_pricing.sql`, `0017_price_list_items_soft_delete.sql` | `modules/price-lists` | `domain/pricing` |
| GST returns          | `0018_gst_returns.sql`                                   | `modules/gst`           | `domain/gst`     |
| Reports              | —                                                        | `modules/reports`       | —                |

---

## 8. Partial returns and credit-note numbering

### What was actually missing

The brief was "partial returns and their own credit-note numbering". Both
already worked: `credit_note_lines.quantity` is thousandths, the
returnable-quantity guard is a `FOR UPDATE OF l` subquery so two simultaneous
returns of one line cannot both pass, and `document_series` has always been
keyed by `(tenant, outlet, counter, document_type, fy_start_year)` with credit
notes requiring `documentType = 'credit_note'`.

What was missing was narrower and worse: **a shop could not issue its first
return at all.** Nothing provisioned a credit-note series, and a leased series
cannot be provisioned on first use the way a keyed one can — the device needs
both the series *and* a block on it before it goes offline.

### Series are now provisioned on first pull

`topUpLeasesForDevice` runs on every `/sync/changes` call and already topped up
blocks. It now also makes sure the device's outlet has an `invoice` and a
`credit_note` series for the current financial year and that the device holds a
block on each. A freshly registered device can bill and take returns with no
numbering setup step at all.

Three details that each fix a way this would otherwise have silently done
nothing:

- **Keyed on the document type, not the series id.** A shop numbering per
  counter has several invoice series, and a device holding a block on any of
  them can already bill — matching on ids would lease it a second one.
- **Falls back to the default outlet.** A device onboarded moments ago has no
  outlet binding: onboarding creates the device and the outlet in one
  transaction and does not link them. Without the fallback the bootstrap did
  nothing in exactly the case it exists for.
- **Never creates a series underneath an existing one.** A shop that chose
  counter-wise numbering must not find an outlet-wide series appearing beside
  it, so provisioning is a no-op when *any* series already issues that type for
  the outlet.

### `pickFittingFormat`, and a bug this exposed

GST rule 46(b) caps a document number at 16 characters. The obvious default —
prefix, outlet code, financial year, four digits — does not fit:
`INV/MAIN/26-27/0001` is nineteen.

`domain/numbering/series.ts` gained `pickFittingFormat`, a pure function that
drops segments in the order that keeps numbers unique for longest: the outlet
code outlives the financial-year segment, because losing it is the one change
that can make two branches of one GSTIN issue the same number, where a missing
year segment is only a readability problem. A single-outlet shop now gets
`INV/26-27/0001`, and the outlet code is only included when there is a second
branch to distinguish.

**This was already a live bug in purchases.** `purchases/numbering.ts` built
`PB/MAIN/26-27/0001` — eighteen characters — so the first purchase bill would
have failed for any shop with two outlets and a four-character outlet code.
Both paths now use the helper.

### Debit notes brought to credit-note parity

- `series_id` and `sequence_no` are **NOT NULL**, and
  `app.issued_document_numbers` no longer has to filter for an unnumbered debit
  note. That view is what GSTR-1 table 13 reads.
- **`restock` is persisted.** It was decided at creation and then forgotten,
  which left a void reversing stock that may never have moved — a damaged-goods
  return never left stock, so there is nothing to put back.
- **Registered in `SYNC_TABLES`**, pull-only. A supplier return is keyed in on a
  connected screen so the device never originates one, but it must *see* them,
  or a till shows stock the shop no longer has and a reorder suggestion built on
  it is wrong.
- `voided_by` added to the header column list, which `markVoid` had always
  written and nothing read back.

### One tax-engine fix folded in

`buildHsnSummary` silently skipped lines with no HSN code. A GSTR-1 HSN table
has to account for every rupee of the turnover declared above it, so a dropped
line is both a filing error and invisible. Un-coded lines now bucket under
`UNCLASSIFIED`.

> **This changed 279 of the 351 frozen tax vectors.** The arithmetic did not
> move — every pre-existing case produces identical totals, which was checked
> case by case — but the HSN summary now has a row the old one dropped. **The
> Dart port needs the same change**, or offline totals will diverge on any line
> without an HSN code, which is most of them.

---

## 9. Named plans, and gating that scales

### The problem

Plan grants came from `PLAN_FREE_FEATURES`, `PLAN_FREE_MAX_*` and — for
reports — `PLAN_FREE_REPORT_IDS`, a comma-separated list of report ids in the
environment. That shape cannot say which of three *priced* tiers a shop is on,
and an id list does not survive the jump from thirteen reports to thirty-nine.

`ReportDefinition.feature` had been declared since the reports kernel was
written and read by nothing.

### How it works

`src/modules/entitlements/plans.ts` is **the only file that changes when
pricing changes**. It holds one row per published plan, matching
`Billing_Software_Pricing.pdf`:

| Plan     | ₹/year | Devices | Adds                                                                               |
| -------- | ------ | ------- | ---------------------------------------------------------------------------------- |
| Trial    | 0      | 1       | Everything, 30 days                                                                |
| Lite     | 1,499  | 1       | GST billing, 58 mm printing, basic stock                                           |
| Standard | 2,999  | 2       | Full inventory, barcode scanning, **GSTR reports**, WhatsApp sharing                |
| Pro      | 5,999  | 3       | Multiple outlets, staff roles, e-invoice/e-way, batch/expiry or IMEI tracking       |

Note **`gst_workings` and `reports.all` sit at Standard**, because that is where
the price list sells "GSTR reports" — not at Pro.

Two things deliberately did *not* change:

- **`subscriptions.features` stays the runtime source of truth.** `plans.ts`
  *seeds* it; nothing re-reads the catalogue afterwards. An add-on (an extra
  device at ₹799, an extra outlet at ₹1,499) and a one-off support grant are
  per-tenant overrides that must survive a pricing change, and re-pricing an
  existing shop should be a deliberate act rather than a side effect of a
  deploy.
- **`hasFeature` resolution is untouched** — feature, then `group.*`, then `*`,
  with an explicit `false` beating a wildcard `true`, so a single feature can
  still be withheld from an otherwise all-inclusive plan.

Report gating moved onto the registry: each definition names the feature that
unlocks it, and a definition with no `feature` is in every plan. On Lite that
leaves exactly the five a single-counter shop needs to trade — day book, sales
summary, current stock, low stock, customer outstanding — and locks the other
thirty-four. `GET /v1/reports` still reports `locked` and `restricted` per
report, so the client shows an upsell instead of discovering a 402 after the
user has picked a date range.

### Development access

`PLAN_DEV_GRANT_ALL=true` grants every feature and lifts every quota, so the
whole paid surface — including all thirty-nine reports — is reachable in
development without seeding a subscription. It is registered in the
production-violation list `env.ts` checks, so **`APP_ENV=production` refuses to
boot with it set**, the same treatment `AUTH_DEV_BYPASS` gets.

`subscriptions` also gained `max_devices`, which is both a plan limit and a
paid add-on and so is stored per subscription rather than read off the plan
code. `devices` is now a quota resource alongside users, outlets, counters and
items.

---

## 10. Supply classification

### The problem

A line carried a tax rate and nothing else, so a zero-rate line was ambiguous
four ways: a taxable good notified at 0%, an exempt supply, a nil-rated one, or
one outside GST altogether. GSTR-1 table 8 and GSTR-3B table 3.1 report those
separately and **no amount of re-reading the rate recovers which was meant.**
The same gap covered reverse charge and exports and SEZ supplies, which a
two-value `supply_type` CHECK could not express at all.

### Why it landed before the returns, not with them

Issued documents are immutable. A classification missing today could never be
filled in, and every invoice raised in the meantime would have to be
reclassified by hand at filing time.

### What was added

- **`supply_category`** on `invoice_lines`, `credit_note_lines`,
  `purchase_bill_lines`, `debit_note_lines` and `items` —
  `taxable | exempt | nil_rated | non_gst`, defaulting to `taxable`.
- **`is_reverse_charge`** on all four document headers.
- **`supply_type`** widened with `export_with_tax`, `export_without_tax`,
  `sez_with_tax`, `sez_without_tax`.
- **`suppliers.registration_type`** (`regular | composition | unregistered`),
  plus indexes on `suppliers.gstin` and `purchase_bills.supplier_gstin` that
  2B matching needs and that did not exist.

### Rules that matter

- **Classification does not change arithmetic.** An exempt line computes the
  same zero tax it did before; the change is additive, and an unchanged payload
  produces byte-identical totals. That was verified against all 351
  pre-existing contract vectors.
- **Three independent reasons a document carries no tax**: the shop is not a
  regular registered dealer, the supply is zero-rated, or the recipient pays
  under reverse charge. Values are still reported in every case, and the line
  rates are retained — under reverse charge the *recipient* computes its
  liability from them.
- **Returns inherit, never re-derive.** A credit note takes the
  classification, supply type and reverse-charge flag from the invoice, and a
  debit note from the bill. GSTR-1 reports the pair together, so an exempt sale
  returned as a taxable credit would leave both tables wrong.
- **Resolution order on an invoice line** is the line, then the item, then
  `taxable`. The line wins because a till may know something the catalogue does
  not — the same good sold exempt to one buyer and taxable to another.
- **`ADD COLUMN ... DEFAULT` is metadata-only** in PostgreSQL 11+, so none of
  this rewrote a table or fired the `server_seq` trigger. Re-stamping
  `invoice_lines` would have burned one sequence value per line against the
  single per-tenant counter and republished the shop's whole sales history to
  every device.

---

## 11. Price lists, bulk revision, discount caps

### The problem

One selling price per item, and a cashier free to discount it to anything.
Those are the same problem seen twice: the shop knows what a given customer
should pay and what margin it will accept, and there was nowhere to put either,
so both leaked into the cashier's judgement at the till.

### The pure resolver, and why the server does not impose a price

`src/domain/pricing/resolve.ts` holds `resolvePrice` and `capBreaches`. Pure,
and mirrored in Dart, because the till has to answer both questions with no
network.

The server runs the same two functions but **does not impose the answer**. A
sale uploaded hours later already happened, and the device was right about the
price at the time even if the list has moved since. So the server re-derives in
order to say what it *would* have charged and reports a difference
(`PRICE_LIST_MISMATCH`) rather than rejecting or rewriting one — rewriting the
figure would make the stored invoice disagree with the bill the customer is
holding. The only thing that makes that safe is both sides running identical
code.

Resolution is most specific first: an explicit entry on the customer's list
taking the highest quantity break at or below what is being sold, then the
list's own rule, then the item's own price. **A list is a set of overrides, not
a whitelist** — a wholesale customer buying something nobody priced for
wholesale is still billable.

### The three bases

`fixed` means only explicit prices apply. `percent_off_sale` discounts the
item's price. `percent_on_cost` marks up moving-average cost, which holds margin
as buying prices move — and wants `minPriceFloor` with it, because a cost-plus
list with a stale cost is how a shop sells below what it paid without noticing.
An item never purchased through the system has no average cost, so the rule
does not apply and resolution falls through rather than pricing at zero.

### Caps are config plus a record, and a warning on breach

The server owns the policy and syncs it; the device enforces at the till. On
upload the server re-runs the same pure check — that is what makes a fabricated
approval, or a device running a stale policy, visible — and reports what it
finds as **`DISCOUNT_CAP_EXCEEDED`, a warning on a successful write**.
Rejecting would strand a sale that has already happened, which is the one thing
an offline till cannot recover from.

`minMarginPercent` is the limit that earns its place: it catches a discount
inside every percentage cap that still loses money. It is marked approvable
rather than enforced, because clearing old stock below margin is a legitimate
decision — it is just the owner's to make, not the cashier's.

Every limit is nullable and **null means no limit, not zero**: a cap of zero is
a shop that forbids discounts outright, which is a different and legitimate
setting.

### Approvals travel inside the invoice

There is no endpoint that posts an approval on its own. It is part of the
document, like a line or a tender, which buys three things: the approval and the
discount it authorises can never be committed apart, an offline sale uploads its
evidence with it, and `discount_approvals` stays **genuinely append-only**
because no later statement has to claim the row for an invoice.

The server checks the named approver actually holds the permission the policy
requires and rejects with `APPROVER_NOT_PERMITTED` if not. That one is a
rejection, not a warning: an approval from someone not entitled to give it is
not evidence of anything, and storing it would make the trail assert something
untrue. The approver's **role at the time** is stored, because memberships
change and "was this person entitled to approve it then" has to stay answerable.

A new audit action, `invoice.discounted`, carries the discount figures and the
approver. `invoice.issued` never did, which is why no discount audit was
possible before: the trail knew a sale happened but not that margin had left
with it.

### Bulk revision is a job, not a statement

`price_revisions` / `price_revision_rows` mirror `import_jobs` /
`import_job_rows`: the client drives analyse then apply in chunks, each phase
takes `FOR UPDATE` on the job row, each row carries its own `applied_at`, and a
catalogue fingerprint refuses an apply whose preview is stale.

The analyse phase exists because **a price change is not reversible by reading
the result**: once `sale_price` has moved, what it was is gone. Every row is
previewed with its old and new price, and the preview is what the shopkeeper
approves.

Chunking has a second reason here that the importer does not have: every
repriced row bumps `server_seq` and republishes to every device. That is
correct — the tills need the new prices — but it should not arrive as one
lock-held burst against the single per-tenant counter, which is why
`PRICE_REVISION_APPLY_CHUNK_ROWS` defaults lower than the importer's.

### The soft-delete that is not cosmetic

`price_list_items` was created without `deleted_at` in `0016`, and `0017` adds
it. The sync change feed is a `SELECT ... WHERE server_seq > $1` over the table
itself, so **a hard delete is invisible to a device** — it would keep pricing a
wholesale customer at a figure the shop removed, indefinitely and silently. The
upsert clears the flag, because re-adding a deleted price would otherwise appear
to succeed and change nothing.

### Rules that cannot be broken

- `computeInvoice` is untouched. It takes `unitPrice` and `discount` as given
  and has no concept of a customer or a role, so resolution and cap checks sit
  outside it — and the frozen tax vectors did not move a second time.
- `price_lists`, `price_list_items` and `discount_policies` are **synced
  pull-only, and that is mandatory**: a till cannot price a wholesale customer
  offline without the lists, or enforce a cap it has never seen.
- `invoice_lines` records `price_list_id` and `price_source`, for the same
  reason it records `cogs_amount`: a margin or discount report must read what
  was true at the sale, not re-derive against today's prices.
- Deleting a list is refused while customers are priced on it. Deleting it
  would silently reprice them to the item price, which is a margin change
  nobody asked for.

---

## 12. GST returns, ITC, GSTR-2B, composition

### The problem

This is where GST-registered shops actually lose money. Not on the filing — an
accountant does that — but on the credit they never claim because nobody
reconciled the purchase register against what suppliers actually filed. **A bill
the supplier forgot to upload is input tax the shop has paid and cannot
reclaim, and it was invisible.**

Before this, the only GST artefacts in the system were the table-13 gap view,
the `hsn_summary`/`tax_summary` JSONB snapshots, and a single
`purchase_bills.itc_eligible` boolean.

### Three rules the module is built on

**Prepared figures are snapshotted.** `prepare` computes and stores; nothing
recomputes on read. The same reasoning as `day_closes`: a void raised in
November must not restate October's filed return. It belongs in the next
period's amendment, which is a later milestone.

**Filing is never automatic.** `prepare` is reversible and re-runnable as often
as the shop likes — entering a missing bill and preparing again is the normal
workflow. `file` requires `confirm: true`, refuses an unprepared period,
records who declared it, and cannot be undone. The figures are the shop's
declaration to the department, not ours.

**Everything is per GSTIN.** A business trading in two states files a return per
registration, `outlets.gstin` overrides the tenant's, and every query scopes by
the GSTIN **snapshotted on the document** — the only value that stays right
after a registration changes. Scoping by tenant or outlet would merge two
registrations into one wrong return.

### The pure domain

- **`classify.ts`** — which GSTR-1 table a supply belongs in. The order is not
  arbitrary: export and SEZ are tested *first*, because both can go to a buyer
  who happens to hold a GSTIN and testing for the GSTIN first would file an
  export as an ordinary B2B sale and lose the refund claim. Wholly non-taxable
  next, because an exempt sale to a registered buyer is still an exempt supply.
  Then the GSTIN test, then the ₹2.5 lakh B2CL threshold, which applies only
  inter-state — an intra-state sale of any size is B2CS, because the state
  already receives the tax. The threshold is a **constant, not configuration**:
  it is statutory, and a shop that could change it would file a wrong return
  without knowing.
- **`reconcile.ts`** — the three-pass matcher (below).
- **`parse-2b.ts`** — the portal's JSON, which is awkward in ways much easier
  to pin down with cases than to debug against a live download: rupees with
  decimals rather than paise, `DD-MM-YYYY` dates, abbreviated keys (`ctin`,
  `inum`, `txval`), invoices nested two levels deep per supplier, tax sometimes
  in a nested `items` array and sometimes flat, and separate
  `b2b`/`b2ba`/`cdnr`/`cdnra`/`impg` blocks. Day-first dates passed through
  unchanged are the kind of bug that works for the first twelve days of every
  month, which is exactly long enough to reach production.
- **`composition.ts`** — the CMP-08 liability nothing computed. A composition
  dealer charges no tax (the engine already handled that) but still owes a flat
  percentage of turnover, so a composition shop could bill correctly all quarter
  and have no idea what to pay. The quarter is computed in absolute months from
  year zero rather than with modular arithmetic, because the January–March
  quarter of an April financial year otherwise needs a special case that is easy
  to get subtly wrong.

### GSTR-2B reconciliation

Three passes, narrowing in confidence:

1. **Strong key** — same GSTIN, same normalised invoice number. Amounts
   agreeing within tolerance is `exact`; not agreeing is `mismatch`, which is
   the useful case: the document is the same, so one side keyed a figure wrong
   and the shop may be claiming the wrong credit.
2. **Amount and date** — same GSTIN, tax within tolerance, date within a few
   days, numbers differing. That is `probable`, **never automatic**: accepting
   one wrongly claims credit against somebody else's invoice.
3. **The remainder** — `missing_in_books` (usually a bill nobody entered) and
   `missing_in_2b`, the one to chase.

Numbers are normalised before comparison, so `INV-001`, `inv 001` and `INV001`
are one number keyed three ways. Treating them as three is how a reconciliation
reports a gap that is really a typo and sends the shopkeeper to chase a supplier
who filed correctly. The normalisation is **not** applied to the stored
column — the number printed on the supplier's bill is a fact and stays as
entered; this is a comparison key.

**Bills from unregistered suppliers are skipped entirely** rather than reported
missing. Such a supplier files nothing, so its absence from 2B is correct, and
listing it would bury the real gaps. A reconciliation that cries wolf is worse
than none, because the shopkeeper stops reading it.

The comparison window is `GSTR2B_COMPARISON_MONTHS` either side of the period: a
bill dated in March can appear in a supplier's April filing, and a strictly
period-bounded comparison reports that twice — as a gap in one month and an
unknown invoice in the next.

Rows that cannot be read are recorded in `errorSummary`, never dropped: **a row
nobody could identify is not the same as a supplier who never filed**, and only
one of those is worth chasing.

### The ITC register

A separate append-only table rather than columns on `purchase_bills`, because
the credit has its own life: claimed in a period that need not be the bill's,
reversed if the supplier never files, reclaimed when they do. Amounts are
**signed** — a debit note carries negatives — so the register sums to the
claimable figure without a `CASE` on the source type.

A row is never deleted; the state moves. A credit that was claimed and then
reversed is part of what an assessment is defended with, and an editable ITC
register is worth nothing in a notice.

`itc_category` (`inputs | input_services | capital_goods | ineligible`) exists
because GSTR-3B table 4 requires the split and `itc_eligible` alone cannot fill
it. Reverse-charge rows are reported separately because they appear **twice** in
3B — a liability under 3.1(d) and a credit under 4(A)(3) — and netting them
would understate both sides. 3.1(d) is reported as a single self-assessed
figure rather than a CGST/SGST/IGST split: the head depends on where the
supplier was, and an unregistered supplier has no return to reconcile a split
against.

Shops that were using the system before the register existed are backfilled
from their purchase bills, idempotently, on every `prepare` — asking them to
re-enter months of bills would be absurd.

### The export

A workbook with one sheet per GSTR-1 table (B2B, B2CL, B2CS, EXP, SEZ, CDNR,
CDNUR, nil/exempt, HSN, documents), or the same figures as JSON. `buildWorkbook`
has always taken a list of sheets and every caller so far passed one; a return
is what it was built for. Empty tables are included rather than dropped, because
an accountant checking a return needs to *see* that a table is empty rather than
wonder whether it was computed.

> The JSON carries the workings under an identifying header and is deliberately
> **not** reshaped into the portal's abbreviated upload keys. That mapping
> belongs with a filing integration that can be tested against the real API, and
> inventing it here would produce a file that looks official and may not upload.

### Configurable, and why

The matching tolerances are judgement calls about other people's data entry
rather than arithmetic, so they are passed into the pure reconciler the way GST
rates are passed into the tax engine — support can tune them for one customer
without a deploy. See the configuration table below.

---

## 13. Reports: 13 → 39

### No new infrastructure

Each report is one `ReportDefinition` plus one query function. The kernel
already owned the outlet boundary, the range limit, the row cap, the plan gate
and the totals row, and still does. The changes to it were small:

- **`FilterName` widened** with `supplierId`, `gstin`, `userId`, `counterId`,
  `priceListId`, `hsnCode`, `taxRatePercent`.
- **`gstinScope`** beside `outletScope`, because filing is per registration and
  only per-outlet scoping existed.
- **`report.feature` honoured** (§9).
- **`format=csv`**, below.

### CSV export, finally

Three separate comments promised that the generic column envelope made CSV
export free; nothing implemented it. `reports.csv.ts` reads the same
`ReportResult` the JSON endpoint returns and knows nothing about which report
produced it — so **every report exports without its own code**, which is what
`ReportColumn.kind` was for.

Scales are converted there rather than in the reports: a report returns paise
and thousandths like everything else, and a person opening a spreadsheet expects
rupees and units. The totals row is the one the kernel computed over the rows
being returned, so a truncated report's footer still adds up to what is above
it — the same guarantee the screen gives.

Values beginning `=`, `+`, `-` or `@` are tab-prefixed. Report rows carry
customer and item names a customer chose, and those execute as formulas when the
file is opened in Excel or Sheets.

### The compliance group, and why it duplicates `/v1/gst`

`ReportDefinition.group` has allowed `'compliance'` since the kernel was
written and nothing used it. Ten reports now do.

They read **live** documents, so they answer "what would this period look like
if I filed it now" — which is what an accountant wants halfway through a month.
A *prepared* return under `/v1/gst` is the other thing: a snapshot that must not
move once filed. Both exist because they answer different questions, and
confusing them is how a filed return silently restates itself.

### Decisions worth knowing

- **Margin never uses the item's current cost.** Every margin figure reads
  `invoice_lines.cogs_amount`, the moving average snapshotted at the moment of
  sale. Costing a March sale at today's buying price makes margin restate itself
  every time a supplier raises a price — the bug the snapshot was added to fix.
  Lines with no snapshot are reported as **unknown, never zero**: zero cost
  reads as pure profit, which would overstate margin on exactly the items
  nobody has cost data for. The `No cost` column says how much of the revenue
  has a real cost behind it.
- **Stock is valued at cost**, with retail alongside. Valuing stock at what the
  shop hopes to sell it for overstates the asset and no lender will accept it.
- **Cash flow is built from payments and expenses, not invoices.** A sale billed
  to a customer's khata moves no money, and a cash-flow report that counted it
  would tell a shop it is solvent when it is not.
- **Payables ageing is not outlet-scoped**, deliberately, like
  `customer-outstanding`. A supplier is owed by the business, not by the branch
  that received the goods.
- **Voids count against whoever voided them**, not whoever billed them. A
  cashier voiding their own sales is the pattern worth seeing.
- **The hourly heatmap reads `issued_at`, not `document_date`**, in the shop's
  own timezone — a shop in India would otherwise see its evening rush at half
  past one in the afternoon. An offline bill reports the hour it was actually
  made, which is right, and worth knowing if a device's clock is wrong.
- **Price-change history reads `audit_log`** rather than a price-history table.
  The trail has recorded `item.price_changed` on every catalogue update since
  M1; a second store of the same fact could only disagree with it.
- **The stock ledger requires `itemId`**, like `khata-statement` requires a
  customer. Without one it would be every item's movements interleaved, which is
  not a document anyone wants. Its running balance is summed from the ledger
  rather than read from `stock_balances`, so the two disagreeing becomes visible
  instead of being papered over.

---

## 14. Configuration added (part two)

| Variable                            | Dev value | Notes                                                                                    |
| ----------------------------------- | --------- | ---------------------------------------------------------------------------------------- |
| `PLAN_DEV_GRANT_ALL`                | `true`    | Grants every feature, lifts every quota. **`APP_ENV=production` refuses to boot with it.** |
| `PRICE_REVISION_ANALYSE_CHUNK_ROWS` | 500       | Rows priced and previewed per `analyse` call.                                             |
| `PRICE_REVISION_APPLY_CHUNK_ROWS`   | 500       | Lower than the importer's: each row republishes to every device.                          |
| `GSTR2B_TAX_TOLERANCE_PAISE`        | 100       | Tax difference treated as equal. Two systems round the same invoice differently.          |
| `GSTR2B_DATE_TOLERANCE_DAYS`        | 7         | A day out is a typo; a month out is a different invoice.                                  |
| `GSTR2B_COMPARISON_MONTHS`          | 1         | Months either side of the period to compare our bills over.                               |
| `ITC_BACKFILL_CHUNK_ROWS`           | 5000      | Pre-register bills folded in per `prepare`. Idempotent.                                   |

**Removed**: `PLAN_FREE_FEATURES`, `PLAN_FREE_MAX_USERS`,
`PLAN_FREE_MAX_OUTLETS`, `PLAN_FREE_MAX_COUNTERS`, `PLAN_FREE_MAX_ITEMS`,
`PLAN_FREE_REPORT_IDS` — all superseded by `plans.ts` and the registry gate.

**Also required**: `application/json` is now an allowed content type for the
`import` and `export` object kinds, since a GSTR-2B statement arrives as JSON
and a return leaves as one. The `import` kind stays client-signable; `export`
stays server-written only.

---

## 15. Known gaps (part two)

- **The Dart port needs the HSN change.** 279 of 351 tax vectors moved because
  un-coded lines now appear in the HSN summary. Nothing else in the vectors
  changed. Until the port follows, offline totals diverge on any line without an
  HSN code.
- **No integration tests for any of part two.** The arithmetic is covered by
  unit tests and the contract vectors; the transactions are not. What most needs
  a real database: concurrent `apply` calls on one revision, an approval whose
  approver loses the permission between capture and upload, a reconciliation
  rerun that must not undo an accepted match, and RLS isolation on the eleven
  new tables. Each of these was exercised by hand against the dev project and
  then deleted — they should be written properly.
- **GSTR-1 amendment tables (9A, 9B, 9C) are absent.** An amendment restates a
  *filed* period, which needs the previously filed figures to diff against.
  Nothing has filed a period yet, so they belong with the filing integration.
- **Nothing files a return.** By design for now — the product guide is explicit
  that filing must never be automatic — but the portal JSON is not in the
  portal's upload shape either, so filing is a copy-out-and-upload job.
- **GSTR-2B reconciliation ingests JSON only.** The `xlsx` format is accepted at
  registration and will fail at ingest; `readSpreadsheet` has no 2B column map.
- **M12's bank accounts and UPI webhook, and M13's storefront, are untouched.**
  They sit in those milestones but were not part of this work.
- **No amendment path for a prepared-then-corrected return** other than
  re-preparing while still open. Once filed, the only route is the next
  period's amendment tables, which do not exist yet.
- **`itc_register.gstin` is resolved at write time** from the outlet or tenant.
  A shop that changes its GSTIN mid-period will have rows under both, which is
  arguably correct but has not been thought through for the return boundary.
