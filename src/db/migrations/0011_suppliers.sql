-- 0011 — Suppliers, the payables ledger, and item cost.
--
-- Until now the system has only seen one side of the shop's trade. Without
-- the other side there is no real stock cost (the P&L has been costing goods
-- at the item's *current* purchase price, which is wrong the moment a buying
-- price moves), no payables, and no reorder-to-purchase loop.
--
-- Table contracts:
--   suppliers                master, mutable, soft-deleted
--   supplier_ledger_entries  append-only (UPDATE and DELETE revoked)
--   supplier_balances        trigger-maintained projection, never written directly
--   item_costs               moving-average cost, written by the purchase service
--
-- Suppliers get their own tables rather than a shared `parties` table with
-- customers. The two carry different fields (credit limit versus payment
-- terms and lead time), and merging them would mean migrating every
-- customer_id foreign key in invoices, payments and the khata ledger — a
-- destructive change to live sales data to buy a convenience nobody asked
-- for. A party who is both is entered twice, which is the accepted cost.

SET LOCAL search_path = public, extensions;

-- ===========================================================================
-- suppliers
-- ===========================================================================

CREATE TABLE suppliers (
  id                 UUID        PRIMARY KEY,
  tenant_id          UUID        NOT NULL REFERENCES tenants (id),
  name               TEXT        NOT NULL CHECK (length(trim(name)) > 0),
  phone              TEXT        CHECK (phone ~ '^[1-9][0-9]{7,14}$'),
  email              TEXT,
  gstin              TEXT        CHECK (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  -- Place of supply for a purchase: an inter-state buy attracts IGST, which
  -- is reclaimed differently from CGST/SGST.
  state_code         TEXT        CHECK (state_code ~ '^[0-9]{2}$'),
  address_line1      TEXT,
  address_line2      TEXT,
  city               TEXT,
  pincode            TEXT,
  -- Days from bill date to due date; drives the ageing report.
  payment_terms_days INTEGER     CHECK (payment_terms_days BETWEEN 0 AND 365),
  -- Days from order to delivery; drives reorder suggestions later.
  lead_time_days     INTEGER     CHECK (lead_time_days BETWEEN 0 AND 365),
  notes              TEXT,
  is_active          BOOLEAN     NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ,
  server_seq         BIGINT      NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id)
);

CREATE UNIQUE INDEX suppliers_phone_uq ON suppliers (tenant_id, phone)
  WHERE phone IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX suppliers_name_idx ON suppliers (tenant_id, name, id) WHERE deleted_at IS NULL;
CREATE INDEX suppliers_name_trgm_idx ON suppliers USING gin (name gin_trgm_ops);
SELECT app.setup_tenant_table('suppliers');


-- ===========================================================================
-- Supplier ledger (payables)
--
-- The sign convention is the mirror of the customer ledger and the single
-- easiest thing to get backwards here:
--
--   CREDIT increases what the shop owes the supplier (a purchase bill)
--   DEBIT  reduces it (a payment made, a debit note raised)
--
-- `supplier_balances.balance` is therefore credit - debit, and a positive
-- balance means money is owed out. The customer ledger is the opposite way
-- round because a customer owing money is an asset.
-- ===========================================================================

CREATE TABLE supplier_ledger_entries (
  id             UUID        PRIMARY KEY,
  tenant_id      UUID        NOT NULL REFERENCES tenants (id),
  supplier_id    UUID        NOT NULL,
  entry_type     TEXT        NOT NULL CHECK (entry_type IN
                   ('opening_balance', 'purchase', 'purchase_void', 'payment', 'payment_void',
                    'debit_note', 'debit_note_void')),
  debit          BIGINT      NOT NULL CHECK (debit >= 0),
  credit         BIGINT      NOT NULL CHECK (credit >= 0),
  reference_type TEXT,
  reference_id   UUID,
  occurred_at    TIMESTAMPTZ NOT NULL,
  note           TEXT,
  created_by     UUID        REFERENCES users (id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq     BIGINT      NOT NULL DEFAULT 0,
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id),
  CHECK ((debit > 0) <> (credit > 0))
);

CREATE INDEX supplier_ledger_statement_idx
  ON supplier_ledger_entries (tenant_id, supplier_id, occurred_at, id);
SELECT app.setup_tenant_table('supplier_ledger_entries');
SELECT app.restrict_table('supplier_ledger_entries', ARRAY['UPDATE', 'DELETE']);


CREATE TABLE supplier_balances (
  tenant_id   UUID        NOT NULL REFERENCES tenants (id),
  supplier_id UUID        NOT NULL,
  -- Positive means the shop owes the supplier.
  balance     BIGINT      NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq  BIGINT      NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, supplier_id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id)
);

SELECT app.setup_tenant_table('supplier_balances');

CREATE FUNCTION app.apply_supplier_ledger_entry() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO supplier_balances AS b (tenant_id, supplier_id, balance)
  VALUES (NEW.tenant_id, NEW.supplier_id, NEW.credit - NEW.debit)
  ON CONFLICT (tenant_id, supplier_id) DO UPDATE SET balance = b.balance + EXCLUDED.balance;
  RETURN NEW;
END $$;

CREATE TRIGGER supplier_ledger_apply AFTER INSERT ON supplier_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION app.apply_supplier_ledger_entry();


-- ===========================================================================
-- item_costs — moving weighted average
--
-- Not a trigger on stock_ledger_entries, deliberately. The weighted average
-- needs the landed rate of the goods arriving, and a stock entry carries
-- only a quantity. The purchase service holds this row FOR UPDATE and
-- computes the new average with the rate in hand.
-- ===========================================================================

CREATE TABLE item_costs (
  tenant_id          UUID        NOT NULL REFERENCES tenants (id),
  outlet_id          UUID        NOT NULL,
  item_id            UUID        NOT NULL,
  -- Paise per whole unit.
  avg_cost           BIGINT      NOT NULL DEFAULT 0 CHECK (avg_cost >= 0),
  -- Thousandths. Mirrors stock_balances but is maintained alongside the
  -- average so the two move in one statement and cannot disagree.
  quantity_on_hand   BIGINT      NOT NULL DEFAULT 0,
  last_purchase_cost BIGINT      CHECK (last_purchase_cost >= 0),
  last_purchase_at   TIMESTAMPTZ,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq         BIGINT      NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, outlet_id, item_id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items (tenant_id, id)
);

SELECT app.setup_tenant_table('item_costs');

SELECT app.grant_runtime_privileges();
