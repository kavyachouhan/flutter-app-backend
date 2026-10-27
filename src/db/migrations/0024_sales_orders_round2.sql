-- 0024 — Sales orders, round 2.
--
--   * plan gating: existing Standard subscriptions get the new `sales_orders` grant
--   * stock reservation: a `reserved` projection on stock_balances
--   * advance refunds: a refund payment may belong to a sales order
--   * invoice amendment: an invoice may replace one that was fully credited
--   * bill-level discount reason, and discount approvals for orders
--   * parity with invoices: custom fields, reverse charge, additional charges
--
-- Grants are copied from plans.ts into subscriptions.features at onboarding and
-- never re-read, so a new feature key does not reach existing Standard shops
-- unless it is written here. Trial and Pro hold '*' and pick it up on their own.

SET LOCAL search_path = public, extensions;

-- ===========================================================================
-- Plan gating
-- ===========================================================================

UPDATE subscriptions
   SET features = features || '{"sales_orders": true}'::jsonb
 WHERE plan = 'standard'
   AND NOT (features ? 'sales_orders');


-- ===========================================================================
-- Stock reservation
-- ===========================================================================

-- Physical on-hand stays in `quantity`, driven by the append-only ledger.
-- `reserved` is what open sales orders still owe their customers. Available is
-- quantity - reserved. It is a projection maintained by the sales-order service
-- (and checkable against the order lines), not a ledger concept: reserving stock
-- moves nothing, so it must never appear in the movement history or the cost.
ALTER TABLE stock_balances
  ADD COLUMN reserved BIGINT NOT NULL DEFAULT 0 CHECK (reserved >= 0);


-- ===========================================================================
-- Advance refunds
-- ===========================================================================

-- 0023 made `sales_order_id` exclusive to advances. A refund of an advance also
-- belongs to its order, so it can be found, voided and reported with it.
ALTER TABLE payments DROP CONSTRAINT payments_order_advance_chk;
ALTER TABLE payments ADD CONSTRAINT payments_order_link_chk CHECK (
  (kind = 'order_advance' AND sales_order_id IS NOT NULL)
  OR (kind <> 'order_advance' AND (sales_order_id IS NULL OR kind = 'refund'))
);

-- Total refunded out of the advance. The advance itself stays recorded as taken.
ALTER TABLE sales_orders
  ADD COLUMN advance_refunded BIGINT NOT NULL DEFAULT 0 CHECK (advance_refunded >= 0),
  ADD CHECK (advance_refunded <= advance_amount);


-- ===========================================================================
-- Invoice amendment
-- ===========================================================================

-- An amendment is a credit note for the whole invoice plus a replacement
-- invoice. The replacement names the invoice it replaces. A given invoice can
-- be replaced once while that replacement stands; voiding the replacement frees
-- it to be amended again.
ALTER TABLE invoices ADD COLUMN amends_invoice_id UUID;
ALTER TABLE invoices ADD CONSTRAINT invoices_amends_fk
  FOREIGN KEY (tenant_id, amends_invoice_id) REFERENCES invoices (tenant_id, id);
CREATE UNIQUE INDEX invoices_amends_uq ON invoices (tenant_id, amends_invoice_id)
  WHERE amends_invoice_id IS NOT NULL AND status = 'issued';


-- ===========================================================================
-- Bill-level discounts
-- ===========================================================================

ALTER TABLE sales_orders ADD COLUMN bill_discount_reason TEXT;
ALTER TABLE invoices ADD COLUMN bill_discount_reason TEXT;

-- An approval can authorise a discount on a sales order as well as an invoice.
ALTER TABLE discount_approvals ADD COLUMN sales_order_id UUID;
ALTER TABLE discount_approvals ADD CONSTRAINT discount_approvals_order_fk
  FOREIGN KEY (tenant_id, sales_order_id) REFERENCES sales_orders (tenant_id, id);
ALTER TABLE discount_approvals ADD CONSTRAINT discount_approvals_one_document
  CHECK (invoice_id IS NULL OR sales_order_id IS NULL);
CREATE INDEX discount_approvals_order_idx ON discount_approvals (tenant_id, sales_order_id)
  WHERE sales_order_id IS NOT NULL;


-- ===========================================================================
-- Parity with invoices
-- ===========================================================================

ALTER TABLE sales_orders
  ADD COLUMN custom_fields      JSONB,
  ADD COLUMN is_reverse_charge  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN additional_charges JSONB   NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN taxable_charges    BIGINT  NOT NULL DEFAULT 0,
  ADD COLUMN non_taxable_charges BIGINT NOT NULL DEFAULT 0;

-- Custom fields can be defined for sales orders. The original CHECK is unnamed,
-- so find it by what it says rather than by a name this file would be guessing.
DO $$
DECLARE
  c TEXT;
BEGIN
  SELECT conname INTO c
    FROM pg_constraint
   WHERE conrelid = 'custom_field_definitions'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%document_types <@%';
  IF c IS NOT NULL THEN
    EXECUTE format('ALTER TABLE custom_field_definitions DROP CONSTRAINT %I', c);
  END IF;
END $$;
ALTER TABLE custom_field_definitions ADD CONSTRAINT custom_field_definitions_document_types_check
  CHECK (cardinality(document_types) > 0
         AND document_types <@ ARRAY['invoice', 'credit_note', 'estimate', 'sales_order']);

SELECT app.grant_runtime_privileges();
