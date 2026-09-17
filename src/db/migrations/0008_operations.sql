-- 0008 — Counter operations: parked bills, expenses and the day's cash-up.
--
-- Table contracts:
--   held_bills          mutable per-device draft (soft delete)
--   expense_categories  mutable master (soft delete)
--   expenses            immutable document (guard + DELETE revoked)
--   day_closes          immutable document (guard + DELETE revoked)

SET LOCAL search_path = public, extensions;

-- ===========================================================================
-- held_bills
--
-- A parked bill is not a document: nothing is issued, no number is consumed,
-- no stock moves. The server stores the device's draft verbatim in `payload`
-- and never computes it — the moment it did, two implementations of the bill
-- would exist and they would disagree. The summary columns beside it exist so
-- the "held bills" list renders without parsing every draft.
-- ===========================================================================

CREATE TABLE held_bills (
  id              UUID        PRIMARY KEY,
  tenant_id       UUID        NOT NULL REFERENCES tenants (id),
  outlet_id       UUID        NOT NULL,
  counter_id      UUID,
  -- The device that parked it. Any device at the counter may resume it, which
  -- is the point: a cashier going home should not strand a customer's bill.
  device_id       UUID        NOT NULL,
  label           TEXT,
  customer_id     UUID,
  customer_name   TEXT,
  line_count      INTEGER     NOT NULL CHECK (line_count >= 0),
  -- Paise, as the device computed it. Display only.
  estimated_total BIGINT      NOT NULL,
  payload         JSONB       NOT NULL,
  status          TEXT        NOT NULL CHECK (status IN ('held', 'released', 'discarded')),
  -- The invoice it became, when it was billed.
  invoice_id      UUID,
  held_at         TIMESTAMPTZ NOT NULL,
  held_by         UUID        NOT NULL REFERENCES users (id),
  released_at     TIMESTAMPTZ,
  released_by     UUID        REFERENCES users (id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ,
  server_seq      BIGINT      NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets (tenant_id, id),
  FOREIGN KEY (tenant_id, counter_id) REFERENCES counters (tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id),
  CHECK ((status = 'held') = (released_at IS NULL)),
  CHECK (invoice_id IS NULL OR status = 'released')
);

CREATE INDEX held_bills_open_idx ON held_bills (tenant_id, outlet_id, counter_id, held_at DESC)
  WHERE status = 'held' AND deleted_at IS NULL;
SELECT app.setup_tenant_table('held_bills');


-- ===========================================================================
-- Expenses
-- ===========================================================================

CREATE TABLE expense_categories (
  id         UUID        PRIMARY KEY,
  tenant_id  UUID        NOT NULL REFERENCES tenants (id),
  name       TEXT        NOT NULL CHECK (length(trim(name)) > 0),
  -- Direct costs belong above the gross-margin line in the daily P&L;
  -- everything else sits below it.
  is_direct  BOOLEAN     NOT NULL DEFAULT false,
  is_active  BOOLEAN     NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  server_seq BIGINT      NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id)
);

CREATE UNIQUE INDEX expense_categories_name_uq
  ON expense_categories (tenant_id, lower(name)) WHERE deleted_at IS NULL;
SELECT app.setup_tenant_table('expense_categories');


CREATE TABLE expenses (
  id                 UUID        PRIMARY KEY,
  tenant_id          UUID        NOT NULL REFERENCES tenants (id),
  outlet_id          UUID        NOT NULL,
  category_id        UUID,
  -- Paise. Positive; a correction is a void, not a negative expense.
  amount             BIGINT      NOT NULL CHECK (amount > 0),
  -- Which drawer or account the money left. Cash expenses reduce the till and
  -- therefore the day-close expectation.
  mode               TEXT        NOT NULL CHECK (mode IN ('cash', 'card', 'upi', 'wallet', 'bank_transfer', 'cheque')),
  vendor_name        TEXT,
  reference          TEXT,
  note               TEXT,
  -- Object key in the tenant's storage bucket, not a URL: URLs expire.
  receipt_object_key TEXT,
  spent_at           TIMESTAMPTZ NOT NULL,
  spent_by           UUID        NOT NULL REFERENCES users (id),
  status             TEXT        NOT NULL CHECK (status IN ('issued', 'void')),
  void_reason        TEXT,
  voided_at          TIMESTAMPTZ,
  voided_by          UUID        REFERENCES users (id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq         BIGINT      NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets (tenant_id, id),
  FOREIGN KEY (tenant_id, category_id) REFERENCES expense_categories (tenant_id, id),
  CHECK ((status = 'void') = (voided_at IS NOT NULL))
);

-- Expense summary and daily P&L both scan by outlet and time.
CREATE INDEX expenses_outlet_time_idx ON expenses (tenant_id, outlet_id, spent_at DESC);
CREATE INDEX expenses_category_idx ON expenses (tenant_id, category_id, spent_at);
SELECT app.setup_tenant_table('expenses');

CREATE TRIGGER expenses_guard BEFORE UPDATE ON expenses FOR EACH ROW
  EXECUTE FUNCTION app.guard_document_update(
    'status', 'void_reason', 'voided_at', 'voided_by', 'updated_at', 'server_seq');
SELECT app.restrict_table('expenses', ARRAY['DELETE']);


-- ===========================================================================
-- day_closes
--
-- The expected figures are stored, not recomputed on read. A day closed on
-- Tuesday must still show what the cashier was asked to count on Tuesday,
-- even after Wednesday's void of a Tuesday invoice changes the arithmetic.
-- Recomputing would rewrite history and turn a clean cash-up into a variance
-- nobody can explain.
-- ===========================================================================

CREATE TABLE day_closes (
  id                UUID        PRIMARY KEY,
  tenant_id         UUID        NOT NULL REFERENCES tenants (id),
  outlet_id         UUID        NOT NULL,
  -- NULL closes the whole outlet; set for per-counter cash-up.
  counter_id        UUID,
  business_date     DATE        NOT NULL,
  -- The window this close accounts for: the previous close's end, or the
  -- first transaction of the day when there is no previous close.
  opened_at         TIMESTAMPTZ NOT NULL,
  closed_at         TIMESTAMPTZ NOT NULL,
  -- Paise.
  opening_float     BIGINT      NOT NULL CHECK (opening_float >= 0),
  expected_cash     BIGINT      NOT NULL,
  counted_cash      BIGINT      NOT NULL CHECK (counted_cash >= 0),
  -- counted - expected: negative is short, positive is over.
  cash_variance     BIGINT      NOT NULL,
  -- Non-cash modes, {mode: {expected, counted}}; nothing to count for most of
  -- them, but a card terminal settlement can be reconciled here.
  tender_breakdown  JSONB       NOT NULL,
  -- The figures behind expected_cash, kept for the printed cash-up slip.
  sales_total       BIGINT      NOT NULL,
  cash_sales        BIGINT      NOT NULL,
  cash_receipts     BIGINT      NOT NULL,
  cash_refunds      BIGINT      NOT NULL,
  cash_expenses     BIGINT      NOT NULL,
  invoice_count     INTEGER     NOT NULL,
  -- Carried into the next day as its opening float.
  closing_float     BIGINT      NOT NULL CHECK (closing_float >= 0),
  note              TEXT,
  closed_by         UUID        NOT NULL REFERENCES users (id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq        BIGINT      NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets (tenant_id, id),
  FOREIGN KEY (tenant_id, counter_id) REFERENCES counters (tenant_id, id),
  CHECK (closed_at >= opened_at),
  CHECK (cash_variance = counted_cash - expected_cash)
);

-- One close per scope per business day. NULLS NOT DISTINCT so an outlet-wide
-- close (counter_id IS NULL) collides with itself rather than duplicating.
CREATE UNIQUE INDEX day_closes_scope_uq
  ON day_closes (tenant_id, outlet_id, counter_id, business_date) NULLS NOT DISTINCT;
CREATE INDEX day_closes_recent_idx ON day_closes (tenant_id, outlet_id, closed_at DESC);
SELECT app.setup_tenant_table('day_closes');

CREATE TRIGGER day_closes_guard BEFORE UPDATE ON day_closes FOR EACH ROW
  EXECUTE FUNCTION app.guard_document_update('note', 'updated_at', 'server_seq');
SELECT app.restrict_table('day_closes', ARRAY['DELETE']);

SELECT app.grant_runtime_privileges();
