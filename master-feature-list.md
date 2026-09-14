# Master Feature List — Best of Petpooja Invoice + EZO

**Version:** 1.0
**Date:** 27 August 2026
**Purpose:** The consolidated build backlog for your billing app, filtered from both competitors and sequenced by phase.

**Source tags:** `[PP]` from Petpooja · `[EZO]` from EZO · `[BOTH]` in both · `[NEW]` neither has it, our wedge

---

## 0. The filter I applied

A straight union of both products is roughly 120 features and a two-year build. That's the trap. Every feature here passed three tests:

1. **Does a merchant pay for it, or churn without it?**
2. **Is it cheap relative to its pull?** (Online storefront: 3 days, big pull. Manufacturing module: 6 weeks, near-zero pull for your segment.)
3. **Does it fit the strategy?** — free tier for acquisition, paid vertical depth, per-seat/per-outlet metering.

Anything failing all three is in §7 (Cut list) with the reason. Read that section — what you don't build matters as much as what you do.

**Standing assumption:** general retail core, with one vertical module chosen at P2 (pharmacy or mobile/electronics, per the earlier analysis). If you've picked a different vertical, only §4 changes.

---

## 1. Non-negotiable design rules

These aren't features. They're constraints that must hold from commit one, because retrofitting any of them means a rewrite.

| Rule | Why |
|---|---|
| **Invoices immutable after issue** `[PP]` | Corrections only via credit/debit note. GST-correct and audit-safe. |
| **Stock is an append-only ledger, never a quantity column** `[PP]` | Enables audit, theft detection, sync-conflict recovery |
| **Per-counter document number blocks** `[NEW]` | EZO ships duplicate invoice numbers today. This is our headline wedge — see §5. |
| **Client-generated UUID on every document** | Makes offline sync idempotent |
| **Tax engine is a pure function, shared client+server** | Offline and online totals must be byte-identical |
| **Seat and outlet metering in the data model from day 1** `[EZO]` | EZO charges ₹1,499/staff and ₹3,999/outlet. Retrofitting per-seat billing is painful. |
| **Row-level tenant isolation enforced in the DB** | A cross-tenant leak in a billing product ends the company |
| **i18n from commit one, not a v2 task** `[EZO]` | 10 languages is EZO's real moat. Bolting on RTL/locale later is a slog. |

---

## 2. P0 — MVP (target ~8–10 weeks)

Everything here is required for a single shop to run its whole day on your app. Ship nothing until all of it works.

### 2.1 Billing
- `[BOTH]` GST invoice with auto CGST/SGST/IGST from HSN + place of supply
- `[EZO]` **Non-GST / unregistered billing mode** — large share of small shops aren't registered; Petpooja under-serves them
- `[BOTH]` Barcode scan billing (keyboard-wedge + camera)
- `[BOTH]` Item search by name, code, alias with fuzzy matching
- `[BOTH]` Line-level qty, price override, discount
- `[BOTH]` Bill-level discount, round-off, additional charges
- `[BOTH]` Split tender: cash / card / UPI / wallet / credit (khata)
- `[BOTH]` Cash tendered → change due
- `[BOTH]` Hold / park multiple bills, surviving app restart
- `[BOTH]` Returns and exchanges via credit note
- `[BOTH]` Void with reason + audit log
- `[BOTH]` Full keyboard operation with on-screen shortcut legend
- `[PP]` **Offline mode** — bill indefinitely with no network, sync on reconnect

### 2.2 Invoice output
- `[BOTH]` Thermal 58mm / 80mm (ESC/POS direct, not OS print dialog)
- `[BOTH]` A4 / A5 PDF
- `[EZO]` **Multiple templates** including a Tally-style layout
- `[EZO]` **User-defined custom fields** — batch no, PO no, vehicle no, ticket no, anything
- `[BOTH]` Logo, signature, UPI details, bank details, T&C on bill
- `[BOTH]` Send on WhatsApp

### 2.3 Catalogue
- `[BOTH]` Items with HSN/SAC, tax rate, MRP, sale price, purchase price, UOM
- `[BOTH]` Categories and subcategories
- `[BOTH]` Multiple barcodes per item
- `[BOTH]` Service items (SAC, no stock)
- `[EZO]` **Bulk item edit** via Excel import/export with dry-run diff preview
- `[BOTH]` Barcode generation and label printing

### 2.4 Inventory (basic)
- `[BOTH]` Real-time stock on every sale/purchase/return
- `[BOTH]` Low-stock alerts and reorder level
- `[BOTH]` Manual stock adjustment with reason codes
- `[BOTH]` Fast-moving / dead-stock views

### 2.5 Customers & khata
- `[BOTH]` Customer master, phone as primary key, inline one-field creation
- `[EZO]` **Khata / udhaar ledger** with running balance and statement
- `[EZO]` **WhatsApp payment reminders** with per-transaction reminder dates
- `[BOTH]` Credit limit warning at billing
- `[BOTH]` Purchase history per customer

### 2.6 Money
- `[BOTH]` Receipts allocated to invoices (partial + multi-invoice)
- `[BOTH]` Expense entries with category and receipt photo
- `[BOTH]` Day-close / cash-up: opening float, expected vs actual, variance

### 2.7 Reports (P0 set — 12 only)
Day book · Sales summary · Item-wise sales · Category-wise sales · Payment-mode split · Bill register · Current stock · Low stock · Customer outstanding · Khata statement · Expense summary · Daily P&L

### 2.8 Platform
- `[EZO]` **Android mobile-first** + web back office
- `[BOTH]` Cloud sync with automatic backup
- `[EZO]` **App lock** (PIN)
- `[BOTH]` Multi-user with role permissions
- `[EZO]` **Languages: English, Hindi, Marathi, Gujarati** at launch (add 6 more at P2)

---

## 3. P1 — Business system (~6–8 weeks)

Turns a biller into something a business runs on. This is where Petpooja's depth starts and EZO stops.

### 3.1 Purchases — EZO's biggest gap
- `[PP]` Purchase bills updating stock + supplier payable atomically
- `[PP]` **Purchase orders**, converting to bills, partial receipt supported
- `[PP]` Supplier master and ledger with ageing (0-30/31-60/61-90/90+)
- `[PP]` Supplier payments with bill allocation
- `[PP]` **Debit notes** for supplier returns
- `[PP]` Landed cost — freight apportioned across lines, updating item cost

### 3.2 Structured returns
- `[PP]` **Credit notes** linked to original invoice, adjusting stock + balance + GST together
- `[PP]` Partial returns, reason codes, own numbering series

### 3.3 Pricing & discount control
- `[PP]` **Multiple price lists** (retail / wholesale / distributor), assigned per customer
- `[PP]` Bulk price revision by % across a category, with preview and effective date
- `[PP]` **Rule-based discounts with caps** — cashier cannot exceed; manager approval above cap; every discount logged
- `[EZO]` Discounts printed on barcode labels

### 3.4 Banking
- `[PP]` Bank accounts, payment mode → account mapping
- `[PP]` Cash book / bank book
- `[BOTH]` UPI dynamic QR per bill with webhook confirmation

### 3.5 Compliance
- `[BOTH]` GSTR-1 workings: B2B, B2C, CDN, HSN summary, document series
- `[BOTH]` GSTR-3B summary
- `[PP]` **GSTR-2B reconciliation** — import JSON, match against purchase bills, flag gaps. *This is where merchants lose real money and both competitors are shallow.*
- `[PP]` Input tax credit register
- `[PP]` Composition scheme mode

### 3.6 Growth — cheap, high pull
- `[EZO]` **Online Dukan equivalent** — auto-generated catalogue page from the item master, shareable link, orders via WhatsApp. Days of work, and Petpooja has nothing here.
- `[EZO]` **Festival branded greetings** to customers
- `[EZO]` Upsell / cross-sell suggestions at billing

### 3.7 Reports (expand to ~40)
Add: cashier-wise · counter-wise · hourly heatmap · discount audit · returns/void · gross margin by item and category · purchase register · supplier-wise · PO status · stock ledger per item · stock valuation · cash flow · receivables/payables ageing

---

## 4. P2 — Depth & reach (~8 weeks)

### 4.1 Multi-outlet — real branch management
- `[PP]` **Head office / branch hierarchy** with per-outlet GSTIN (multi-state = multiple registrations)
- `[PP]` **Stock transfer** between outlets: two-sided doc, `issued → in_transit → received`, discrepancy handling
- `[PP]` Consolidated dashboard with outlet filter
- `[PP]` Central item master with per-outlet price overrides

> Note: EZO does multi-*business* (separate books). This is multi-*branch* (consolidated stock). Different feature, and the one that justifies your ₹3,999/outlet charge.

### 4.2 Sales workflow chain
- `[PP]` Estimate → Sales Order → Delivery Challan → Invoice, one-click conversion, partial conversion, reverse traceability

### 4.3 Language expansion
- `[EZO]` Add Bengali, Telugu, Tamil, Kannada, Malayalam, Punjabi → 10 total
- `[NEW]` **Regional item aliases** — type "kanda", find "Onion". Neither competitor does this properly.

### 4.4 Pick ONE vertical module

**Option A — Pharmacy**
- `[PP]` Batch-level stock (not just a printed field): batch no, mfg date, expiry, batch-wise MRP and cost
- `[PP]` FEFO suggestion at billing
- `[PP]` Near-expiry reports at 90/60/30 days, with return-to-supplier flow
- `[NEW]` Schedule-H/H1 register

**Option B — Mobile & Electronics**
- `[PP]` IMEI / serial capture at purchase and sale, unit traceable to its invoice
- `[PP]` Warranty tracking from serial
- `[PP]` Partial payments and outstanding against estimates/challans
- `[NEW]` Exchange/buyback valuation flow

### 4.5 Supermarket essentials (if that's your segment instead)
- `[PP]` **Weighing scale integration** — serial/USB read + embedded-weight barcode parsing
- `[PP]` Multi-counter with per-counter cash-up
- `[PP]` Physical stock count with scan-based counting and variance report

---

## 5. P3 — Differentiators (~8 weeks)

### 5.1 Integrations that unlock bigger customers
- `[PP]` **Tally direct sync** — XML vouchers, one-time ledger mapping, real-time or daily. *Note: EZO only offers Tally-style templates. Real sync is a genuine differentiator against them.*
- `[PP]` **E-invoice (IRN)** via a GSP — outbox queue, retries, 24h cancellation
- `[PP]` **E-way bill generation** — Part A/B, vehicle update, cancellation
- `[BOTH]` WhatsApp Business Cloud API for campaigns segmented on purchase data

### 5.2 The moat features
- `[PP]` **Barcode AI** — national GTIN catalogue so kirana stores can scan a Maggi packet with no purchase entry. Seed from GS1 + distributor files, then crowd-source from your own base. Compounds with scale; EZO can't copy your data.
- `[PP]` **Theft detection** — variance report attributing physical-vs-system gaps to a time window and user
- `[EZO]` AI marketing suite (only if you're going after the ₹11,999 upsell)

### 5.3 Loyalty
- `[PP]` Points ledger per invoice, redemption at billing, expiry policy

---

## 6. The wedge features — build these especially well

Not a phase. These are the four things your sales pitch rests on, because they're where incumbents demonstrably fail.

| Wedge | The pitch | Against |
|---|---|---|
| **Correct document numbering** | "Your invoice numbers will never duplicate." Per-counter blocks, no gaps, FY reset, GSTR-1 Table 13 series reporting. | EZO ships this bug today; users report delayed GST filings because of it |
| **Support that answers** | Published response times, in-app chat, remote assist | EZO's most common complaint; one user reports being asked for a 5-star review *before* getting help |
| **15-minute onboarding** | Catalogue import from Excel, Tally, Vyapar, or a photo of their price list. Printer auto-detect. | Both competitors require hand-holding; Petpooja sells physical install visits |
| **GSTR-2B reconciliation** | Where merchants actually lose money, and both are shallow | Both |

---

## 7. Cut list — do NOT build these

Each of these exists in one competitor. Skipping them is deliberate.

| Feature | Why cut |
|---|---|
| **Manufacturing / BOM module** `[PP]` | Weeks of work, near-zero demand in retail SMB. Petpooja needs it for distributor deals you won't win in year one. |
| **Warehouse module** `[PP]` | Only matters above ~5 outlets. Multi-branch transfer (§4.1) covers 95% of the need. |
| **AI receptionist** `[EZO]` | Separate product, separate support burden, unrelated to billing |
| **Local SEO / NearSearch** `[EZO]` | Same |
| **GST registration/filing as a service** `[EZO]` | Regulated services business, not software. Partner with a CA firm instead. |
| **Lifetime subscription tier** `[EZO]` | Converts a recurring cost liability into one payment. Flatters year one, destroys year three. |
| **Own hardware** `[EZO]` | Working capital, inventory, returns, warranty. Bundle a third-party printer instead until you have volume. |
| **E-invoice at P0/P1** | Only applies above ₹5 crore turnover. Irrelevant to your first 100 customers. Deferred to P3 correctly. |
| **Loyalty at P0/P1** | Merchants ask for it in demos, then never configure it. Classic demo-ware. |

---

## 8. Monetisation gating

Which features sit behind which paywall. Decide this *now* — it determines feature flags in the codebase.

### Free tier (acquisition — match EZO)
Billing (GST + non-GST) · 1 user · 1 outlet · item master capped (~100 items) · basic stock · khata · thermal print · WhatsApp send · 5 reports

### Paid — ₹4,000–5,000/yr
Unlimited items · full reports · purchases & PO · credit/debit notes · price lists · discount rules · GSTR workings · online storefront · bulk edit · barcode printing · offline mode

### Metered add-ons (the expansion engine)
| Add-on | Suggested price | Copying |
|---|---|---|
| Extra staff seat | ₹1,200–1,500 | EZO's ₹1,499 |
| Extra outlet | ₹3,000–4,000 | EZO's ₹3,999 |
| Extra counter | ₹1,500 | Petpooja's multi-counter |
| Vertical module (pharmacy/electronics) | ₹2,000 | Neither — yours |
| Tally sync | ₹1,500 | Petpooja bundles it; charge separately |
| E-invoice + e-way bill | ₹2,000 | Only >₹5cr customers need it |
| WhatsApp campaign credits | Usage-based | Both |

A two-staff, two-outlet shop lands around ₹11,000–13,000/yr — matching EZO's real effective ARPU while looking cheaper on the shelf.

---

## 9. Count and effort summary

| Phase | Features | Weeks | Cumulative |
|---|---|---|---|
| P0 — MVP | ~45 | 8–10 | Sellable to a single shop |
| P1 — Business system | ~35 | 6–8 | Beats EZO on depth |
| P2 — Depth & reach | ~20 | 8 | Wins pharmacy/electronics/multi-outlet |
| P3 — Differentiators | ~12 | 8 | Competes with Petpooja head-on |

**~112 features, 30–34 weeks** with the team in the build spec. Compress with AI assistance on the CRUD-heavy parts, but not on sync, tax correctness, or hardware — those are bounded by testing and review, not typing speed.

**If you only ship P0 + the four wedges in §6, you have a real product.** Everything after that is expansion revenue.
