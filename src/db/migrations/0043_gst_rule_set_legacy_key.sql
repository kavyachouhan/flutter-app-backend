-- 0043 — Lets real rule sets start on the date the `legacy` label carries.
--
-- The label row is (2017-07-01, revision 1), which is also the true identity of the first real
-- rule set, the start of GST. The label is never selected, so it does not belong in the key that
-- orders real versions.

SET LOCAL search_path = public, extensions;

-- destructive-ok: DROP_CONSTRAINT — replaced by the same uniqueness over real versions, next line
ALTER TABLE gst_rule_sets DROP CONSTRAINT gst_rule_sets_effective_from_revision_key;
CREATE UNIQUE INDEX gst_rule_sets_version_key ON gst_rule_sets (effective_from, revision)
  WHERE status <> 'legacy';

SELECT app.grant_runtime_privileges();
