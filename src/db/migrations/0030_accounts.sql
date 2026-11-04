-- 0030 — Cash & Bank: where money physically sits.
--
-- Table contracts:
--   accounts               mutable (rename a bank, deactivate it); DELETE revoked
--   account_transactions   append-only ledger (like stock_ledger_entries); UPDATE and DELETE revoked
--
-- A balance is never stored as a number someone edits — it is the sum of
-- every transaction ever written against an account, the same contract
-- stock_balances already has with stock_ledger_entries. A mistake is
-- reversed with another transaction, never by editing or deleting a past
-- one; that is what makes the ledger trustworthy months later.
--
-- Phase 1 only: these two tables, and the screens to manage them directly
-- (add a bank, add/reduce cash, transfer between accounts, see a cheque
-- list). Nothing in billing, expenses or supplier payments writes to this
-- ledger yet — that is deliberately separate, larger work for later.

SET LOCAL search_path = public, extensions;

CREATE TABLE accounts (
  id                 UUID        PRIMARY KEY,
  tenant_id          UUID        NOT NULL REFERENCES tenants (id),
  type               TEXT        NOT NULL CHECK (type IN ('cash', 'bank')),
  name               TEXT        NOT NULL CHECK (length(trim(name)) > 0),
  bank_name          TEXT,
  account_number     TEXT,
  ifsc               TEXT,
  -- Every tenant has exactly one of these — the built-in drawer every shop
  -- already has, with no "add" step needed. Enforced below by the partial
  -- unique index, not just convention.
  is_default_cash    BOOLEAN     NOT NULL DEFAULT false,
  is_active          BOOLEAN     NOT NULL DEFAULT true,
  created_by         UUID        NOT NULL REFERENCES users (id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq         BIGINT      NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  -- Bank-only fields stay empty on the cash account; nothing to leave blank
  -- by convention, the database refuses the wrong shape outright.
  CHECK (type = 'bank' OR (bank_name IS NULL AND account_number IS NULL AND ifsc IS NULL))
);

CREATE UNIQUE INDEX accounts_one_default_cash ON accounts (tenant_id) WHERE is_default_cash;
SELECT app.setup_tenant_table('accounts');
SELECT app.restrict_table('accounts', ARRAY['DELETE']);


CREATE TABLE account_transactions (
  id                   UUID        PRIMARY KEY,
  tenant_id            UUID        NOT NULL REFERENCES tenants (id),
  account_id           UUID        NOT NULL,
  -- Paise. Positive: money in. Negative: money out.
  amount               BIGINT      NOT NULL CHECK (amount <> 0),
  transaction_type     TEXT        NOT NULL CHECK (transaction_type IN
                          ('opening', 'manual_adjustment', 'transfer_in', 'transfer_out')),
  -- The other side of a transfer — this row's pair lives on that account.
  transfer_account_id  UUID,
  -- Set only when this money moved by cheque. No status column: a bounced
  -- cheque is corrected with a new reversing transaction, the same way a
  -- voided invoice reverses stock — not by editing this row after the fact.
  cheque_number        TEXT,
  cheque_date          DATE,
  note                 TEXT,
  occurred_at          TIMESTAMPTZ NOT NULL,
  created_by           UUID        NOT NULL REFERENCES users (id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq           BIGINT      NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, transfer_account_id) REFERENCES accounts (tenant_id, id),
  CHECK ((cheque_number IS NULL) = (cheque_date IS NULL)),
  CHECK ((transaction_type IN ('transfer_in', 'transfer_out')) = (transfer_account_id IS NOT NULL))
);

CREATE INDEX account_transactions_account_idx
  ON account_transactions (tenant_id, account_id, occurred_at DESC);
-- Powers the Cheques screen: every cheque across every account, newest first.
CREATE INDEX account_transactions_cheques_idx
  ON account_transactions (tenant_id, occurred_at DESC)
  WHERE cheque_number IS NOT NULL;

SELECT app.setup_tenant_table('account_transactions');
SELECT app.restrict_table('account_transactions', ARRAY['UPDATE', 'DELETE']);

SELECT app.grant_runtime_privileges();
