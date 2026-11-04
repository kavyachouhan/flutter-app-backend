-- 0031 — Cash & Bank, Phase 2: real money movement writes to the ledger too.
--
-- Until now the only transactions in account_transactions were the ones a
-- person wrote directly from the Cash & Bank screens (opening balance,
-- adjust cash, transfer). This migration lets a sale, a customer settling
-- their khata, an expense or a supplier payment write here too, so an
-- account's balance actually reflects the business instead of only the
-- money someone remembered to log by hand.
--
-- Each such row names where it came from (source_type/source_id — the id of
-- the specific payment/expense/supplier-payment row, not the invoice itself,
-- since one invoice can have several tenders). That pairing is what makes a
-- void safe to replay: the service checks "does a transaction for this
-- exact source + transaction_type already exist" before writing one,
-- exactly like transactionExists() already does for a client-supplied id,
-- the unique index below enforces it at the database level too. A void
-- never edits or removes the original row — it writes a 'void' row with
-- the opposite sign, same as a stock ledger reversal.

SET LOCAL search_path = public, extensions;

ALTER TABLE account_transactions
  ADD COLUMN source_type TEXT,
  ADD COLUMN source_id   UUID;

ALTER TABLE account_transactions
  ADD CONSTRAINT account_transactions_source_pair_chk
  CHECK ((source_type IS NULL) = (source_id IS NULL));

ALTER TABLE account_transactions
  ADD CONSTRAINT account_transactions_source_type_chk
  CHECK (source_type IS NULL
         OR source_type IN ('invoice_payment', 'receipt', 'expense', 'supplier_payment'));

ALTER TABLE account_transactions
  DROP CONSTRAINT account_transactions_transaction_type_check;

ALTER TABLE account_transactions
  ADD CONSTRAINT account_transactions_transaction_type_check
  CHECK (transaction_type IN (
    'opening', 'manual_adjustment', 'transfer_in', 'transfer_out',
    'sale', 'receipt', 'expense', 'supplier_payment', 'void'
  ));

CREATE UNIQUE INDEX account_transactions_source_uq
  ON account_transactions (tenant_id, source_type, source_id, transaction_type)
  WHERE source_type IS NOT NULL;

SELECT app.grant_runtime_privileges();
