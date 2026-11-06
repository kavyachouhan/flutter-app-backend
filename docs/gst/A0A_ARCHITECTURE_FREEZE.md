# GST A0a — Architecture freeze

Milestone A0a of the BillBanao GST Compliance Plan v2.1
(`C:\Users\DELL\.claude\plans\pasted-content-id-019a-billbanao-warm-harp.md`). This document
fixes the schemas, enums and contracts that every later GST migration and the
Dart port depend on. **No migration is written or applied until this document
is approved.** After approval, A0b implements §9 exactly; any change to a frozen
name needs an amendment to this file first.

Status: **approved for A0b, revision 4 (5 Nov 2026).** Decision IDs (D-numbers) refer to the plan.
Revision 4 changes (5 Nov 2026):
- invoice-cum-bill-of-supply is never e-invoiced (Rule 46A buyers are unregistered), enforced at issue
- conditional CHECKs test required columns with IS NOT NULL
- unresolved historical documents get a distinct quarantined `registration_resolution = legacy_unresolved` state, never NULL-as-non-GST
Revision 3 changes:
- e-invoice applicability evaluated per statutory rule (casual registrations not excluded by kind)
- preflight resolves the issuing (outward) or receiving (inward) registration from the outlet, never from the supplier GSTIN
- complete rule-set schema: HSN/SAC-scoped rates with taxability, exemptions and conditions; deterministic version selection and corrections; HSN master descriptive only
- inward tax-point contract (§4.4a)
- `customer_addresses` country-conditional validation and composite FK
- explicit `app.gstin_valid()` CHECKs
Revision 2 changes:
- the number registry is keyed by registration, with a 16-character limit and a defined scope
- UIN is separated from GSTIN
- the e-invoice and HSN contracts are corrected
- profile date ranges are half-open, and foreign keys are composite with the tenant
- legacy TEST records stay unclassified, under an immutable `legacy` rule set
- the status / IRN-state lifecycle is constrained
- rejected attempts are kept separate from cancellations
- country codes are added to snapshots
- the cess history shape is defined
- original-document IDs are added
- a registration preflight report runs before migration
- the §8 count is corrected

Conventions carried over from the existing codebase: money in paise (`BIGINT`),
quantities in thousandths, UUID primary keys generated on the client, every
tenant table set up with `app.setup_tenant_table`, `server_seq` for sync,
snake_case in SQL and camelCase on the wire, and one shared enum file per side
(`src/domain/gst/enums.ts` ↔ `packages/khata_domain/lib/src/gst/enums.dart`).

---

## 1. Legal entity (PAN level) — D23

`tenants` stays the legal entity: one PAN.

| Column | Change | Notes |
|---|---|---|
| `pan`, `legal_name`, `name` | keep | `name` is the display/trade name |
| `state_code`, address columns | keep | Principal-place address. For an unregistered tenant this is the only state. |
| `einvoice_exemption_category` | **add** `TEXT NOT NULL DEFAULT 'none'` | enum `EinvoiceExemptionCategory` (§7) |
| `is_gst_registered`, `gstin`, `is_composition`, `composition_category`, `composition_rate_percent`, `filing_frequency`, `registration_effective_from` | **drop** (after copy into §2) | Registered = "has an active registration on the document date" |

New table **`entity_turnover_by_fy`** (tenant-scoped, synced read-only):

```sql
CREATE TABLE entity_turnover_by_fy (
  id                 UUID PRIMARY KEY,
  tenant_id          UUID NOT NULL REFERENCES tenants (id),
  fy_start_year      INTEGER NOT NULL CHECK (fy_start_year BETWEEN 2017 AND 2100),
  aggregate_turnover BIGINT  NOT NULL CHECK (aggregate_turnover >= 0),   -- paise, s.2(6)
  source             TEXT    NOT NULL CHECK (source IN ('declared','app_computed','portal_verified')),
  verified_by        UUID REFERENCES users (id),
  verified_at        TIMESTAMPTZ,
  evidence_ref       TEXT,             -- upload id or free reference
  notes              TEXT,
  ...timestamps, server_seq...,
  UNIQUE (tenant_id, fy_start_year, source)
);
```

**Precedence when deriving:** `portal_verified` beats `declared`, which beats
`app_computed`. `app_computed` is advisory only: BillBanao may not see all of the
PAN's sales.

Derived values come from pure functions in `src/domain/gst/entity.ts` and their
Dart twin. They are never stored.

```ts
einvoiceApplicability(input: {
  entity: EntityFacts;            // turnover by FY (resolved by precedence), exemption category
  registration: RegistrationFacts; // kind, is_sez_unit, status, profile in force (taxpayer_scheme)
  documentKind: 'tax_invoice' | 'credit_note' | 'sales_debit_note'
              | 'bill_of_supply' | 'invoice_cum_bill_of_supply' | 'rcm_self_invoice';
  buyerTreatment: GstTreatment;
  supplyType: SupplyType;
  documentDate: IsoDate;
  ruleSet: GstRuleSet;
}): { mandatory: boolean; reason: EinvoiceReason; reportingWindowDays: 30 | null }
```

`mandatory` is true only when **all** of the following hold. Each rule is evaluated on its statutory basis, not on the registration kind alone:
1. **Turnover:** some FY from 2017-18 up to the FY before the document date has PAN-level aggregate turnover above the `einvoice_aato` threshold (Notif. 13/2020-CT as amended).
2. **Entity exclusion:** `einvoice_exemption_category = 'none'`. The notified exclusions are entity classes, and they are listed in the rule set (`einvoiceExclusions`), not hard-coded.
3. **Registration exclusion:** the registration is not an SEZ unit. This is the notified exclusion: SEZ developers are not excluded. **A casual taxable person (`registration_kind = 'casual'`) is not excluded on that account.** It is evaluated like a `normal` registration, because the notification ties applicability to the person's aggregate turnover, not the registration kind. `isd_reserved` and `tds_tcs_reserved` return `not_a_supply_document` rather than "excluded", because they do not issue invoices for supplies.
4. **Scheme:** the profile in force is `regular`. A composition taxpayer issues bills of supply, which are outside e-invoicing.
5. **Document kind:** tax invoice, credit note or sales debit note.
6. **Buyer and supply:** the buyer is registered (B2B), an SEZ unit or developer, or the supply is an export. B2C and `uin_holder` buyers are excluded; whether UIN-holder supplies are in scope is §11 open item E1, and the default is excluded.

**Not covered by this function:**
- `bill_of_supply` is never e-invoiced.
- `invoice_cum_bill_of_supply` is **never e-invoiced**. Rule 46A permits this document only for a supply to an **unregistered** person, so its buyer is always B2C. The function returns `mandatory = false` with reason `document_kind_out_of_scope` without looking at the buyer. Issue-time validation (client + server) rejects an `invoice_cum_bill_of_supply` whose `buyer_gst_treatment` is not `unregistered` or `consumer`, and a CHECK on `invoices` enforces the same pair. This is the only rule for this document kind; rule 5 above lists the e-invoiceable kinds exhaustively.
- `rcm_self_invoice` always returns `false` while RCMDOM/RCMIMP stays optional (D29).

`reportingWindowDays` is 30 when the preceding-FY AATO is at or above `irn_30day_aato`. `EinvoiceReason` enumerates the rule that decided the outcome, for display and audit.

```ts
hsnRequirement(entity, documentDate, buyerClass: 'b2b' | 'b2c', ruleSet)
  : { mandatory: boolean; minDigits: 4 | 6 | null }
```

Values are based on the preceding FY's aggregate turnover (D20, Notif. 78/2020-CT):

| Turnover | `b2b` | `b2c` |
|---|---|---|
| ≤ `hsn_6digit_aato` (₹5 cr) | mandatory, 4 digits | optional: `minDigits` 4 applies only when an HSN is entered |
| > ₹5 cr | mandatory, 6 digits | mandatory, 6 digits |

## 2. GST registration (GSTIN level) — D23

**`gst_registrations`** (tenant-scoped, synced):

```sql
CREATE TABLE gst_registrations (
  id                       UUID PRIMARY KEY,
  tenant_id                UUID NOT NULL REFERENCES tenants (id),
  gstin                    TEXT NOT NULL CHECK (app.gstin_valid(gstin)),
  state_code               TEXT NOT NULL,
  CONSTRAINT gst_registrations_state_prefix CHECK (state_code = left(gstin, 2)),
  legal_name               TEXT,                   -- as on the registration certificate
  trade_name               TEXT,
  registration_kind        TEXT NOT NULL CHECK (registration_kind IN ('normal','casual','isd_reserved','tds_tcs_reserved')),
  is_sez_unit              BOOLEAN NOT NULL DEFAULT false,
  is_sez_developer         BOOLEAN NOT NULL DEFAULT false,
  status                   TEXT NOT NULL CHECK (status IN ('active','suspended','cancelled')),
  effective_from           DATE NOT NULL,
  effective_to             DATE,                    -- exclusive (half-open [from, to))
  round_off_enabled        BOOLEAN NOT NULL DEFAULT true,                       -- D5
  offline_backdate_policy  TEXT NOT NULL DEFAULT 'audited_late_sync'
                           CHECK (offline_backdate_policy IN ('audited_late_sync','strict_close')),  -- D33
  lock_epoch               BIGINT NOT NULL DEFAULT 0,                           -- D33
  gstr1_locked_through     DATE,                                                -- D12
  gstr3b_locked_through    DATE,
  ...timestamps, deleted_at, server_seq...,
  CHECK (NOT (is_sez_unit AND is_sez_developer)),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  UNIQUE (tenant_id, id)                         -- target of every composite FK below
);
CREATE UNIQUE INDEX gst_registrations_gstin_uq ON gst_registrations (gstin) WHERE deleted_at IS NULL;
```

**`gst_registration_profiles`** holds settings that legally change over time. A
registration can opt in or out of composition at an FY boundary, and in or out
of QRMP by quarter.

```sql
CREATE TABLE gst_registration_profiles (
  id                       UUID PRIMARY KEY,
  tenant_id                UUID NOT NULL,
  registration_id          UUID NOT NULL,
  effective_from           DATE NOT NULL,
  effective_to             DATE,          -- exclusive; NULL = open-ended
  taxpayer_scheme          TEXT NOT NULL CHECK (taxpayer_scheme IN ('regular','composition')),
  composition_category     TEXT,          -- existing 0018 values
  composition_rate_percent NUMERIC(5,2),
  filing_frequency         TEXT NOT NULL CHECK (filing_frequency IN ('monthly','qrmp')),
  ...,
  FOREIGN KEY (tenant_id, registration_id) REFERENCES gst_registrations (tenant_id, id),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  -- half-open ranges: a profile ending 2026-04-01 and the next starting 2026-04-01 do not overlap
  EXCLUDE USING gist (registration_id WITH =, daterange(effective_from, effective_to, '[)') WITH &&),
  CHECK ((taxpayer_scheme = 'composition') = (composition_rate_percent IS NOT NULL))
);
```

**Composite foreign keys everywhere.** Every table that references a
registration stores `tenant_id` and uses
`FOREIGN KEY (tenant_id, registration_id) REFERENCES gst_registrations (tenant_id, id)`.
That covers profiles, lock events, outlets, `document_series`,
`number_blocks`, every GST document table, `gst_document_numbers`,
`document_issue_rejections` and `issuance_authorisations`. A row in one tenant
can never point at another tenant's registration, even if RLS were bypassed.

**`gst_period_lock_events`** (append-only, audited):
- Columns: `registration_id`, `lock_level` (`gstr1_filed | gstr3b_filed`), `locked_through`, `lock_epoch`, `event` (`lock | reopen`), `reason`, `by`, `at`.
- Every event bumps `gst_registrations.lock_epoch` in the same transaction.

**Outlets:**
- Add `registration_id UUID NULL` (FK) and drop `outlets.gstin`.
- A trigger enforces `outlet.state_code = registration.state_code` when `registration_id` is set.
- Several outlets may share one registration.

**Resolution rule (shared):**
1. A document's registration is its outlet's `registration_id`.
2. The document's tax mode comes from the profile in force on the tax-point date: `regular → gst`, `composition → composition`.
3. With no registration, the mode is `non_gst`.

## 3. Parties — D34, D6, D7

**`customers` and `suppliers`:**
- Add `gst_treatment TEXT NOT NULL` (enum `GstTreatment`).
- Add **`uin TEXT`**, the Unique Identity Number of UN bodies, embassies and other notified persons. It is kept **separate from `gstin`**:
  - It is validated by `app.uin_valid()` (format only; the exact UIN pattern is §11 open item U1).
  - It never goes through the GSTIN checksum or the state-prefix check.
  - It is never written to `gstin`.
- `suppliers.registration_type` is dropped; its values map to treatments.

*Refines D34:* `uin_holder` parties are identified by `uin`, not `gstin`. GSTR-1
still reports them in the B2B table, using the UIN as the recipient identifier.

| Existing data | `gst_treatment` |
|---|---|
| GSTIN present (customer) | `registered_regular` |
| GSTIN absent (customer) | `consumer` |
| supplier `regular` / `composition` / `unregistered` | `registered_regular` / `registered_composition` / `unregistered` |

**CHECKs:**
- `gst_treatment IN ('registered_regular','registered_composition','sez_unit','sez_developer')` ⇔ `gstin IS NOT NULL`.
- `gst_treatment = 'uin_holder'` ⇔ `uin IS NOT NULL`. A UIN holder also has `gstin IS NULL` and `state_code IS NOT NULL`.
- `gstin IS NULL OR (app.gstin_valid(gstin) AND state_code = left(gstin,2))`. This applies to GSTINs only, never UINs.
- `overseas` ⇒ `state_code IS NULL`, `gstin IS NULL` and `uin IS NULL`.

**Database-side GSTIN enforcement.** `app.gstin_valid(text) RETURNS boolean` is
`IMMUTABLE`, `STRICT` and `PARALLEL SAFE`, created in 0037. It checks:
1. the format `^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$`
2. the state prefix is a code in 01–38, 97 (Other Territory) or 99 (Centre Jurisdiction). This is a static list in the function, matching the rule set's `stateCodes` at creation time.
3. the **mod-36 check digit**: the GSTN algorithm over the 36-character alphabet `0-9A-Z`, with the first 14 characters weighted alternately 1 and 2, and the 15th character equal to the computed check character

The SQL implementation must agree with `src/domain/gst/gstin.ts` on every case in
`contracts/gstin-vectors.json`. An integration test runs the vectors through
the SQL function.

It is applied as named CHECK constraints, always **together with** the matching state-prefix CHECK:

| Column | Constraint | Existing rows |
|---|---|---|
| `gst_registrations.gstin` | `app.gstin_valid(gstin)` + `state_code = left(gstin,2)` | Validated (preflight blocks invalid ones) |
| `customers.gstin`, `suppliers.gstin` | `gstin IS NULL OR (app.gstin_valid(gstin) AND state_code = left(gstin,2))` | Added `NOT VALID`: enforced on every insert and update, existing rows re-validated at their next edit (preflight lists them) |
| `customer_addresses.ship_to_gstin` | as in the table definition | New table, fully validated |
| Document flat `customer_gstin` / `supplier_gstin` on new outward GST documents | `customer_gstin IS NULL OR app.gstin_valid(customer_gstin)`; `supplier_gstin` checked through the registration FK | Added `NOT VALID` so legacy rows are untouched |
| Inward `purchase_bills.supplier_gstin` | `supplier_gstin IS NULL OR app.gstin_valid(supplier_gstin)` | `NOT VALID` |

The old regex-only CHECKs (`tenants`, `customers`, 0018 `gst_return_periods`)
stay as they are; the checksum CHECK is added alongside them. Tenant GSTIN
columns are dropped in 0037 anyway. `uin` is never passed to `app.gstin_valid`.

**New `customer_addresses`** (synced, used for delivery):

```sql
CREATE TABLE customer_addresses (
  id            UUID PRIMARY KEY,
  tenant_id     UUID NOT NULL,
  customer_id   UUID NOT NULL,
  label         TEXT,
  line1         TEXT NOT NULL,
  line2         TEXT,
  city          TEXT NOT NULL,
  country_code  TEXT NOT NULL DEFAULT 'IN' CHECK (country_code ~ '^[A-Z]{2}$'),   -- ISO 3166-1 alpha-2
  state_code    TEXT,                     -- GST state code; domestic only
  postal_code   TEXT,                     -- 6-digit pincode when domestic; free-form abroad
  ship_to_gstin TEXT,                     -- optional, never required (EWB mandate on hold)
  is_default    BOOLEAN NOT NULL,
  ...timestamps, deleted_at, server_seq...,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  -- domestic: state + 6-digit pincode required; overseas: no GST state, no GSTIN
  CONSTRAINT customer_addresses_domestic CHECK (
    country_code <> 'IN'
    OR (state_code IS NOT NULL AND postal_code IS NOT NULL
        AND state_code ~ '^[0-9]{2}$' AND postal_code ~ '^[1-9][0-9]{5}$')),
  -- (a CHECK passes when it evaluates to NULL, so every required column is
  --  tested with IS NOT NULL explicitly; the same pattern is used for the
  --  customers/suppliers country rule and every conditional CHECK in A0b)
  CONSTRAINT customer_addresses_overseas CHECK (
    country_code = 'IN'
    OR (state_code IS NULL AND ship_to_gstin IS NULL AND postal_code IS NOT NULL)),
  CONSTRAINT customer_addresses_ship_to_gstin CHECK (
    ship_to_gstin IS NULL
    OR (app.gstin_valid(ship_to_gstin) AND left(ship_to_gstin, 2) = state_code))
);
```

`customers` and `suppliers` also gain `country_code TEXT NOT NULL DEFAULT 'IN'`
with the same domestic/overseas rule. For `country_code <> 'IN'`, the treatment
must be `overseas`, and `state_code`, `gstin` and `uin` must be NULL. The
snapshot `address.countryCode` (§4.3) is filled from these columns.

The customer row itself remains the **bill-to** address; `city` and `pincode`
already exist on `customers`. For overseas customers, `pincode` holds the foreign postal code.

## 4. Issued documents — D8, D9, D15, D24, D27, D28, D32, D33

**Tables:**
- Applies to `invoices` and `credit_notes`, plus a new `sales_debit_notes` table that mirrors `credit_notes`.
- Applies to `purchase_bills` and `debit_notes` (purchase returns), plus a new `rcm_self_invoices` table.
- Estimates, sales orders, proforma invoices and delivery challans only get `registration_id` and the snapshots. They are not GST documents, apart from the challan's Table 13 count.

### 4.1 Columns added to every GST document header

| Column | Type / enum | Purpose |
|---|---|---|
| `registration_id` | UUID NULL | Issuing (outward) or receiving (inward) registration. NULL is allowed only with `registration_resolution` `non_gst` or `legacy_unresolved` |
| `registration_resolution` | `RegistrationResolution`: `resolved` / `non_gst` / `legacy_unresolved` | Why `registration_id` is or isn't set. A NULL `registration_id` alone never means non-GST |
| `document_type` | `GstDocumentType` (invoices table only: `tax_invoice`, `bill_of_supply`, `invoice_cum_bill_of_supply`) | D9 |
| `supply_scenario` | `SupplyScenario` | D24. `legacy_unclassified` is allowed only on rows that existed before migration 0039. The resolver never returns it and clients can never send it. |
| `pos_provision` | `PosProvision` | Statute that produced the place of supply |
| `pos_override` | JSONB NULL `{ placeOfSupply, reason, by, at }` | Audited override |
| `sez_authorised_operations` | BOOLEAN NULL | Only for `supply_to_sez` |
| `lut_reference` | TEXT NULL | Exports and SEZ supplies under LUT |
| `tax_payable_by` | `TaxPayableBy` | **Replaces `is_reverse_charge`** (D15) |
| `buyer_gst_treatment` | `GstTreatment` | Snapshot for classification |
| `customer_uin` | TEXT NULL | Flat UIN snapshot; set only for `uin_holder` buyers, with `customer_gstin` NULL |
| `seller_snapshot`, `buyer_snapshot`, `ship_to_snapshot`, `dispatch_from_snapshot` | JSONB per §4.3 | D8; printing reads only these |
| `tax_point_date` | DATE NOT NULL | D32 |
| `tax_point_facts` | JSONB (`TaxPointFacts`, §4.4) | Event facts used |
| `tax_point_provision` | `TaxPointProvision` | |
| `tax_point_override` | JSONB NULL `{ provision, date, reason, by, at }` | Restricted role only |
| `rule_set_version` | TEXT NOT NULL | D18 |
| `sales_channel` | `SalesChannel` (outward only) | Table 14(a) |
| `eco_gstin` | TEXT NULL | Required when `sales_channel = 'marketplace'` |
| `irn_state` | `IrnState` (outward only) | D28 |
| `device_seq` | BIGINT NULL | D33 (NULL for server-created documents) |
| `clock_offset_ms_at_last_sync` | INTEGER NULL | D33 |
| `lock_epoch_known` | BIGINT NULL | D33 |
| `number_block_id` | UUID NULL | D33 |
| `issuance_authorisation_id` | UUID NULL | D33, for online back-dating |
| `sync_classification` | `SyncClassification` | D33 |

**Kept as flat columns** because the return queries filter on them:
`customer_gstin`, `supplier_gstin`, `supplier_state_code`,
`place_of_supply_state_code` and `supply_type` (the existing 6 values are kept).
The snapshots duplicate them for printing. A CHECK ties
`supplier_gstin = seller_snapshot->>'gstin'`.

**Lifecycle.**

**Drafts are not stored in GST document tables.** Verified against the schema:
`invoices`, `credit_notes`, `purchase_bills` and `debit_notes` only allow
`issued | void`, and the only `draft` status in the database is on
`purchase_orders`. A draft (an open cart or unsaved form) exists only on the
device and is never synced. A row first appears in a GST document table at
issue, which is also when its number is consumed. So `draft` is not a value of
`status`.

Outward GST documents (invoices, credit notes, sales debit notes) use the
values below. Inward documents keep `status ∈ {issued, void}` with
`irn_state = 'not_required'`.

| `status` | allowed `irn_state` | Meaning |
|---|---|---|
| `issued` | `not_required` | Final at issue (registration not mandated, or document kind out of scope) |
| `issued` | `registered` | IRP returned an IRN; legally final |
| `pending_irn` | `awaiting`, `submitted_unknown`, `rejected`, `confirmed_absent` | Provisional; not a tax invoice (D28) |
| `void` | `not_required` | An issued non-e-invoice document cancelled before reporting (D27) |
| `void` | `cancelled` | Registered document cancelled at the IRP within 24 h |
| `withdrawn` | `rejected`, `confirmed_absent` | **Never issued.** A provisional document abandoned after the IRP rejected it, or after a lookup confirmed no IRN exists. The number is consumed but this is not a cancellation. |

The table is enforced by a single CHECK on `(status, irn_state)` pairs.
Allowed transitions are enforced in `app.guard_document_update` (0034, extended):

| From | To | Who |
|---|---|---|
| `pending_irn/awaiting` | `pending_irn/submitted_unknown` | server |
| `pending_irn/awaiting` | `pending_irn/rejected` | server |
| `pending_irn/awaiting` | `issued/registered` | server |
| `pending_irn/submitted_unknown` | `issued/registered` | server, after lookup |
| `pending_irn/submitted_unknown` | `pending_irn/confirmed_absent` | server, after lookup |
| `pending_irn/rejected` | `pending_irn/awaiting` | server, on resubmit |
| `pending_irn/confirmed_absent` | `pending_irn/awaiting` | server, on resubmit |
| `pending_irn/{rejected, confirmed_absent}` | `withdrawn` | owner action, audited |
| `issued/not_required` | `void/not_required` | D27 rules |
| `issued/registered` | `void/cancelled` | server, on IRP cancel success |

**Constraints:**
- A device may insert only `issued/not_required` or `pending_irn/awaiting`.
- `withdrawn` is reachable only after the IRN outcome is known, never from `submitted_unknown`.
- `void` is reachable only from `issued`.

**Rejected issue attempts (D33)** are kept out of the document tables entirely.
A document refused at sync as `rejected_after_lock_known` was never issued. It
goes to an append-only **`document_issue_rejections`** table:
- columns: tenant, registration, device, series, sequence no, document number, attempted document date, payload JSONB, classification, reason, received_at
- its number is recorded in `gst_document_numbers` with `number_state = 'rejected_before_issue'`
- the device gets an actionable error

The number stays consumed and the attempt is fully audited. Neither rejected
attempts nor `withdrawn` documents are counted as **cancelled** in GSTR-1 Table 13.
They appear in the existing numbering-gap report. How such consumed-but-unissued
numbers sit inside a Table 13 serial range is §11 open item T1.

### 4.2 Credit, debit and correction columns (D27)

Every CN/DN table carries a full reference to the original document: **id + number + date**.

| Table | Original-document id | Number / date |
|---|---|---|
| `credit_notes` | existing `original_invoice_id` (FK `invoices`) | existing `original_document_number` + **new** `original_document_date` |
| `sales_debit_notes` | new `original_invoice_id` (FK `invoices`) | new `original_document_number`, `original_document_date` |
| `debit_notes` (purchase return) | new or confirmed `original_bill_id` (FK `purchase_bills`) | new `original_document_number`, `original_document_date` |

All three are `NOT NULL` for GST CN/DNs, with composite `(tenant_id, …)` FKs.

The outward ones (`credit_notes`, `sales_debit_notes`) also get:
- `correction_reason`: `CorrectionReason`
- `recipient_itc_reversal_status`: `RecipientReversalStatus`

**Financial credit notes** go in a separate table, `financial_credit_notes`. It
has no tax columns, its own series, is never read by the return engine, and its
postings go to accounting only.

### 4.3 Snapshot JSON (frozen shape, TS `PartySnapshot` / Dart `PartySnapshot`)

```json
{ "name": "…", "legalName": "…|null", "gstin": "…|null", "uin": "…|null", "gstTreatment": "registered_regular",
  "address": { "line1": "…", "line2": "…|null", "city": "…|null", "postalCode": "…|null",
               "stateCode": "27|null", "countryCode": "IN" },
  "phone": "…|null", "email": "…|null" }
```

Address fields:
- `countryCode` is ISO 3166-1 alpha-2 and always present: `IN` for domestic parties, the actual country for `overseas` buyers.
- `stateCode` is required when `countryCode = 'IN'` and `null` otherwise.
- The place of supply for exports is still `96`, set by the resolver, not by the address.
- `postalCode` is validated as a 6-digit Indian pincode only for `IN`. It is filled from `customers.pincode` / `outlets.pincode` / `customer_addresses.postal_code`; existing column names are not renamed.

- `seller_snapshot` and `dispatch_from_snapshot` come from the registration and outlet.
- `buyer_snapshot` is the bill-to.
- `ship_to_snapshot` is `null` when the goods go to the bill-to address or are handed over at the counter.

### 4.4 Tax-point facts (`TaxPointFacts`)

```json
{ "invoiceDate": "2026-11-03", "removalDate": "…|null", "deliveryDate": "…|null",
  "paymentDate": "…|null", "invoiceDueDate": "…|null", "serviceCompletionDate": "…|null",
  "supplierInvoiceDate": "…|null", "receiptDate": "…|null", "boeDate": "…|null" }
```

The resolver is a pure function, `resolveTaxPoint(facts, kind, ruleSet) → { date, provision }`.
- `kind ∈ { outward_goods, outward_services, inward_rcm_goods, inward_rcm_services }`.
- Rate-change cases (s.14) are resolved from the rule set's effective dates.

### 4.4a Inward documents: supplier-reported tax point vs recipient ITC dates

Two different questions are answered on an inward document and stored separately:

**(1) Supplier's time of supply — on ordinary forward-charge purchases** (`purchase_bills`, supplier debit/credit notes recorded by us, `tax_payable_by = 'supplier'`):
- **We do not determine it.** The supplier fixed it, and the tax is as charged on the supplier's document.
- Fields:
  - `tax_point_provision = 'supplier_reported'`
  - `tax_point_date = supplier_invoice_date` (the existing column)
  - `tax_point_facts = { "supplierInvoiceDate": … }`
  - `rule_set_version` = the version selected for that date
- The resolver is **not** called. The engine still computes tax from the supplier's lines so the bill reconciles to the supplier's invoice.
- A rate on the bill that isn't valid in the rule set for that date produces a **warning** (`SUPPLIER_RATE_NOT_IN_RULE_SET`), not a block. We record what the supplier charged. Rejecting the bill would lose the ITC trail, and the remedy is with the supplier (credit note) or ITC review (A7).

**(2) Recipient's own time of supply — only where we owe the tax:**

| Inward kind | Who resolves | Provision |
|---|---|---|
| RCM goods / services (`rcm_registered_supplier`, `rcm_unregistered_supplier`) | the D32 resolver, `kind = inward_rcm_goods` / `inward_rcm_services` | `cgst_12_3` / `cgst_13_3` |
| Import of services | the resolver with `inward_rcm_services` | `cgst_13_3` |
| Import of goods | from the Bill of Entry, not the resolver | new provision `customs_boe` |

Facts for these cases: `supplierInvoiceDate`, `receiptDate`, `paymentDate`, plus a new `boeDate`.

**(3) Recipient ITC eligibility dates — never mixed into the tax point:**
- New columns on `purchase_bills` (and on `rcm_self_invoices` where relevant):

  | Column | Type | Meaning |
  |---|---|---|
  | `goods_received_date` | DATE NULL | s.16(2)(b) receipt; the existing `received_at` is kept as the recording timestamp |
  | `receipt_complete` | BOOLEAN NOT NULL DEFAULT true | false while lots or instalments are pending; ITC waits for the last lot (s.16(2)(b) proviso) |
  | `services_received_date` | DATE NULL | |
  | `boe_number` | TEXT NULL | imports |
  | `boe_date` | DATE NULL | imports |
  | `boe_port_code` | TEXT NULL | imports |

- Payment dates are **not** copied onto the bill: they come from `supplier_payment_allocations` (Rule 37, A7).
- The 2B period and IMS state come from the reconciliation tables (A7).
- The ITC engine reads these facts and stores its own dated decisions in `itc_movements` (§10). `tax_point_date` on an inward document is never used to decide ITC timing.

`TaxPointProvision` gains `supplier_reported` and `customs_boe`, and `TaxPointFacts` gains `boeDate`.

### 4.5 Line-level

Each line gets `uqc TEXT` and `tax_payable_by` follows the header. The existing
`supply_category` (taxable / nil_rated / exempt / non_gst) is kept.

## 5. Numbering — D9, B16, D33

**New `document_series.document_type` values:**
- `bill_of_supply`
- `sales_debit_note`
- `financial_credit_note`
- `rcm_self_invoice`
- `rcm_payment_voucher`

The existing `debit_note` keeps its current meaning, a purchase return.
`invoice_cum_bill_of_supply` documents use the **`invoice`** series, because
under Rule 46A it is a tax invoice.

**Changes to `document_series`:**
- Add `registration_id UUID NULL`. It is required for GST families and must equal the outlet's registration.
- Add `series_family` (enum `SeriesFamily`, §7), derived from `document_type`. It decides whether a number goes into the GST number registry (`non_gst` does not) and which Table 13 bucket it falls in. Uniqueness is per registration and FY across all GST families (below).

**Number uniqueness across tables** uses a new registry, written in the same
transaction as the document or the rejected attempt. It is keyed by the
**issuing registration**, not a GSTIN string, so a GSTIN that is re-registered,
corrected or moved can't break the key:

```sql
CREATE TABLE gst_document_numbers (
  tenant_id        UUID    NOT NULL,
  registration_id  UUID    NOT NULL,     -- the registration that issues the number
  fy_start_year    INTEGER NOT NULL,
  series_family    TEXT    NOT NULL CHECK (series_family <> 'non_gst'),
  document_number  TEXT    NOT NULL
                   CHECK (char_length(document_number) BETWEEN 1 AND 16          -- Rules 46(b), 49, 53: ≤ 16 characters
                          AND document_number ~ '^[A-Za-z0-9/-]+$'),             -- only letters, digits, '-' and '/'
  number_state     TEXT    NOT NULL CHECK (number_state IN ('issued','cancelled','withdrawn','rejected_before_issue')),
  document_table   TEXT    NOT NULL,     -- or 'document_issue_rejections'
  document_id      UUID    NOT NULL,
  PRIMARY KEY (registration_id, fy_start_year, document_number),
  UNIQUE (document_table, document_id),
  FOREIGN KEY (tenant_id, registration_id) REFERENCES gst_registrations (tenant_id, id)
);
```

**Uniqueness scope:** a document number is unique per **issuing registration and
financial year, across every GST series family together**. Within one GSTIN and
FY, an invoice, credit note, bill of supply and self-invoice can never share a
number.
- This is deliberately stricter than the minimum of uniqueness within a document type. It keeps every document unambiguous when the IRP, GSTR-1 and a CA cross-reference it.
- Family prefixes from `document_series` make it cost nothing in practice.
- `series_family` is kept for the Table 13 bucket, not for uniqueness.

**Who the issuing registration is:**
- Outward documents (`outward_invoice`, `bill_of_supply`, `credit_note`, `debit_note_outward`, `delivery_challan`, `refund_voucher`, `receipt_voucher`): the seller's registration, from the outlet.
- **RCM self-invoices and RCM payment vouchers** (`rcm_self_invoice`, `payment_voucher`): the recipient's registration, because the recipient issues them under s.31(3)(f)/(g). They are numbered in its own series.
- **Non-GST documents** (`non_gst` family: financial credit notes, estimates, sales orders, proforma invoices, purchase documents, and every document of an unregistered tenant) are **not** in this registry. They keep the existing per-series guarantee (`UNIQUE (tenant_id, series_id, sequence_no)` plus leased-block exclusion) and the same 16-character format limit enforced by `domain/numbering/series.ts`.
- **Supplier documents we record** (purchase bills, supplier debit notes) carry the supplier's number. They are never in this registry, because we don't issue that number.

**16 characters:** the statutory limit is hard-coded (CHECK above, plus `series.ts`).
It is not read from `DOCUMENT_NUMBER_MAX_LENGTH`, which may only be set lower.

**`number_blocks`:**
- Add `lock_epoch_at_lease BIGINT NOT NULL`.
- The server caps `expires_at` at the closure deadline of the leased period (D33 rule 2).

**`devices`:**
- Add `last_synced_device_seq BIGINT` and `last_delivered_lock_epoch JSONB` (`{ registrationId: epoch }`). These are the server-observed watermark (D33).

**New `issuance_authorisations`** (online back-dating):
- Columns: `id`, `tenant_id`, `registration_id`, `series_id`, `device_id`, `document_date`, `expires_at`, `used_by_document_id`, `created_by`, `created_at`.
- Issued only while the period is open.

## 6. GST rule set and HSN master — D18, D19, D26

These are global tables, not tenant data. In the migration they carry
`-- no-tenant-setup: table` with hand-written read-only RLS, per the 0035 lint.

### 6.1 Versions

```sql
CREATE TABLE gst_rule_sets (
  version        TEXT PRIMARY KEY,            -- '<effective_from>.<revision>', e.g. '2026-11-01.2'; or 'legacy'
  effective_from DATE NOT NULL,
  revision       INTEGER NOT NULL CHECK (revision >= 1),
  supersedes     TEXT REFERENCES gst_rule_sets (version),   -- previous revision of the same effective_from
  status         TEXT NOT NULL CHECK (status IN ('draft','published','withdrawn','legacy')),
  content        JSONB NOT NULL,              -- validated against GstRuleSetContent (zod + Dart)
  content_sha256 TEXT NOT NULL,
  published_at   TIMESTAMPTZ, published_by TEXT,
  withdrawn_at   TIMESTAMPTZ, withdrawn_by TEXT, withdrawn_reason TEXT,
  UNIQUE (effective_from, revision),
  CHECK (version = 'legacy' OR version = to_char(effective_from, 'YYYY-MM-DD') || '.' || revision),
  CHECK (supersedes IS NULL OR revision > 1)
);
```

**No stored `effective_to`.** A version group (all revisions sharing one
`effective_from`) is in force from its `effective_from` until the next later
published `effective_from`. Groups therefore can never overlap, and no
end-date can be inconsistent.

**Each version is a complete snapshot, not a delta.** Entries inside `content`
carry their own `effectiveFrom/effectiveTo`, for example the cess history. The
evaluator filters entries by date *within* the selected version.

**Deterministic selection** — `selectRuleSet(date, versions)`, shared TS/Dart, vector-tested:
1. Take the versions with `status = 'published'` and `effective_from <= date`.
2. Keep those with the greatest `effective_from`.
3. Among them, take the greatest `revision`.
4. If none remain, raise `RULE_SET_UNAVAILABLE`. There is no fallback to `legacy` or to a draft.

The result is a single version for every date, independent of fetch order,
publication time or device.

**Corrections to a published rule.**
- A correction is published as **revision N+1** of the same `effective_from`, with `supersedes` pointing to N. Revision N stays `published` and referenceable, and selection simply prefers N+1.
- Withdrawal (`published → withdrawn`) is allowed only:
  - in the same transaction that publishes a replacement revision, so no date loses coverage; or
  - for a version whose `effective_from` is still in the future.
- **Documents are never restamped or recomputed.** A document keeps the version it was evaluated with.
- When a correction is published, the server produces a **correction impact report**: issued documents stamped with a superseded revision whose evaluation differs under the new revision. These go to the compliance inbox and are resolved through the D27 correction matrix.
- On sync, the server compares a document's stamped version with `selectRuleSet(tax_point_date)` as of receipt:
  - same version → accepted
  - same group, older revision → accepted with warning `RULE_SET_REVISION_STALE`, plus an impact check
  - different group, because the device missed a newer `effective_from` → accepted with warning `RULE_SET_GROUP_STALE`, plus an impact check

  In no case is the document silently recomputed. Lease expiry at period closure (D33) bounds how stale a device can get.

**Immutability.** A trigger rejects:
- any UPDATE of `content`, `content_sha256`, `effective_from`, `revision` or `supersedes` once `status` is `published`, `withdrawn` or `legacy`
- DELETE of such rows
- any status change other than `draft → published` and `published → withdrawn`, and only under the conditions above

Documents reference `rule_set_version` by FK.

**The `legacy` row.** Migration 0037 inserts it **before** any document column refers to it:
- `version = 'legacy'`, `status = 'legacy'`, `effective_from = '2017-07-01'`, `revision = 1`.
- Its `content` is a minimal valid document that encodes **no rates or rules**: it is a label, not a rule set.
- It is never a candidate in `selectRuleSet`, and the evaluator refuses to evaluate it.
- A document stamped `legacy` is never re-validated or recomputed.

### 6.2 Content schema — `GstRuleSetContent` (frozen top-level keys)

Every rule entry carries `Ref = { notificationRef: string, verificationStatus: 'primary_verified' | 'secondary_only' }`.
Dated entries also carry `effectiveFrom: IsoDate` and `effectiveTo: IsoDate | null`, where `effectiveTo` is exclusive.

```ts
{
  // Notified slabs. Used only when a line has no HSN/SAC to resolve against.
  allowedRates: { ratePercent: number, effectiveFrom, effectiveTo, ...Ref }[];

  // Effective-dated rate + taxability by HSN/SAC: the authoritative rate model.
  taxRates: {
    id: string;
    scope: {
      kind: 'hsn' | 'sac';
      codePrefixes: string[];          // 2-8 digits; longest matching prefix wins
      excludePrefixes?: string[];      // carve-outs within the scope
    };
    taxability: 'taxable' | 'nil_rated' | 'exempt' | 'non_gst';
    ratePercent: number | null;        // required iff taxability = 'taxable'; null otherwise
    condition: null | {                // e.g. apparel price thresholds
      key: TaxRateConditionKey;        // code-evaluated: unit_value_at_most, unit_value_above; or manual_selection
      value: number | null;            // paise for value conditions
      description: string;
    };
    exemptionBasis: string | null;     // notification entry for nil_rated / exempt
    rcmCategoryCode: string | null;    // supply of this scope is notified under reverse charge (see rcmCategories)
    effectiveFrom, effectiveTo, ...Ref;
  }[];

  cess: {
    allowedUntil: '2026-01-31', ...Ref;            // no new cess after this date (D18)
    // Historical schedule, kept so documents dated before allowedUntil can be
    // validated and re-printed against the rule that applied. Never used to
    // recompute stored amounts.
    history: { scope: { kind: 'hsn'; codePrefixes: string[] },
               adValoremPercent: number | null,
               specificPerUnit: { amountPaise: number; uqc: string } | null,
               compound: 'max' | 'sum' | null,
               effectiveFrom, effectiveTo, ...Ref }[];
  };
  thresholds:              { key: ThresholdKey, value: number, effectiveFrom, effectiveTo, ...Ref }[];
  stateCodes:              { code, name, isUnionTerritoryWithoutLegislature }[];
  uqc:                     { code, description, unitAliases: string[] }[];
  rcmCategories:           { code, description, direction: 'goods' | 'services', recipientMustBe: string, effectiveFrom, effectiveTo, ...Ref }[];
  blockedCredits:          { code, description, section: '17(5)(...)', effectiveFrom, effectiveTo, ...Ref }[];
  einvoiceExclusions:      { category: EinvoiceExemptionCategory, effectiveFrom, effectiveTo, ...Ref }[];
  validationRules:         { id, returnType, check: ValidationCheckKey, enforcement: 'warn' | 'block', effectiveFrom, effectiveTo, ...Ref }[];
  gstr1aAmendableFields:   Record<Gstr1Table, string[]>;
  ewbIntraStateThresholds: { stateCode, value: number, effectiveFrom, effectiveTo, ...Ref }[];
}
```

**Rate resolution** — `ratesFor(hsnOrSac, date, ruleSet)`, shared TS/Dart:
1. Take the `taxRates` entries in force on `date` whose scope kind matches and whose `codePrefixes` match. Drop any entry whose `excludePrefixes` match.
2. Keep only the entries with the **longest** matching prefix.
3. Return all of them as **candidates**. There may be several when conditions differ.

**Validating a line.** Its `(supply_category, rate)` must equal a candidate's `(taxability, ratePercent)`:
- A code-evaluated condition must hold for the line's unit value.
- `manual_selection` lets the user choose between candidates; the choice is audited.

**When no entry matches** (for example the HSN is missing, or the table has no coverage for that code):
- The rate must be in `allowedRates` on that date.
- This raises warning `HSN_RATE_UNMAPPED`.

**Enforcement level.** A mismatch is enforced at the level of validation rule `hsn_rate_mismatch` (`warn` or `block`). It ships as `warn` until A2 has verified coverage.

**Mapping to lines:**
- `taxability` maps one-to-one onto the existing line `supply_category`.
- Zero rating is **not** a taxability value: it comes from the supply type (export / SEZ), as today.

**Other keys:**
- `ThresholdKey`: `einvoice_aato`, `irn_30day_aato`, `hsn_6digit_aato`, `b2cl_invoice_value`, `rule46_unregistered_taxable`, `ewb_interstate_value`, and (added in A1) the time-of-supply day limits `tos_service_invoice_days`, `tos_rcm_goods_days`, `tos_rcm_services_days`.
- `ValidationCheckKey` and `TaxRateConditionKey` values are fixed in code, one function each. The rule set only switches them on, sets parameters and sets enforcement.

### 6.3 HSN/SAC master — descriptive only

```sql
CREATE TABLE hsn_master (
  code           TEXT PRIMARY KEY CHECK (code ~ '^[0-9]{2,8}$'),
  kind           TEXT NOT NULL CHECK (kind IN ('goods','service')),
  description    TEXT NOT NULL,
  parent_code    TEXT,
  source_version TEXT NOT NULL            -- GSTN master release it came from
);
```

- **The duplicate `suggested_rates` field is removed.** The HSN master holds codes and descriptions only, for the picker and for Table 12 descriptions.
- Any rate shown in the picker is computed from `taxRates` via `ratesFor()`, labelled "suggested", and never enforced from the master.

### 6.4 Distribution

- Endpoints:
  - `GET /v1/gst/rule-sets?since=<published_at cursor>` serves published, withdrawn and legacy rows, so devices also learn about withdrawals.
  - `GET /v1/gst/hsn-master?version=` serves the HSN master.
- Neither is part of the tenant sync cursor.
- Devices cache every row and run `selectRuleSet` locally.
- A2 cannot publish a version containing an in-force `allowedRates` or `taxRates` entry that is still `secondary_only` (exit gate).

## 7. Shared enums (TS `src/domain/gst/enums.ts` ↔ Dart `lib/src/gst/enums.dart`)

Wire values are the strings below and identical on both sides.

| Enum | Values |
|---|---|
| `EinvoiceExemptionCategory` | none, bank_nbfc_insurer, gta, passenger_transport, multiplex_admission, government_local_authority |
| `TurnoverSource` | declared, app_computed, portal_verified |
| `RegistrationKind` | normal, casual, isd_reserved, tds_tcs_reserved |
| `TaxpayerScheme` | regular, composition |
| `FilingFrequency` | monthly, qrmp |
| `OfflineBackdatePolicy` | audited_late_sync, strict_close |
| `LockLevel` | gstr1_filed, gstr3b_filed |
| `GstTreatment` | registered_regular, registered_composition, unregistered, consumer, sez_unit, sez_developer, overseas, uin_holder |
| `GstDocumentType` | tax_invoice, bill_of_supply, invoice_cum_bill_of_supply |
| `SeriesFamily` | outward_invoice, bill_of_supply, credit_note, debit_note_outward, delivery_challan, refund_voucher, receipt_voucher, payment_voucher, rcm_self_invoice, non_gst (financial CN, estimates, orders, proforma, purchase docs) |
| `SupplyScenario` | counter_sale, delivered, bill_to_ship_to, goods_without_movement, installation_at_site, export_goods_with_payment, export_goods_under_lut, supply_to_sez, services_general — *reserved:* supply_from_sez, cross_border_services, deemed_export, on_board_conveyance, services_specific — *migration-only:* legacy_unclassified |
| `PosProvision` | igst_10_1_a, igst_10_1_b, igst_10_1_c, igst_10_1_d, igst_11, igst_7_5_b, igst_12_2, override, legacy |
| `EinvoiceReason` | below_threshold, turnover_unknown (added in A0b: no turnover recorded for any year — never reported as below threshold), entity_exempt, sez_unit, not_a_supply_document, composition, document_kind_out_of_scope, b2c_buyer, uin_buyer_out_of_scope, rcm_self_invoice_optional, mandatory |
| `SupplyType` (existing) | intra_state, inter_state, export_with_tax, export_without_tax, sez_with_tax, sez_without_tax |
| `TaxPayableBy` | supplier, recipient |
| `TaxPointProvision` | cgst_12_2, cgst_12_3, cgst_13_2, cgst_13_3, cgst_14, supplier_reported, customs_boe, override, legacy |
| `DocumentStatus` | pending_irn, issued, void, withdrawn (outward GST documents; inward: issued, void) |
| `IrnState` | not_required, awaiting, submitted_unknown, rejected, confirmed_absent, registered, cancelled |
| `NumberState` | issued, cancelled, withdrawn, rejected_before_issue |
| `RegistrationResolution` | resolved, non_gst, legacy_unresolved |
| `SyncClassification` | accepted, late_sync_review, rejected_after_lock_known, quarantined, server_created |
| `SalesChannel` | direct, marketplace |
| `CorrectionReason` | goods_return, value_reduction, excess_tax_charged, post_supply_discount, value_increase, tax_undercharged |
| `RecipientReversalStatus` | verified, pending, unknown, not_applicable |
| `ItcCategory` | domestic_b2b, rcm_registered_supplier, rcm_unregistered_supplier, rcm_import_of_services, import_of_goods, sez_inward, isd |
| `ItcStatutoryStatus` | eligible, pending_conditions, ineligible_17_5, ineligible_16_4, ineligible_pos, exception_review |
| `Match2bStatus` | matched, mismatch, missing, not_applicable |
| `ImsStatus` | accepted, deemed_accepted, pending, rejected, not_applicable |
| `ItcMovementKind` | claim, reverse_permanent, reverse_temporary, reclaim, interest |
| `ItcRule` | none, s17_5, rule_37, rule_37a, rule_38, rule_42, rule_43, s16_4, goods_not_received, other |
| `Gstr3bTable4Line` | a1, a2, a3, a4, a5, b1, b2, d1, d2 |

## 8. Shared domain functions (TS ↔ Dart, vector-tested)

| Function | TS file | Dart file | Vectors (backend `contracts/`) |
|---|---|---|---|
| GSTIN format + mod-36 checksum + prefix | `src/domain/gst/gstin.ts` | `lib/src/gst/gstin.dart` | `gstin-vectors.json` |
| Entity derivations (§1) | `src/domain/gst/entity.ts` | `lib/src/gst/entity.dart` | `entity-vectors.json` |
| Registration/profile resolution (§2) | `src/domain/gst/registration.ts` | `lib/src/gst/registration.dart` | `registration-vectors.json` |
| POS resolver (D24) | `src/domain/gst/place-of-supply.ts` | `lib/src/gst/place_of_supply.dart` | `pos-vectors.json` |
| Time-of-supply resolver (D32) | `src/domain/gst/time-of-supply.ts` | `lib/src/gst/time_of_supply.dart` | `tos-vectors.json` |
| Rule-set schema + evaluator (D18): `selectRuleSet`, `ratesFor`, threshold and validation-rule lookup | `src/domain/gst/rule-set.ts` | `lib/src/gst/rule_set.dart` | `ruleset-vectors.json` (selection incl. revisions/withdrawals, prefix and condition resolution) |
| Rule 46 / HSN-digit checks (D7, D20) | `src/domain/gst/invoice-rules.ts` | `lib/src/gst/invoice_rules.dart` | `invoice-rules-vectors.json` |
| Tax engine (existing; A1 changes) | `src/domain/tax/engine.ts` | `lib/src/tax/engine.dart` | `tax-vectors.json` (regenerated in A1) |

**Count:** eight shared TS ↔ Dart pairs, seven of them new in A0b and one
existing (the tax engine, changed in A1), with eight vector files. Rule 46 and
`hsnRequirement` share the `invoice-rules` pair; `einvoiceApplicability` belongs
to the entity pair.

`packages/khata_domain/lib/khata_domain.dart` gains the seven new pairs in its
mapping table, and the existing drift test covers the seven new vector files.

**Server-only, not ported:**
- the ITC engine (A7)
- the return engine (A5)
- the D33 sync classifier
- the compliance worker

## 9. A0b migration outline (for approval; nothing written yet)

**Step 0 — registration preflight report (read-only, before 0037).**
- A script, `src/db/preflight/gst-registrations.ts`, runs against the target database with `npx tsx`. It reads only and writes a JSON + Markdown report.
- Migration 0037 starts with a guard that **aborts** if any *blocking* category below is non-empty. Nothing is guessed: each blocking case needs a human decision first.

**How each existing document's registration is resolved.** The rule depends on
which side of the transaction BillBanao's tenant is on. The counterparty's GSTIN
never decides it.

| Document | Registration that applies | Resolved from | Never from |
|---|---|---|---|
| Outward (`invoices`, `credit_notes`) | **issuing** registration | the document's `outlet_id`, then that outlet's derived registration (outlet GSTIN, else tenant GSTIN). The document's own `supplier_gstin` snapshot is used only to **cross-check** it | the customer's GSTIN |
| Inward (`purchase_bills`, `debit_notes`, both with `outlet_id NOT NULL`) | **receiving** registration — the tenant's own | the document's `outlet_id`, then that outlet's derived registration | **the bill's `supplier_gstin`**, which is the counterparty's |
| Series / number blocks | the outlet's registration | `document_series.outlet_id` | — |

Ambiguous or inconsistent results are reported and never auto-resolved:

| Category | Blocking? |
|---|---|
| Same GSTIN on more than one tenant | yes |
| Outlet GSTIN whose prefix ≠ outlet `state_code` (or ≠ tenant `state_code` when the outlet has none) | yes |
| GSTIN failing the mod-36 checksum (tenant, outlet, customer, supplier) | yes for tenant/outlet; report-only for parties (they are re-validated at their next edit) |
| Tenant with several outlet GSTINs where some outlets have none (which registration do they belong to?) | yes |
| `is_gst_registered = false` but a GSTIN is present, or the reverse | yes |
| Composition tenant whose outlets carry different GSTINs (whose composition is it?) | yes |
| Outlet that resolves to **no** registration in a tenant that has registrations, where documents (outward or inward) exist for that outlet | yes: the outlet must be assigned to a registration, or explicitly marked non-GST |
| Customers with a GSTIN-shaped value that is really a UIN | report-only (manual reclassification) |
| **Outward** document whose `supplier_gstin` snapshot ≠ the GSTIN of its outlet's resolved registration (the outlet's GSTIN changed after issue) | report-only: if the snapshot GSTIN is one of the same tenant's registrations, the document resolves to it (`resolved`); otherwise `legacy_unresolved` (quarantined, below). The snapshot is never rewritten |
| **Inward** document whose outlet's registration was not in force on its `document_date` (registration effective dates are set from the preflight decisions) | report-only: `legacy_unresolved` (quarantined, below) |
| **Inward** document where the bill's `supplier_gstin` equals one of the tenant's **own** registrations (self-supply or data-entry error) | report-only, flagged; never used to set `registration_id` |
| Duplicate `document_number` within one derived registration + FY across outlets | report-only (existing data; legacy rows are not entered into `gst_document_numbers`) |

The report is applied to TEST only. For DEV, the user runs it and resolves what it finds.

| # | Content | Lint markers |
|---|---|---|
| 0037 | Preflight guard; `gst_rule_sets` + `hsn_master` (global, read-only RLS) with immutability trigger and the **`legacy` row**; `app.gstin_valid()`, `app.uin_valid()`; `gst_registrations` (UNIQUE (tenant_id, id)), `gst_registration_profiles` (half-open exclusion), `gst_period_lock_events`, `entity_turnover_by_fy`. Copy each preflight-approved tenant/outlet GSTIN into a registration plus profile; set `outlets.registration_id` (composite FK); drop the tenant GST columns and `outlets.gstin` | `-- no-tenant-setup: table` (rule sets, HSN); `-- destructive-ok: drop-column` |
| 0038 | `gst_treatment` + `uin` + `country_code` on customers and suppliers (backfilled per §3), drop `suppliers.registration_type`, `customer_addresses` (country-conditional CHECKs, composite customer FK), GSTIN checksum (`app.gstin_valid`, NOT VALID on existing party rows) + UIN + state-prefix CHECKs | `-- destructive-ok: drop-column` |
| 0039 | §4 columns on invoices / credit_notes / purchase_bills / debit_notes (+ lines) with composite FKs and `rule_set_version` FK; §4.4a ITC-fact and Bill-of-Entry columns on `purchase_bills`; document GSTIN checksum CHECKs (NOT VALID); `sales_debit_notes`, `financial_credit_notes`, `rcm_self_invoices`, `document_issue_rejections`; `is_reverse_charge` → `tax_payable_by`; `(status, irn_state)` CHECK + `guard_document_update` transitions; `gst_document_numbers` | `-- destructive-ok: drop-column` |
| 0040 | §5 series types + `series_family` + `registration_id`, `number_blocks.lock_epoch_at_lease`, devices watermark columns, `issuance_authorisations` | — |

**Legacy TEST rows (0039).** Existing documents are **labelled, never reinterpreted or recomputed**:
- `supply_scenario = 'legacy_unclassified'`, `pos_provision = 'legacy'`
- `tax_point_date = document_date`, `tax_point_provision = 'legacy'`, `tax_point_facts = '{"legacyDocumentDate": …}'`
- `rule_set_version = 'legacy'`
- `sync_classification = 'server_created'`
- `irn_state = 'not_required'`; `status` unchanged
- `registration_id` from the preflight mapping: the issuing registration for outward documents and the tenant's receiving registration for inward ones, both via `outlet_id`; `registration_resolution` set as follows:
  - `resolved`: a registration was found.
  - `non_gst`: **only** when the row is provably non-GST. That means its `tax_mode = 'non_gst'`, **and** it has no `supplier_gstin` (outward) or the tenant had no registration on the document date (inward), **and** its outlet resolves to no registration.
  - `legacy_unresolved`: everything else that could not be resolved.
- snapshots built from the existing flat columns only, with no live master-data lookup
- `tax_payable_by` from `is_reverse_charge`

**Quarantine of `legacy_unresolved` documents.** These are potentially GST-relevant and must never be treated as non-GST.
- **Constraint.** `app.guard_document_update` and a CHECK enforce:
  - `(registration_resolution = 'resolved') = (registration_id IS NOT NULL)`
  - `registration_resolution = 'non_gst'` ⇒ `tax_mode = 'non_gst'`
  - `registration_resolution = 'legacy_unresolved'` ⇒ `supply_scenario = 'legacy_unclassified'`. Only migrated rows can hold it; new documents can never be created in this state.
- **Reporting.** The return engine (A5) and ITC engine (A7) do **not** silently skip them.
  - Preparing any return for a registration of that tenant whose period contains a `legacy_unresolved` document is **blocked**, with a list of the documents to resolve.
  - The compliance inbox shows them from the day of migration.
- **Resolution** is an owner action, audited. It sets `registration_id` (→ `resolved`) or, with evidence, `non_gst`. Nothing else may change on the row.
- On TEST, the preflight report lists every row that would be quarantined. The user may resolve them before 0037 instead, by fixing outlet/registration mappings; either route is acceptable, silent NULL is not.

**Stored amounts are not touched:** taxable, CGST, SGST, IGST, cess, totals, tax and HSN summaries. Legacy rows are **not** inserted into `gst_document_numbers`. The return engine treats `legacy_unclassified` documents by their stored `supply_type` and POS.

**Not in A0b:**
- `compliance_jobs`, `e_invoices` and `eway_bills` come in B1, B3 and B4.
- The ITC tables come in A7.

Their keys are frozen in §10 so those milestones don't reshape the A0b tables.

**Running the migrations:**
- Applied to the **TEST** database only, with the command from the project notes. DEV is left for the user.
- Existing TEST rows are labelled as described under "Legacy TEST rows" above.

The sync registry (`src/modules/sync/sync.registry.ts`) adds `gst_registrations`,
`gst_registration_profiles`, `entity_turnover_by_fy`, `customer_addresses` and
`sales_debit_notes`, plus their lines, `financial_credit_notes` and
`rcm_self_invoices`.

### 9a. Expand now, contract later (amendment, 5 Nov 2026 — user decision during A0b)

A0b **adds**. It does not drop the columns §1–§4 retire: `tenants.gstin`, `is_gst_registered`, `is_composition`, `composition_*`, `filing_frequency`, `registration_effective_from`, `outlets.gstin`, `suppliers.registration_type` and `is_reverse_charge`.

**Why.** Installed app versions sync those fields, and about 80 backend and app files read them. Most of those consumers are rewritten anyway in A1 (tax engine and reverse charge) and A3 (parties, place of supply, printing).

**During the transition:**
- **Write path is unchanged.** The tenant and outlet APIs still write the old columns. `AFTER` triggers on `tenants` and `outlets` (`app.sync_tenant_registrations`, `SECURITY DEFINER`) keep `gst_registrations`, `gst_registration_profiles`, `outlets.registration_id` and `document_series.registration_id` in step:
  - a scheme or frequency change closes the profile in force and opens a new one from `current_date`
  - a GSTIN no longer used by the tenant or any outlet gets `effective_to = current_date`
- **Parties.** `BEFORE` triggers derive `gst_treatment` from `gstin` (customers) and from `gstin` + `registration_type` (suppliers) when a caller does not send it. The mapping is two-way for `registration_type`.
- **Documents.** A `BEFORE INSERT` trigger fills, for any of these the caller does not send:
  - `tax_payable_by` ⇄ `is_reverse_charge`, kept equal both ways
  - `registration_id` and `registration_resolution`: from the outlet's registration in force on the document date; a GST-mode document from an outlet without one is rejected
  - `document_type`, from `tax_mode`: `gst` → `tax_invoice`, `composition` → `bill_of_supply`, `non_gst` → NULL
  - `buyer_gst_treatment`, from the customer row

  It rejects the migration-only values (`legacy_unclassified`, the `legacy` provisions and rule-set version, `legacy_unresolved`) on insert.
- **Nullable until their milestone.** `supply_scenario` (A3), the snapshot columns (A3), `tax_point_*` and `rule_set_version` (A1 and A2; no rule set is published before A2) are nullable for new rows during the transition. Their NOT NULL / completeness CHECKs are added by the contract migration.
- **Number registry.** Outward GST documents (`invoices`, `credit_notes`) with a registration are entered into `gst_document_numbers` by an `AFTER INSERT` trigger. Status changes move `number_state`: `void` → `cancelled`, `withdrawn` → `withdrawn`. A duplicate number within one registration and FY now fails the insert (B16). Legacy rows are not entered.

**When the direction flips.** When A3 moves the writes to registrations and parties, the tenant/outlet triggers are replaced by mirrors that **write the old columns from the new tables**, for app versions that still read them. The **contract migration** then drops the old columns, mirrors and transition defaults, once the minimum supported app version no longer reads them. It is listed in the plan after A3.

**Added during A0b, after 0037–0040 were applied to TEST** (applied migrations are checksum-locked, so these are new files):
- `0041_gst_state_guards.sql`: a party's state is filled from its GSTIN prefix when none is sent; the tenant/outlet GSTIN must belong to its state (`gstin_state_prefix`, the §2 trigger); a new registration with no recorded start date is in force from 2017-07-01, not today, so a back-dated bill is not refused; document refusals are named.
- `0042_gst_trigger_branches.sql`: shared trigger functions touch a table-specific column only inside a branch for that table, because PL/pgSQL parses a whole expression before evaluating it.

Named GST constraints that bad input can reach are reported as `VALIDATION_FAILED` (`src/db/tx.ts`), not as internal errors.

**Moved to the milestones that build them** (keys in §10 stay frozen):
- `sales_debit_notes`, `financial_credit_notes` → A4
- `rcm_self_invoices` → A7

`document_issue_rejections` and `issuance_authorisations` stay in A0b (0040); they are small and D33 needs their keys.

**Parties' domestic address rule (clarifying §3).** On `customers` and `suppliers`, the overseas half of the rule is enforced: `country_code <> 'IN'` ⇒ `overseas`, no state, no GSTIN, no UIN. The domestic half is not, because today's walk-in customers legitimately have no pincode. Domestic address completeness is enforced where the law needs it: at issue, by the Rule 46 check (D7), and on `customer_addresses`, which is new and enforced in full. Existing malformed values are covered by `NOT VALID` CHECKs.

**Series families for BillBanao's own voucher types.** `payment_receipt` and `refund_voucher` map to `non_gst` for now. They record payments against invoices and refunds of returns, not s.31(3)(d)/(e) advance receipt and refund vouchers. Open item **V1** (A5): confirm before they are counted in Table 13.

## 10. Keys frozen for later milestones

**`compliance_jobs` (B1):**
- Natural key `(registration_id, document_table, document_id, action, generation)`.
- `action` values: `irn_generate | irn_cancel | irn_lookup | ewb_generate | ewb_update_part_b | ewb_cancel | ewb_extend | gstin_lookup | gstr2b_download | ims_download | gstr1_save | gstr1a_save | iff_save`.
- `generation` increments only when a user explicitly retries after a final failure.
- States: `queued | running | succeeded | failed_retryable | failed_final | needs_reconciliation`.

**`e_invoices` (B3):** unique `(document_table, document_id)`. Stores IRN, ack no/date, signed invoice, signed QR and a reference to the request log.

**`eway_bills` (B4):** keyed by `(document_table, document_id, ewb_no)`. The source document may be an invoice or a delivery challan.

**ITC (A7):**
- `itc_register` becomes one row per inward source line and gains the enums `ItcCategory`, `ItcStatutoryStatus`, `Match2bStatus` and `ImsStatus`.
- New append-only `itc_movements`: `(register_id, period, kind ItcMovementKind, rule ItcRule, table_line Gstr3bTable4Line, cgst, sgst, igst, cess, interest, reason_codes[], evaluator_version, at)`.
- `gst_statement_balances`: `(registration_id, statement 'ecrrs'|'rcm', period, opening, closing, source 'app'|'portal')`.

## 11. Decision statuses and open items

### Choices from revision 1, as ruled by the reviewer (4 Nov 2026)

| # | Choice | Status |
|---|---|---|
| 1 | `invoice_cum_bill_of_supply` shares the tax-invoice series | **Approved** |
| 2 | Existing `supply_type` values kept; "with payment / under LUT" maps onto them | **Approved** |
| 3 | Purchase-return `debit_note` keeps its name; outward is `sales_debit_note` in its own table | **Approved** |
| 4 | Separate `status` and `irn_state` | **Approved, subject to state constraints**: the permitted pairs and transitions are now fixed in §4.1 |
| 5 | Rejected-after-lock documents stored as `void` | **Modified**: kept outside the document tables in `document_issue_rejections`. The number is consumed (`rejected_before_issue`) and the attempt audited. Never counted as cancelled in Table 13. `void` now means only the cancellation of an actually issued document (§4.1) |
| 6 | Composition / filing frequency in effective-dated profiles | **Approved, subject to date-range constraints**: half-open `[from, to)` exclusion and composite FKs (§2) |
| 7 | Rule set and HSN master global, served by version endpoints | **Approved**: published and `legacy` rows are now immutable (§6) |
| 8 | Customer `gstin` / `state_code` remain the bill-to; delivery addresses separate | **Approved, with UIN separated** (§3) |
| 9 | `tenants.state_code` kept as principal-place state | **Approved** |
| 10 | Defaults for existing TEST rows | **Modified**: rows are labelled `legacy_unclassified` under the immutable `legacy` rule set. No counter-sale / delivered inference, no tax recomputation (§9) |

### Open items (do not block A0b; resolved before the milestone that needs them)

- **U1** — Exact UIN format for `app.uin_valid()`, taken from the GSTN UIN structure. Until confirmed: 15 alphanumeric characters, stored uppercase, with no checksum. Needed by A3.
- **T1** — How consumed-but-unissued numbers (`withdrawn`, `rejected_before_issue`) appear inside a GSTR-1 Table 13 serial range (CA confirmation). Needed by A5.
- **P1** — The preflight report's blocking categories may grow after its first run on TEST. Any addition is recorded here before 0037 is applied.
- **V1** — Whether BillBanao's `payment_receipt` / `refund_voucher` documents are s.31(3)(d)/(e) vouchers for Table 13 (mapped `non_gst` until confirmed, §9a). Needed by A5.
- **E1** — Whether supplies to UIN holders fall within e-invoicing (`einvoiceApplicability` rule 6). Default until confirmed: excluded, with reason `uin_buyer_out_of_scope`. Needed by B3.
