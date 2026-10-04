-- 0016 — Price lists, bulk price revision, and discount caps.
--
-- A shop that sells at both retail and wholesale has, until now, had one
-- selling price per item and a cashier free to discount it to anything. Those
-- are the same problem seen twice: the shop knows what a given customer should
-- pay and the system has nowhere to put that knowledge, so it leaks into the
-- cashier's judgement at the till.
--
-- Table contracts:
--   price_lists           master, mutable, soft-deleted
--   price_list_items      per-(list, item) prices, composite key, no surrogate id
--   discount_policies     scoped config, NULL means inherit
--   discount_approvals    append-only (UPDATE and DELETE revoked)
--   price_revisions       resumable job header
--   price_revision_rows   per-row preview and apply cursor
--
-- Two decisions worth stating.
--
-- **Prices are not effective-dated per row.** A price list carries
-- effective_from / effective_to and is swapped as a whole; individual item
-- prices are not versioned. Issued invoices are immutable and snapshot the
-- price they charged, so history is already answerable from the documents.
-- Versioning every row as well would double the write volume on a bulk
-- revision for a question the invoices already answer.
--
-- **A revision is a job, not a statement.** It mirrors import_jobs: the client
-- drives analyse and apply in chunks, each row carries its own applied_at, and
-- a catalogue fingerprint refuses an apply whose preview is stale. A single
-- UPDATE over five thousand items would hold the per-tenant server_seq counter
-- for the whole write and give the shopkeeper no preview of what it will do.

SET LOCAL search_path = public, extensions;

-- ===========================================================================
-- price_lists
-- ===========================================================================

CREATE TABLE price_lists (
  id              UUID        PRIMARY KEY,
  tenant_id       UUID        NOT NULL REFERENCES tenants (id),
  name            TEXT        NOT NULL CHECK (length(trim(name)) > 0),
  -- Retail and wholesale are named rather than left to free text because
  -- reports group by them and a typo would silently split a group in two.
  kind            TEXT        NOT NULL CHECK (kind IN ('retail', 'wholesale', 'distributor', 'custom')),
  -- How a price is derived for an item the list holds no explicit price for.
  -- 'fixed' means only the explicit prices apply and anything else falls
  -- through to the item's own selling price.
  basis           TEXT        NOT NULL CHECK (basis IN ('fixed', 'percent_off_sale', 'percent_on_cost')),
  basis_value     NUMERIC(6, 3) NOT NULL DEFAULT 0 CHECK (basis_value >= 0),
  -- Paise. A cost-plus list with a stale average cost is how a shop sells
  -- below what it paid; the floor is the backstop.
  min_price_floor BIGINT      CHECK (min_price_floor >= 0),
  -- The list a customer with none assigned is priced on. One per tenant.
  is_default      BOOLEAN     NOT NULL DEFAULT false,
  effective_from  DATE,
  effective_to    DATE,
  is_active       BOOLEAN     NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ,
  server_seq      BIGINT      NOT NULL DEFAULT 0,

  UNIQUE (tenant_id, id),
  CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from),
  -- A percentage basis without a percentage is a list that prices at cost or
  -- gives everything away, neither of which anyone means.
  CHECK (basis = 'fixed' OR basis_value > 0)
);

CREATE UNIQUE INDEX price_lists_default_uq ON price_lists (tenant_id)
  WHERE is_default AND deleted_at IS NULL;
CREATE UNIQUE INDEX price_lists_name_uq ON price_lists (tenant_id, lower(trim(name)))
  WHERE deleted_at IS NULL;
SELECT app.setup_tenant_table('price_lists');


-- ===========================================================================
-- price_list_items
-- ===========================================================================

-- Shaped on item_costs: a composite primary key and no surrogate id, because
-- a row here is a value for a (list, item, quantity break) and never has an
-- identity of its own that anything else references.
CREATE TABLE price_list_items (
  tenant_id          UUID        NOT NULL REFERENCES tenants (id),
  price_list_id      UUID        NOT NULL,
  item_id            UUID        NOT NULL,
  -- Thousandths. The price applies from this quantity up, so several rows for
  -- one item form a quantity-break ladder. Zero is the base row.
  min_quantity       BIGINT      NOT NULL DEFAULT 0 CHECK (min_quantity >= 0),
  unit_price         BIGINT      NOT NULL CHECK (unit_price >= 0),
  -- Independent of items.prices_include_tax and of invoices.prices_include_tax,
  -- neither of which can answer "is this list price inclusive": a wholesale
  -- list is usually quoted exclusive even in a shop that prices retail
  -- inclusive.
  prices_include_tax BOOLEAN     NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq         BIGINT      NOT NULL DEFAULT 0,

  PRIMARY KEY (tenant_id, price_list_id, item_id, min_quantity),
  FOREIGN KEY (tenant_id, price_list_id) REFERENCES price_lists (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id)       REFERENCES items (tenant_id, id)
);

CREATE INDEX price_list_items_item_idx ON price_list_items (tenant_id, item_id);
SELECT app.setup_tenant_table('price_list_items');

-- Nullable: most customers are on no particular list and take the default.
ALTER TABLE customers ADD COLUMN price_list_id UUID;
ALTER TABLE customers ADD CONSTRAINT customers_price_list_fk
  FOREIGN KEY (tenant_id, price_list_id) REFERENCES price_lists (tenant_id, id);

-- Which list priced each line, and whether the list or the item decided it.
-- Stored rather than re-derived for the same reason cogs_amount is: a margin
-- or discount-audit report must read what was true at the sale, not what the
-- price list says today.
ALTER TABLE invoice_lines ADD COLUMN price_list_id UUID;
ALTER TABLE invoice_lines ADD COLUMN price_source TEXT
  CHECK (price_source IN ('price_list_item', 'price_list_rule', 'item'));

COMMENT ON COLUMN invoice_lines.price_source IS
  'Why the line was priced as it was. NULL on lines billed before price lists existed.';


-- ===========================================================================
-- discount_policies
-- ===========================================================================

-- Scoped exactly like print_profiles: one tenant-wide row (outlet_id IS NULL)
-- that an outlet row inherits from field by field, with NULL meaning inherit.
-- Every limit is nullable because an unset limit means no limit, not zero —
-- a zero max_line_discount_percent is a shop that forbids discounts, which is
-- a different and legitimate setting.
CREATE TABLE discount_policies (
  id                             UUID        PRIMARY KEY,
  tenant_id                      UUID        NOT NULL REFERENCES tenants (id),
  outlet_id                      UUID,
  max_line_discount_percent      NUMERIC(5, 2) CHECK (max_line_discount_percent BETWEEN 0 AND 100),
  max_bill_discount_percent      NUMERIC(5, 2) CHECK (max_bill_discount_percent BETWEEN 0 AND 100),
  -- Paise, on the whole document however the discount was given.
  max_discount_amount            BIGINT      CHECK (max_discount_amount >= 0),
  -- The limit that catches a discount inside every percentage cap that still
  -- loses money.
  min_margin_percent             NUMERIC(5, 2) CHECK (min_margin_percent >= 0),
  -- Above this the till asks for approval rather than refusing. Unset means
  -- the caps are absolute: the owner set a limit and said nothing about an
  -- override.
  require_approval_above_percent NUMERIC(5, 2) CHECK (require_approval_above_percent BETWEEN 0 AND 100),
  -- Which permission an approver must hold. Stored so a shop can decide that
  -- only an owner approves, without a code change.
  approver_permission            TEXT        NOT NULL DEFAULT 'discounts:approve',
  created_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at                     TIMESTAMPTZ,
  server_seq                     BIGINT      NOT NULL DEFAULT 0,

  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets (tenant_id, id)
);

CREATE UNIQUE INDEX discount_policies_scope_uq ON discount_policies (tenant_id, outlet_id)
  NULLS NOT DISTINCT WHERE deleted_at IS NULL;
SELECT app.setup_tenant_table('discount_policies');


-- ===========================================================================
-- discount_approvals
-- ===========================================================================

-- The audit trail the feature exists for. Append-only: an approval is a record
-- that someone authorised something at a moment, and editing it afterwards
-- would make it worthless as evidence.
--
-- invoice_id is nullable because the approval is captured at the till before
-- the bill is saved, and on an offline sale the invoice may upload minutes or
-- days later. The row is written with the invoice when it arrives, or stands
-- alone if the sale was abandoned — which is itself worth seeing.
CREATE TABLE discount_approvals (
  id                 UUID        PRIMARY KEY,
  tenant_id          UUID        NOT NULL REFERENCES tenants (id),
  outlet_id          UUID        NOT NULL,
  invoice_id         UUID,
  -- The invoice line it was given on, or NULL for a bill-level discount.
  invoice_line_id    UUID,
  -- What the policy objected to, mirroring CapBreach.kind in the pure domain.
  breach_kind        TEXT        NOT NULL CHECK (breach_kind IN
                       ('line_discount_percent', 'bill_discount_percent',
                        'discount_amount', 'min_margin')),
  -- Percent for the percentage caps, paise for the amount and margin ones.
  requested_value    NUMERIC(14, 2) NOT NULL,
  allowed_value      NUMERIC(14, 2) NOT NULL,
  requested_by       UUID        NOT NULL REFERENCES users (id),
  approved_by        UUID        NOT NULL REFERENCES users (id),
  -- The role the approver held at the time. The membership may change later,
  -- and the question "was this person entitled to approve it then" has to stay
  -- answerable.
  approver_role      TEXT        NOT NULL,
  reason             TEXT,
  approved_at        TIMESTAMPTZ NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq         BIGINT      NOT NULL DEFAULT 0,

  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id)  REFERENCES outlets (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id)
);

CREATE INDEX discount_approvals_invoice_idx ON discount_approvals (tenant_id, invoice_id)
  WHERE invoice_id IS NOT NULL;
CREATE INDEX discount_approvals_time_idx
  ON discount_approvals (tenant_id, approved_at DESC, id DESC);
CREATE INDEX discount_approvals_approver_idx ON discount_approvals (tenant_id, approved_by);
SELECT app.setup_tenant_table('discount_approvals');
SELECT app.restrict_table('discount_approvals', ARRAY['UPDATE', 'DELETE']);


-- ===========================================================================
-- price_revisions
-- ===========================================================================

CREATE TABLE price_revisions (
  id                    UUID        PRIMARY KEY,
  tenant_id             UUID        NOT NULL REFERENCES tenants (id),
  -- What is being repriced: the catalogue's own sale_price, or one list.
  target                TEXT        NOT NULL CHECK (target IN ('item_sale_price', 'price_list')),
  price_list_id         UUID,
  -- Narrowing. Both NULL means the whole catalogue.
  category_id           UUID,
  supplier_id           UUID,
  -- How each price moves. 'set_from_cost' recomputes from moving-average cost,
  -- which is the revision a shop runs after its buying prices have moved.
  operation             TEXT        NOT NULL CHECK (operation IN
                          ('percent_increase', 'percent_decrease', 'amount_increase',
                           'amount_decrease', 'set_from_cost')),
  operation_value       NUMERIC(14, 3) NOT NULL CHECK (operation_value >= 0),
  -- Round each new price to the nearest multiple of this many paise, so a
  -- 7% rise does not leave the shelf at ₹10.73.
  round_to_paise        BIGINT      CHECK (round_to_paise > 0),
  effective_from        DATE,

  status                TEXT        NOT NULL CHECK (status IN
                          ('pending', 'analysing', 'analysed', 'applying',
                           'applied', 'failed', 'cancelled')),
  total_rows            INTEGER     NOT NULL DEFAULT 0,
  analysed_up_to_row    INTEGER     NOT NULL DEFAULT 0,
  applied_up_to_row     INTEGER     NOT NULL DEFAULT 0,
  change_count          INTEGER     NOT NULL DEFAULT 0,
  skip_count            INTEGER     NOT NULL DEFAULT 0,
  error_count           INTEGER     NOT NULL DEFAULT 0,
  -- Refuses an apply whose preview no longer describes the catalogue, the same
  -- guard import_jobs uses. Without it a revision previewed this morning
  -- silently reprices items added since.
  catalogue_fingerprint TEXT,
  error_summary         JSONB,

  created_by            UUID        NOT NULL REFERENCES users (id),
  analysed_at           TIMESTAMPTZ,
  applied_at            TIMESTAMPTZ,
  last_progress_at      TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq            BIGINT      NOT NULL DEFAULT 0,

  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, price_list_id) REFERENCES price_lists (tenant_id, id),
  FOREIGN KEY (tenant_id, category_id)   REFERENCES categories (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id)   REFERENCES suppliers (tenant_id, id),
  CHECK (applied_up_to_row <= analysed_up_to_row),
  CHECK (target = 'item_sale_price' OR price_list_id IS NOT NULL),
  -- Setting a price from cost takes no percentage or amount.
  CHECK (operation <> 'set_from_cost' OR operation_value >= 0)
);

CREATE INDEX price_revisions_recent_idx ON price_revisions (tenant_id, created_at DESC, id DESC);
CREATE INDEX price_revisions_unfinished_idx ON price_revisions (tenant_id, last_progress_at)
  WHERE status IN ('analysing', 'analysed', 'applying');
SELECT app.setup_tenant_table('price_revisions');


-- ===========================================================================
-- price_revision_rows
-- ===========================================================================

CREATE TABLE price_revision_rows (
  id                 UUID        PRIMARY KEY,
  tenant_id          UUID        NOT NULL REFERENCES tenants (id),
  revision_id        UUID        NOT NULL,
  -- 1-based and stable, so analyse and apply can both work in chunks against
  -- a cursor rather than re-reading the whole set.
  row_no             INTEGER     NOT NULL CHECK (row_no > 0),
  item_id            UUID        NOT NULL,
  min_quantity       BIGINT      NOT NULL DEFAULT 0,
  action             TEXT        NOT NULL CHECK (action IN ('pending', 'change', 'skip', 'error')),
  old_price          BIGINT,
  new_price          BIGINT      CHECK (new_price IS NULL OR new_price >= 0),
  -- Why a row is skipped or in error: no cost known for a cost-plus revision,
  -- a new price that would fall below the list floor, an unchanged price.
  reason             TEXT,
  -- Per row, so a resumed apply writes each one exactly once even if a chunk
  -- committed just before the client gave up waiting.
  applied_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq         BIGINT      NOT NULL DEFAULT 0,

  UNIQUE (tenant_id, revision_id, row_no),
  FOREIGN KEY (tenant_id, revision_id) REFERENCES price_revisions (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id)     REFERENCES items (tenant_id, id),
  CHECK (action <> 'change' OR new_price IS NOT NULL),
  CHECK (applied_at IS NULL OR action = 'change')
);

CREATE INDEX price_revision_rows_action_idx
  ON price_revision_rows (tenant_id, revision_id, action, row_no);
CREATE INDEX price_revision_rows_pending_apply_idx
  ON price_revision_rows (tenant_id, revision_id, row_no)
  WHERE applied_at IS NULL AND action = 'change';
-- One row per item per break within a revision: two rows claiming the same
-- price would apply in an order nobody chose.
CREATE UNIQUE INDEX price_revision_rows_target_uq
  ON price_revision_rows (tenant_id, revision_id, item_id, min_quantity);
SELECT app.setup_tenant_table('price_revision_rows');

SELECT app.grant_runtime_privileges();
