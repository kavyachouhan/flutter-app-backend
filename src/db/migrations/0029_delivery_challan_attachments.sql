-- 0029 — Pictures and files on a delivery challan.
--
-- Same shape as the other documents (see 0028): a JSON array of
--   { objectKey, kind: 'image'|'document', name, contentType?, sizeBytes?, encoding? }
-- referencing the private bucket. A challan is editable while it is open, so
-- its list can be replaced; the note it already carries stays in `notes`.

SET LOCAL search_path = public, extensions;

ALTER TABLE delivery_challans
  ADD COLUMN attachments JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(attachments) = 'array' AND jsonb_array_length(attachments) <= 10);

SELECT app.grant_runtime_privileges();
