-- 0053: which e-commerce section a marketplace sale falls under (GSTR-1 table 14, 26/2022-CT).
--
-- Table contract:
--   invoices.eco_liability / credit_notes.eco_liability
--     'tcs_s52'  the operator collects tax at source under s.52; the sale is reported as usual in
--                tables 4-10 and the operator-wise total in table 14(a).
--     's9_5'     the operator pays the tax under s.9(5) (services notified in 17/2017-CT(Rate) as
--                amended); the supplier charges no tax, the sale is left out of tables 4-10 and
--                reported in table 14(b), and its value goes to GSTR-3B 3.1.1(ii).
--     Null for a direct sale; required for a marketplace sale (defaults to tcs_s52 there). A credit
--     note follows its invoice.
--
-- Existing marketplace rows (none are written by any API before this, but a direct SQL write could
-- exist) are set to tcs_s52.

SET LOCAL search_path = public, extensions;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['invoices', 'credit_notes'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN eco_liability TEXT CHECK (eco_liability IN (''tcs_s52'', ''s9_5''))', t);
    EXECUTE format('ALTER TABLE %I DISABLE TRIGGER %I', t, t || '_guard');
    EXECUTE format('UPDATE %I SET eco_liability = ''tcs_s52'' WHERE sales_channel = ''marketplace''', t);
    EXECUTE format('ALTER TABLE %I ENABLE TRIGGER %I', t, t || '_guard');
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK ((sales_channel = ''marketplace'') = (eco_liability IS NOT NULL))',
      t, t || '_eco_liability');
  END LOOP;
END
$$;

SELECT app.grant_runtime_privileges();
