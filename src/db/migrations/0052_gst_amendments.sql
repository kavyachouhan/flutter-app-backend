-- 0052: amendments of filed outward documents and the GSTR-1A return (milestone A6, D12, D27).
--
-- Table contract:
--   gst_return_periods.return_type  adds 'gstr1a': the optional amendment return for a period whose
--                     GSTR-1 is filed and whose GSTR-3B is not (Rule 59(1) proviso, 59(4A),
--                     Notification 12/2024-CT).
--   gst_amendments    one amendment of a document (or a B2CS rate row) already reported in a filed
--                     GSTR-1. `original` is copied from the filed return's snapshot, not from
--                     today's books, so it is what the department has. `revised` is the corrected
--                     record. `route` is 'gstr1a' (same period, before its GSTR-3B) or
--                     'later_gstr1' (tables 9A / 9C / 10 of the GSTR-1 for `report_period`,
--                     within s.37(3)). Rows are never deleted; an amendment withdrawn before
--                     its return is filed has status 'withdrawn'. The API refuses changes once the
--                     return that carries it is filed.
--
-- No data is touched.

SET LOCAL search_path = public, extensions;

-- destructive-ok: DROP_CONSTRAINT — replaced on the next statement with 'gstr1a' added
ALTER TABLE gst_return_periods DROP CONSTRAINT gst_return_periods_return_type_check;
ALTER TABLE gst_return_periods ADD CONSTRAINT gst_return_periods_return_type_check
  CHECK (return_type IN ('gstr1', 'gstr3b', 'gstr9', 'gstr1a'));

CREATE TABLE gst_amendments (
  id               UUID        PRIMARY KEY,
  tenant_id        UUID        NOT NULL REFERENCES tenants (id),
  gstin            TEXT        NOT NULL,
  section          TEXT        NOT NULL CHECK (section IN ('b2b', 'b2cl', 'b2cs', 'exp', 'cdnr', 'cdnur')),
  route            TEXT        NOT NULL CHECK (route IN ('gstr1a', 'later_gstr1')),
  original_period  TEXT        NOT NULL CHECK (original_period ~ '^[0-9]{4}-[0-9]{2}$'),
  report_period    TEXT        NOT NULL CHECK (report_period ~ '^[0-9]{4}-[0-9]{2}$'),
  -- The amended document; null for a B2CS (rate-wise) row.
  document_table   TEXT        CHECK (document_table IN ('invoices', 'credit_notes', 'sales_debit_notes')),
  document_id      UUID,
  -- The key the portal amends by: document number, or for B2CS "POS|rate".
  document_key     TEXT        NOT NULL,
  original         JSONB       NOT NULL,
  revised          JSONB       NOT NULL,
  reason           TEXT        NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  status           TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'withdrawn')),
  created_by       UUID        NOT NULL REFERENCES users (id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq       BIGINT      NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  CHECK ((document_table IS NULL) = (document_id IS NULL)),
  CHECK ((section = 'b2cs') = (document_id IS NULL)),
  CHECK (route <> 'gstr1a' OR report_period = original_period),
  CHECK (route <> 'later_gstr1' OR report_period > original_period)
);
-- One active amendment of a document per return it is reported in.
CREATE UNIQUE INDEX gst_amendments_active_uq
  ON gst_amendments (tenant_id, gstin, route, report_period, section, document_key)
  WHERE status = 'active';
CREATE INDEX gst_amendments_report_idx ON gst_amendments (tenant_id, gstin, report_period);
SELECT app.setup_tenant_table('gst_amendments');
SELECT app.restrict_table('gst_amendments', ARRAY['DELETE']);
CREATE TRIGGER gst_amendments_guard BEFORE UPDATE ON gst_amendments FOR EACH ROW
  EXECUTE FUNCTION app.guard_document_update('status', 'updated_at', 'server_seq');

SELECT app.grant_runtime_privileges();
